import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DISCRIMINATORS,
  PUMP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  associatedTokenAddress,
} from '../src/pumpfun';
import type { RpcManager } from '../src/rpc/rpcManager';
import { TransactionFailedError, describeTxError } from '../src/trading/txSender';
import { LiveTrader } from '../src/trading/trader';
import { makeDetectedToken, randomKey, testConfig } from './helpers';

const RENT = 2_039_280;
const MAX_TX_SIZE = 1232;

/** Simulates an RPC node that lands every transaction and reports balance changes. */
class FakeChain {
  sent: VersionedTransaction[] = [];
  tokenBalance = 0n;
  failWith: unknown = null;
  constructor(
    private readonly wallet: PublicKey,
    private readonly mint: PublicKey,
  ) {}
  private ata = () => associatedTokenAddress(this.wallet, this.mint, TOKEN_2022_PROGRAM_ID);

  connection = {
    getAccountInfo: async (key: PublicKey) => {
      if (key.equals(this.ata()) && this.tokenBalance > 0n) {
        const data = Buffer.alloc(165);
        data.writeBigUInt64LE(this.tokenBalance, 64);
        return { data };
      }
      return null; // Global missing → documented default fee recipients
    },
    getBalance: async () => 1_000_000_000,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 }),
    getBlockHeight: async () => 10,
    sendRawTransaction: async (raw: Uint8Array) => {
      expect(raw.length).toBeLessThanOrEqual(MAX_TX_SIZE);
      const tx = VersionedTransaction.deserialize(raw);
      this.sent.push(tx);
      return 'sig' + this.sent.length;
    },
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed', err: this.failWith }] }),
    getTransaction: async () => {
      const tx = this.sent[this.sent.length - 1];
      const keys = tx.message.staticAccountKeys;
      const isBuy = Buffer.from(tx.message.compiledInstructions.at(-1)!.data).subarray(0, 8).equals(DISCRIMINATORS.buyExactQuoteInV2);
      const pre = keys.map(() => 10_000_000);
      const post = [...pre];
      const ataIndex = keys.findIndex((k) => k.equals(this.ata()));
      const mint = this.mint.toBase58();
      const owner = this.wallet.toBase58();
      if (isBuy) {
        post[0] -= 10_000_000 + 45_000 + RENT; // spend + fees + rent for the new token account
        pre[ataIndex] = 0;
        post[ataIndex] = RENT;
        this.tokenBalance = 300_000_000_000n;
        return {
          transaction: tx,
          meta: {
            err: null,
            preBalances: pre,
            postBalances: post,
            preTokenBalances: [],
            postTokenBalances: [{ accountIndex: ataIndex, mint, owner, uiTokenAmount: { amount: '300000000000' } }],
            loadedAddresses: { writable: [], readonly: [] },
          },
        };
      }
      // sell + close: proceeds and the rent refund
      post[0] += 15_000_000 - 45_000 + RENT;
      pre[ataIndex] = RENT;
      post[ataIndex] = 0;
      this.tokenBalance = 0n;
      return {
        transaction: tx,
        meta: { err: null, preBalances: pre, postBalances: post, preTokenBalances: [], postTokenBalances: [], loadedAddresses: { writable: [], readonly: [] } },
      };
    },
  };
  rpc(): RpcManager {
    return { call: async (_l: string, fn: (c: unknown) => unknown) => fn(this.connection), connection: this.connection } as unknown as RpcManager;
  }
}

describe('LiveTrader (fake chain)', () => {
  let trader: LiveTrader | null = null;
  afterEach(() => trader?.stop());

  it('sends a valid signed buy and sell and excludes refundable rent from PnL', async () => {
    const wallet = Keypair.generate();
    const token = makeDetectedToken();
    const mint = new PublicKey(token.mint);
    const chain = new FakeChain(wallet.publicKey, mint);
    const cfg = testConfig({ DRY_RUN: 'false', WALLET_PRIVATE_KEY: 'unused', BUY_AMOUNT_SOL: '0.01', TX_CONFIRM_TIMEOUT_MS: '5000' });
    trader = new LiveTrader(chain.rpc(), wallet, cfg.trading);
    await trader.init();
    expect(trader.cachedBalanceSol()).toBe(1);

    const target = { mint, creator: new PublicKey(token.creator), tokenProgram: TOKEN_2022_PROGRAM_ID, isMayhemMode: false, reserves: token.reserves };
    const buy = await trader.buy(target);
    expect(buy.signature).toBe('sig1');
    expect(buy.tokenAmount).toBe(300_000_000_000n);
    expect(buy.solSpent).toBeCloseTo(0.010045, 9); // spend + network fees, NOT the token-account rent

    const buyTx = chain.sent[0];
    expect(buyTx.signatures).toHaveLength(1);
    expect(buyTx.message.staticAccountKeys[0]).toEqual(wallet.publicKey);
    const programs = buyTx.message.compiledInstructions.map((ix) => buyTx.message.staticAccountKeys[ix.programIdIndex].toBase58());
    expect(programs).toEqual([
      'ComputeBudget111111111111111111111111111111',
      'ComputeBudget111111111111111111111111111111',
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      PUMP_PROGRAM_ID.toBase58(),
    ]);
    const buyData = Buffer.from(buyTx.message.compiledInstructions[3].data);
    expect(buyData.readBigUInt64LE(8)).toBe(10_000_000n);

    const sell = await trader.sell(target, buy.tokenAmount);
    expect(sell.tokenAmountSold).toBe(300_000_000_000n);
    expect(sell.solReceived).toBeCloseTo(0.014955, 9); // proceeds − fees, rent refund excluded
    const sellTx = chain.sent[1];
    expect(sellTx.message.compiledInstructions).toHaveLength(4); // 2× compute budget, sell_v2, close account
  });

  it('surfaces on-chain errors with readable Pump.fun messages', async () => {
    const wallet = Keypair.generate();
    const token = makeDetectedToken();
    const chain = new FakeChain(wallet.publicKey, new PublicKey(token.mint));
    chain.failWith = { InstructionError: [3, { Custom: 6002 }] };
    trader = new LiveTrader(chain.rpc(), wallet, testConfig({ DRY_RUN: 'false', WALLET_PRIVATE_KEY: 'x' }).trading);
    await trader.init();
    const target = { mint: new PublicKey(token.mint), creator: randomKey(), tokenProgram: TOKEN_2022_PROGRAM_ID, isMayhemMode: false, reserves: token.reserves };
    const error = await trader.buy(target).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect((error as TransactionFailedError).signature).toBe('sig1');
    expect(String((error as Error).message)).toMatch(/slippage|TooMuchSolRequired|TooLittle/i);
    expect(describeTxError({ InstructionError: [0, { Custom: 6005 }] })).toMatch(/complete/i);
  });
});
