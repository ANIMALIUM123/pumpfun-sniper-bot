import {
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
  type TransactionError,
  type TransactionInstruction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { RpcManager } from '../rpc/rpcManager';
import { errorMessage, sleep, withTimeout } from '../utils/async';
import { getLogger } from '../utils/logger';

/** Human-readable names for the Pump program errors that matter to a trader. */
const PUMP_ERRORS: Record<number, string> = {
  6002: 'TooMuchSolRequired (slippage)',
  6003: 'TooLittleSolReceived (slippage)',
  6005: 'BondingCurveComplete (coin migrated)',
  6020: 'BuyZeroAmount',
  6021: 'NotEnoughTokensToBuy',
  6022: 'SellZeroAmount',
  6023: 'NotEnoughTokensToSell',
  6040: 'BuyNotEnoughSolToCoverRent',
  6041: 'BuyNotEnoughSolToCoverFees',
  6042: 'BuySlippageBelowMinTokensOut (slippage)',
  6057: 'BuybackFeeRecipientNotAuthorized',
};

export class TransactionFailedError extends Error {
  constructor(
    message: string,
    readonly signature: string | null,
    readonly txError?: TransactionError,
  ) {
    super(message);
    this.name = 'TransactionFailedError';
  }
}

export function describeTxError(err: TransactionError): string {
  const json = JSON.stringify(err);
  const match = /"Custom":(\d+)/.exec(json);
  if (match) {
    const code = Number(match[1]);
    return `${PUMP_ERRORS[code] ?? `custom program error ${code}`} – ${json}`;
  }
  return json;
}

/** Keeps a recent blockhash warm so building a transaction never waits on an RPC round-trip. */
export class BlockhashCache {
  private readonly log = getLogger('blockhash');
  private current: { blockhash: string; lastValidBlockHeight: number; fetchedAt: number } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly rpc: RpcManager,
    private readonly refreshMs = 2_000,
    private readonly maxAgeMs = 20_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async get(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    if (this.current && Date.now() - this.current.fetchedAt < this.maxAgeMs) return this.current;
    await this.refresh();
    if (!this.current) throw new Error('Unable to fetch a recent blockhash');
    return this.current;
  }

  private async refresh(): Promise<void> {
    try {
      const bh = await withTimeout(this.rpc.call('getLatestBlockhash', (c) => c.getLatestBlockhash('confirmed')), 3_000, 'blockhash');
      this.current = { ...bh, fetchedAt: Date.now() };
    } catch (error) {
      this.log.warn({ err: errorMessage(error) }, 'Failed to refresh blockhash');
    }
  }
}

export interface TxSenderOptions {
  computeUnitLimit: number;
  priorityFeeMicroLamports: number;
  skipPreflight: boolean;
  confirmTimeoutMs: number;
  /** Re-broadcast interval while waiting for confirmation. */
  rebroadcastMs?: number;
  /** Signature status polling interval. */
  pollMs?: number;
}

export interface SentTransaction {
  signature: string;
  latencyMs: number;
  /** Full transaction (with meta) when it could be fetched after confirmation. */
  tx: VersionedTransactionResponse | null;
}

/**
 * Builds, signs, sends and confirms v0 transactions with a compute-budget prefix.
 * Confirmation uses signature-status polling + periodic re-broadcast, which is far more
 * reliable on free RPC tiers than relying on websocket confirmations.
 */
export class TxSender {
  private readonly log = getLogger('tx');

  constructor(
    private readonly rpc: RpcManager,
    private readonly payer: Keypair,
    private readonly blockhashes: BlockhashCache,
    private readonly opts: TxSenderOptions,
  ) {}

  async send(instructions: TransactionInstruction[], label: string, beforeSend?: (signature: string) => void): Promise<SentTransaction> {
    const started = Date.now();
    const { blockhash, lastValidBlockHeight } = await this.blockhashes.get();
    const message = new TransactionMessage({
      payerKey: this.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: this.opts.computeUnitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.opts.priorityFeeMicroLamports }),
        ...instructions,
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([this.payer]);
    const raw = tx.serialize();
    const signedSignature = bs58.encode(tx.signatures[0]);
    beforeSend?.(signedSignature);

    let signature: string;
    try {
      signature = await withTimeout(this.rpc.call('sendTransaction', (c) =>
        c.sendRawTransaction(raw, { skipPreflight: this.opts.skipPreflight, maxRetries: 0, preflightCommitment: 'processed' }),
      ), 3_000, 'send transaction');
    } catch (error) {
      throw new TransactionFailedError(`${label}: send outcome unknown – ${errorMessage(error)}`, signedSignature);
    }
    this.log.info({ label, signature }, 'Transaction sent');

    await this.confirm(signature, raw, lastValidBlockHeight, label);
    const latencyMs = Date.now() - started;
    const confirmed = await this.fetchTransaction(signature);
    if (confirmed?.meta?.err) {
      throw new TransactionFailedError(`${label} failed: ${describeTxError(confirmed.meta.err)}`, signature, confirmed.meta.err);
    }
    return { signature, latencyMs, tx: confirmed };
  }

  private async confirm(signature: string, raw: Uint8Array, lastValidBlockHeight: number, label: string): Promise<void> {
    const pollMs = this.opts.pollMs ?? 500;
    const rebroadcastMs = this.opts.rebroadcastMs ?? 2_000;
    const deadline = Date.now() + this.opts.confirmTimeoutMs;
    let lastBroadcast = Date.now();

    while (Date.now() < deadline) {
      await sleep(pollMs);
      try {
        const { value } = await withTimeout(this.rpc.call('getSignatureStatuses', (c) => c.getSignatureStatuses([signature])),
          2_000, 'signature status');
        const status = value[0];
        if (status?.err) {
          throw new TransactionFailedError(`${label} failed: ${describeTxError(status.err)}`, signature, status.err);
        }
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
      } catch (error) {
        if (error instanceof TransactionFailedError) throw error;
        this.log.debug({ signature, err: errorMessage(error) }, 'Status poll failed');
      }

      if (Date.now() - lastBroadcast >= rebroadcastMs) {
        lastBroadcast = Date.now();
        try {
          const height = await withTimeout(this.rpc.connection.getBlockHeight('confirmed'), 2_000, 'block height');
          if (height > lastValidBlockHeight) break;
          await withTimeout(this.rpc.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }), 2_000, 'rebroadcast');
        } catch (error) {
          this.log.debug({ signature, err: errorMessage(error) }, 'Re-broadcast failed');
        }
      }
    }

    // Last chance: the transaction may have landed right before the blockhash expired.
    try {
      const { value } = await withTimeout(this.rpc.call('getSignatureStatuses', (c) =>
        c.getSignatureStatuses([signature], { searchTransactionHistory: true }),
      ), 2_000, 'final signature status');
      const status = value[0];
      if (status?.err) {
        throw new TransactionFailedError(`${label} failed: ${describeTxError(status.err)}`, signature, status.err);
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
    } catch (error) {
      if (error instanceof TransactionFailedError) throw error;
    }
    throw new TransactionFailedError(`${label}: not confirmed (expired or timed out)`, signature);
  }

  private async fetchTransaction(signature: string): Promise<VersionedTransactionResponse | null> {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const tx = await withTimeout(this.rpc.call('getTransaction', (c) =>
          c.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
        ), 3_000, 'transaction metadata');
        if (tx) return tx;
      } catch (error) {
        this.log.debug({ signature, err: errorMessage(error) }, 'getTransaction failed');
      }
      await sleep(400 * (attempt + 1));
    }
    this.log.warn({ signature }, 'Confirmed transaction metadata unavailable; execution must be reconciled');
    return null;
  }
}
