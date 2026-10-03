import { PublicKey, type Keypair, type TokenBalance, type VersionedTransactionResponse } from '@solana/web3.js';
import type { AppConfig } from '../config';
import {
  DEFAULT_BUYBACK_FEE_RECIPIENTS,
  DEFAULT_FEE_RECIPIENTS,
  DEFAULT_RESERVED_FEE_RECIPIENTS,
  GLOBAL_PDA,
  applyPercentDown,
  associatedTokenAddress,
  buildBuyExactQuoteInV2Instruction,
  buildCloseAccountInstruction,
  buildCreateAtaIdempotentInstruction,
  buildSellV2Instruction,
  decodeGlobal,
  estimateSellProceeds,
  lamportsToSol,
  netOfBuyFees,
  percentToBps,
  solToLamports,
  tokensOutForSolIn,
} from '../pumpfun';
import type { RpcManager } from '../rpc/rpcManager';
import type { CurveReserves, TradeMode } from '../types';
import { errorMessage } from '../utils/async';
import { getLogger } from '../utils/logger';
import { BlockhashCache, TransactionFailedError, TxSender } from './txSender';

export interface TradeTarget {
  mint: PublicKey;
  /** `bonding_curve.creator` (used for the creator vault PDA). */
  creator: PublicKey;
  tokenProgram: PublicKey;
  isMayhemMode: boolean;
  /** Latest known curve reserves (used for slippage protection / paper fills). */
  reserves: CurveReserves;
}

export interface BuyResult {
  signature: string | null;
  /** Total SOL that left the wallet (amount + protocol fees + tx fees + rent). */
  solSpent: number;
  tokenAmount: bigint;
  latencyMs: number;
}

export interface SellResult {
  signature: string | null;
  /** Net SOL received in the wallet (after all fees, plus reclaimed rent). */
  solReceived: number;
  tokenAmountSold: bigint;
  latencyMs: number;
}

export class NothingToSellError extends Error {
  constructor(mint: string) {
    super(`No token balance to sell for ${mint}`);
    this.name = 'NothingToSellError';
  }
}

export interface Trader {
  readonly mode: TradeMode;
  readonly walletAddress: string | null;
  init(): Promise<void>;
  stop(): void;
  /** Last known wallet balance (SOL) – `null` when unknown or in paper mode. */
  cachedBalanceSol(): number | null;
  buy(target: TradeTarget): Promise<BuyResult>;
  sell(target: TradeTarget, tokenAmount: bigint): Promise<SellResult>;
}

type TradingConfig = AppConfig['trading'];

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

/** Expected buy fill on the curve for a given SOL budget. */
export function quoteBuy(cfg: Pick<TradingConfig, 'buyAmountSol' | 'estimatedFeePercent' | 'slippagePercent'>, reserves: CurveReserves) {
  const spend = solToLamports(cfg.buyAmountSol);
  const net = netOfBuyFees(spend, percentToBps(cfg.estimatedFeePercent));
  const expectedTokens = tokensOutForSolIn(reserves, net);
  const minTokensOut = applyPercentDown(expectedTokens, cfg.slippagePercent);
  return { spend, expectedTokens, minTokensOut };
}

/** Expected sell proceeds on the curve. */
export function quoteSell(cfg: Pick<TradingConfig, 'estimatedFeePercent' | 'slippagePercent'>, reserves: CurveReserves, amount: bigint) {
  const expectedLamports = estimateSellProceeds(reserves, amount, cfg.estimatedFeePercent);
  const minSolOutput = applyPercentDown(expectedLamports, cfg.slippagePercent);
  return { expectedLamports, minSolOutput };
}

/**
 * Wallet SOL change in a confirmed transaction (fee payer is always account 0), excluding the
 * rent moved into / out of our token account. Rent is refundable, so counting it would make every
 * fresh position look like an instant loss (≈0.002 SOL on a 0.01 SOL buy) and distort PnL.
 */
export function walletLamportDelta(tx: VersionedTransactionResponse | null, tokenAccount?: PublicKey): bigint | null {
  if (!tx?.meta) return null;
  const { meta } = tx;
  const at = (i: number) => BigInt(meta.postBalances[i] ?? 0) - BigInt(meta.preBalances[i] ?? 0);
  let delta = at(0);
  if (tokenAccount) {
    try {
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses });
      for (let i = 0; i < keys.length; i++) {
        if (keys.get(i)?.equals(tokenAccount)) {
          delta += at(i);
          break;
        }
      }
    } catch {
      // keep the raw wallet delta
    }
  }
  return delta;
}

function tokenDelta(tx: VersionedTransactionResponse | null, owner: string, mint: string): bigint | null {
  if (!tx?.meta?.postTokenBalances) return null;
  const find = (list: TokenBalance[] | null | undefined) =>
    list?.find((b) => b.owner === owner && b.mint === mint)?.uiTokenAmount.amount;
  const post = find(tx.meta.postTokenBalances);
  if (post === undefined) return null;
  const pre = find(tx.meta.preTokenBalances) ?? '0';
  return BigInt(post) - BigInt(pre);
}

/** Executes real on-chain trades through Pump.fun `buy_exact_quote_in_v2` / `sell_v2`. */
export class LiveTrader implements Trader {
  readonly mode: TradeMode = 'live';
  private readonly log = getLogger('trader');
  private readonly blockhashes: BlockhashCache;
  private readonly sender: TxSender;
  private feeRecipients = DEFAULT_FEE_RECIPIENTS;
  private reservedFeeRecipients = DEFAULT_RESERVED_FEE_RECIPIENTS;
  private buybackFeeRecipients = DEFAULT_BUYBACK_FEE_RECIPIENTS;
  private balanceLamports: bigint | null = null;
  private balanceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly rpc: RpcManager,
    private readonly wallet: Keypair,
    private readonly cfg: TradingConfig,
  ) {
    this.blockhashes = new BlockhashCache(rpc);
    this.sender = new TxSender(rpc, wallet, this.blockhashes, {
      computeUnitLimit: cfg.computeUnitLimit,
      priorityFeeMicroLamports: cfg.priorityFeeMicroLamports,
      skipPreflight: cfg.skipPreflight,
      confirmTimeoutMs: cfg.txConfirmTimeoutMs,
    });
  }

  get walletAddress(): string {
    return this.wallet.publicKey.toBase58();
  }

  async init(): Promise<void> {
    this.blockhashes.start();
    await this.loadGlobal();
    await this.refreshBalance();
    this.balanceTimer = setInterval(() => void this.refreshBalance(), 15_000);
    this.balanceTimer.unref();
    this.log.info(
      { wallet: this.walletAddress, balanceSol: this.cachedBalanceSol() },
      'Live trader ready – REAL FUNDS WILL BE USED',
    );
  }

  stop(): void {
    this.blockhashes.stop();
    if (this.balanceTimer) clearInterval(this.balanceTimer);
    this.balanceTimer = null;
  }

  cachedBalanceSol(): number | null {
    return this.balanceLamports === null ? null : lamportsToSol(this.balanceLamports);
  }

  private async refreshBalance(): Promise<void> {
    try {
      const lamports = await this.rpc.call('getBalance', (c) => c.getBalance(this.wallet.publicKey, 'confirmed'));
      this.balanceLamports = BigInt(lamports);
    } catch (error) {
      this.log.warn({ err: errorMessage(error) }, 'Failed to refresh wallet balance');
    }
  }

  /** Reads fee recipients from the on-chain Global account (falls back to documented defaults). */
  private async loadGlobal(): Promise<void> {
    try {
      const info = await this.rpc.call('getAccountInfo', (c) => c.getAccountInfo(GLOBAL_PDA));
      const global = info ? decodeGlobal(info.data) : null;
      if (!global) throw new Error('Global account missing or undecodable');
      if (global.feeRecipients.length) this.feeRecipients = global.feeRecipients;
      if (global.reservedFeeRecipients.length) this.reservedFeeRecipients = global.reservedFeeRecipients;
      if (global.buybackFeeRecipients.length) this.buybackFeeRecipients = global.buybackFeeRecipients;
      this.log.info(
        { feeBps: Number(global.feeBasisPoints), creatorFeeBps: Number(global.creatorFeeBasisPoints) },
        'Loaded Pump.fun global config',
      );
    } catch (error) {
      this.log.warn({ err: errorMessage(error) }, 'Using default fee recipients');
    }
  }

  private recipients(isMayhemMode: boolean) {
    return {
      feeRecipient: pick(isMayhemMode ? this.reservedFeeRecipients : this.feeRecipients),
      buybackFeeRecipient: pick(this.buybackFeeRecipients),
    };
  }

  async buy(t: TradeTarget): Promise<BuyResult> {
    const user = this.wallet.publicKey;
    const { spend, expectedTokens, minTokensOut } = quoteBuy(this.cfg, t.reserves);
    if (expectedTokens <= 0n) throw new Error('Quote returned zero tokens');

    const ixs = [
      buildCreateAtaIdempotentInstruction(user, user, t.mint, t.tokenProgram),
      buildBuyExactQuoteInV2Instruction({
        user,
        mint: t.mint,
        creator: t.creator,
        baseTokenProgram: t.tokenProgram,
        ...this.recipients(t.isMayhemMode),
        spendableQuoteIn: spend,
        minTokensOut: minTokensOut > 0n ? minTokensOut : 1n,
      }),
    ];
    let sent;
    try {
      sent = await this.sender.send(ixs, `buy ${t.mint.toBase58()}`);
    } catch (error) {
      // A "timed out" buy may still have landed – never lose track of tokens we actually own.
      if (error instanceof TransactionFailedError && error.signature && !error.txError) {
        const balance = await this.tokenBalance(t.mint, t.tokenProgram);
        if (balance !== null && balance > 0n) {
          this.log.warn({ signature: error.signature }, 'Buy confirmation timed out but tokens are in the wallet');
          void this.refreshBalance();
          return { signature: error.signature, solSpent: lamportsToSol(spend), tokenAmount: balance, latencyMs: 0 };
        }
      }
      throw error;
    }
    void this.refreshBalance();

    const delta = walletLamportDelta(sent.tx, associatedTokenAddress(user, t.mint, t.tokenProgram));
    let tokens = tokenDelta(sent.tx, user.toBase58(), t.mint.toBase58());
    if (tokens === null || tokens <= 0n) tokens = await this.tokenBalance(t.mint, t.tokenProgram);
    return {
      signature: sent.signature,
      solSpent: delta !== null ? lamportsToSol(-delta) : lamportsToSol(spend),
      tokenAmount: tokens ?? expectedTokens,
      latencyMs: sent.latencyMs,
    };
  }

  async sell(t: TradeTarget, tokenAmount: bigint): Promise<SellResult> {
    const user = this.wallet.publicKey;
    const onChain = await this.tokenBalance(t.mint, t.tokenProgram);
    const amount = onChain ?? tokenAmount;
    if (amount <= 0n) throw new NothingToSellError(t.mint.toBase58());

    const { expectedLamports, minSolOutput } = quoteSell(this.cfg, t.reserves, amount);
    const ixs = [
      buildSellV2Instruction({
        user,
        mint: t.mint,
        creator: t.creator,
        baseTokenProgram: t.tokenProgram,
        ...this.recipients(t.isMayhemMode),
        amount,
        minSolOutput,
      }),
    ];
    // Selling the whole balance leaves an empty account: close it to reclaim its rent.
    if (this.cfg.closeTokenAccountAfterSell && onChain !== null && amount === onChain) {
      ixs.push(buildCloseAccountInstruction(associatedTokenAddress(user, t.mint, t.tokenProgram), user, user, t.tokenProgram));
    }
    let sent;
    try {
      sent = await this.sender.send(ixs, `sell ${t.mint.toBase58()}`);
    } catch (error) {
      // A "timed out" sell may still have landed – don't book it as a loss on the next retry.
      if (error instanceof TransactionFailedError && error.signature && !error.txError) {
        const balance = await this.tokenBalance(t.mint, t.tokenProgram);
        if (balance === 0n) {
          this.log.warn({ signature: error.signature }, 'Sell confirmation timed out but the tokens are gone – assuming it landed');
          void this.refreshBalance();
          return { signature: error.signature, solReceived: lamportsToSol(expectedLamports), tokenAmountSold: amount, latencyMs: 0 };
        }
      }
      throw error;
    }
    void this.refreshBalance();

    const delta = walletLamportDelta(sent.tx, associatedTokenAddress(user, t.mint, t.tokenProgram));
    return {
      signature: sent.signature,
      solReceived: delta !== null ? lamportsToSol(delta) : lamportsToSol(expectedLamports),
      tokenAmountSold: amount,
      latencyMs: sent.latencyMs,
    };
  }

  /** Returns the wallet's token balance, `0n` if the account does not exist, `null` if unknown. */
  private async tokenBalance(mint: PublicKey, tokenProgram: PublicKey): Promise<bigint | null> {
    const ata = associatedTokenAddress(this.wallet.publicKey, mint, tokenProgram);
    try {
      const info = await this.rpc.call('getAccountInfo', (c) => c.getAccountInfo(ata, 'confirmed'));
      if (!info) return 0n;
      // SPL token account layout: mint(32) owner(32) amount(u64) – identical for Token-2022.
      return info.data.length >= 72 ? info.data.readBigUInt64LE(64) : null;
    } catch (error) {
      this.log.debug({ mint: mint.toBase58(), err: errorMessage(error) }, 'Token balance lookup failed');
      return null;
    }
  }
}

/**
 * Paper trading: simulates fills against the real bonding-curve reserves without sending
 * transactions. Perfect for tuning the strategy with zero risk.
 */
export class PaperTrader implements Trader {
  readonly mode: TradeMode = 'paper';
  readonly walletAddress = null;

  constructor(private readonly cfg: TradingConfig) {}

  async init(): Promise<void> {}

  stop(): void {}

  cachedBalanceSol(): null {
    return null;
  }

  /** Network fee of one transaction: 5000 lamports base + priority fee. */
  private txFeeLamports(): bigint {
    return 5_000n + (BigInt(this.cfg.computeUnitLimit) * BigInt(this.cfg.priorityFeeMicroLamports)) / 1_000_000n;
  }

  async buy(t: TradeTarget): Promise<BuyResult> {
    const { spend, expectedTokens } = quoteBuy(this.cfg, t.reserves);
    if (expectedTokens <= 0n) throw new Error('Quote returned zero tokens');
    return {
      signature: null,
      solSpent: lamportsToSol(spend + this.txFeeLamports()),
      tokenAmount: expectedTokens,
      latencyMs: 0,
    };
  }

  async sell(t: TradeTarget, tokenAmount: bigint): Promise<SellResult> {
    if (tokenAmount <= 0n) throw new NothingToSellError(t.mint.toBase58());
    const { expectedLamports } = quoteSell(this.cfg, t.reserves, tokenAmount);
    const net = expectedLamports - this.txFeeLamports();
    return {
      signature: null,
      solReceived: lamportsToSol(net > 0n ? net : 0n),
      tokenAmountSold: tokenAmount,
      latencyMs: 0,
    };
  }
}
