import { EventEmitter } from 'node:events';
import bs58 from 'bs58';
import type { Connection, Context, Logs } from '@solana/web3.js';
import {
  PUMP_PROGRAM_ID,
  decodeEventCpiData,
  logsContainCreate,
  marketCapSol,
  parsePumpLogs,
  priceSolPerToken,
} from '../pumpfun';
import type { RpcManager } from '../rpc/rpcManager';
import type { CreateEventData, CurveReserves, DetectedToken, PumpEvent, TradeEventData } from '../types';
import { BoundedSet, errorMessage, sleep } from '../utils/async';
import { getLogger } from '../utils/logger';

export interface IndexerOptions {
  commitment: 'processed' | 'confirmed';
  /** Resubscribe (and fail over) if no message has been received for this long. */
  heartbeatTimeoutMs: number;
}

export interface IndexerStats {
  running: boolean;
  endpoint: string;
  messagesReceived: number;
  tokensDetected: number;
  tradesSeen: number;
  recoveredFromTx: number;
  reconnects: number;
  lastMessageAt: number | null;
  lastTokenAt: number | null;
  subscribedAt: number | null;
  avgDetectionLatencyMs: number | null;
}

export interface IndexerEvents {
  token: [token: DetectedToken];
  trade: [trade: TradeEventData, signature: string];
}

/**
 * Real-time Pump.fun indexer.
 *
 * Subscribes to `logsSubscribe` for every transaction that mentions the Pump program,
 * decodes `CreateEvent` / `TradeEvent` from the logs and emits:
 *  - `token`  for every newly created coin (with post-creation reserves, incl. dev buy)
 *  - `trade`  for every bonding-curve trade (used for real-time pricing)
 *
 * A heartbeat watchdog resubscribes – rotating to the next RPC endpoint – whenever the
 * stream goes silent (Pump.fun trades constantly, so silence means a dead socket).
 */
export class PumpFunIndexer extends EventEmitter<IndexerEvents> {
  private readonly log = getLogger('indexer');
  private readonly seenMints = new BoundedSet<string>(50_000);
  private readonly recoveries = new Set<string>();
  private generation = 0;
  private subscription: { connection: Connection; id: number } | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private latencySamples = 0;
  private latencyTotal = 0;
  private readonly stats: Omit<IndexerStats, 'running' | 'endpoint' | 'avgDetectionLatencyMs'> = {
    messagesReceived: 0,
    tokensDetected: 0,
    tradesSeen: 0,
    recoveredFromTx: 0,
    reconnects: 0,
    lastMessageAt: null,
    lastTokenAt: null,
    subscribedAt: null,
  };

  constructor(
    private readonly rpc: RpcManager,
    private readonly opts: IndexerOptions,
  ) {
    super();
  }

  start(): void {
    if (this.subscription) return;
    this.subscribe(this.rpc.connection);
    const every = Math.max(1_000, Math.floor(this.opts.heartbeatTimeoutMs / 3));
    this.heartbeat = setInterval(() => this.checkHeartbeat(), every);
    this.heartbeat.unref();
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await this.unsubscribe();
  }

  getStats(): IndexerStats {
    return {
      ...this.stats,
      running: this.subscription !== null,
      endpoint: this.rpc.currentEndpoint,
      avgDetectionLatencyMs: this.latencySamples ? Math.round(this.latencyTotal / this.latencySamples) : null,
    };
  }

  private subscribe(connection: Connection): void {
    const id = connection.onLogs(PUMP_PROGRAM_ID, (logs, ctx) => this.onLogs(logs, ctx), this.opts.commitment);
    this.subscription = { connection, id };
    this.stats.subscribedAt = Date.now();
    this.log.info(
      { endpoint: this.rpc.currentEndpoint, commitment: this.opts.commitment },
      'Subscribed to Pump.fun program logs',
    );
  }

  private async unsubscribe(): Promise<void> {
    const sub = this.subscription;
    this.subscription = null;
    if (!sub) return;
    try {
      await sub.connection.removeOnLogsListener(sub.id);
    } catch (error) {
      this.log.debug({ err: errorMessage(error) }, 'Error while removing logs listener');
    }
  }

  private checkHeartbeat(): void {
    if (!this.subscription) return;
    const last = this.stats.lastMessageAt ?? this.stats.subscribedAt ?? Date.now();
    const silentFor = Date.now() - last;
    if (silentFor < this.opts.heartbeatTimeoutMs) return;

    this.stats.reconnects++;
    this.log.warn({ silentForMs: silentFor }, 'Log stream is silent – resubscribing');
    void this.unsubscribe().then(() => {
      if (this.heartbeat === null) return; // stopped meanwhile
      this.subscribe(this.rpc.rotate('websocket heartbeat timeout'));
    });
  }

  /** Exposed for testing; invoked for every Pump.fun transaction log notification. */
  onLogs(logs: Logs, ctx: Context): void {
    this.stats.messagesReceived++;
    this.stats.lastMessageAt = Date.now();
    if (logs.err) return;

    let events: PumpEvent[];
    try {
      events = parsePumpLogs(logs.logs);
    } catch (error) {
      this.log.warn({ signature: logs.signature, err: errorMessage(error) }, 'Failed to parse logs');
      return;
    }

    const hasCreateEvent = events.some((e) => e.type === 'create');
    if (!hasCreateEvent && logsContainCreate(logs.logs)) {
      // Logs can be truncated for large transactions – fall back to fetching the tx.
      void this.recoverFromTransaction(logs.signature, ctx.slot);
    }
    this.processEvents(events, logs.signature, ctx.slot);
  }

  private processEvents(events: PumpEvent[], signature: string, slot: number): void {
    const trades = events.filter((e): e is Extract<PumpEvent, { type: 'trade' }> => e.type === 'trade').map((e) => e.data);

    for (const event of events) {
      if (event.type !== 'create') continue;
      if (!this.seenMints.add(event.data.mint)) continue;
      const token = this.buildDetectedToken(event.data, trades, signature, slot);
      this.stats.tokensDetected++;
      this.stats.lastTokenAt = token.detectedAt;
      const latency = token.detectedAt - token.timestamp * 1000;
      if (latency >= 0 && latency < 60_000) {
        this.latencySamples++;
        this.latencyTotal += latency;
      }
      this.safeEmit('token', token);
    }

    for (const trade of trades) {
      this.stats.tradesSeen++;
      this.safeEmit('trade', trade, signature);
    }
  }

  private safeEmit<K extends keyof IndexerEvents>(event: K, ...args: IndexerEvents[K]): void {
    try {
      (this.emit as (e: K, ...a: IndexerEvents[K]) => boolean)(event, ...args);
    } catch (error) {
      this.log.error({ event, err: errorMessage(error) }, 'Indexer listener threw');
    }
  }

  private buildDetectedToken(
    create: CreateEventData,
    trades: TradeEventData[],
    signature: string,
    slot: number,
  ): DetectedToken {
    const sameMint = trades.filter((t) => t.mint === create.mint);
    const last = sameMint[sameMint.length - 1];
    const reserves: CurveReserves = last
      ? {
          virtualSolReserves: last.virtualSolReserves,
          virtualTokenReserves: last.virtualTokenReserves,
          realSolReserves: last.realSolReserves,
          realTokenReserves: last.realTokenReserves,
        }
      : {
          virtualSolReserves: create.virtualSolReserves,
          virtualTokenReserves: create.virtualTokenReserves,
          realSolReserves: 0n,
          realTokenReserves: create.realTokenReserves,
        };
    const devBuySol = sameMint.filter((t) => t.isBuy).reduce((sum, t) => sum + t.solAmount, 0n);
    const priceSol = priceSolPerToken(reserves.virtualSolReserves, reserves.virtualTokenReserves);
    return {
      ...create,
      signature,
      slot,
      detectedAt: Date.now(),
      reserves,
      devBuySol,
      priceSol,
      marketCapSol: marketCapSol(priceSol, create.tokenTotalSupply),
    };
  }

  private async recoverFromTransaction(signature: string, slot: number): Promise<void> {
    if (this.recoveries.has(signature) || this.recoveries.size >= 4) return;
    this.recoveries.add(signature);
    const generation = this.generation;
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        const tx = await this.rpc.call('getTransaction', (c) =>
          c.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
        );
        if (generation !== this.generation || tx?.meta?.err) return;
        if (tx?.meta) {
          const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
          const events: PumpEvent[] = [];
          for (const inner of tx.meta.innerInstructions ?? []) {
            for (const ix of inner.instructions) {
              if (!keys.get(ix.programIdIndex)?.equals(PUMP_PROGRAM_ID)) continue;
              const decoded = decodeEventCpiData(Buffer.from(bs58.decode(ix.data)));
              if (decoded) events.push(decoded);
            }
          }
          if (events.length) {
            this.stats.recoveredFromTx++;
            this.processEvents(events, signature, slot);
          }
          return;
        }
        await sleep(500);
      }
    } catch (error) {
      this.log.debug({ signature, err: errorMessage(error) }, 'Could not recover create event from transaction');
    } finally {
      this.recoveries.delete(signature);
    }
  }
}
