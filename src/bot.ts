import { PublicKey } from '@solana/web3.js';
import { publicConfig, type AppConfig } from './config';
import { Notifier } from './alerts/notifier';
import { CopyTradeEngine } from './copytrade/engine';
import type { Db } from './database/db';
import { Repository } from './database/repository';
import { PumpFunIndexer, type IndexerStats } from './indexer/pumpfunIndexer';
import { PriceTracker, type TrackedPrice } from './indexer/priceTracker';
import { bondingCurvePda, decodeBondingCurve } from './pumpfun';
import { RpcManager } from './rpc/rpcManager';
import { PositionManager, type PositionSnapshot } from './trading/positionManager';
import { Sniper, type SniperStats } from './trading/sniper';
import { OperationManager } from './trading/operationManager';
import { LiveTrader, PaperTrader, type Trader } from './trading/trader';
import { loadKeypair } from './trading/wallet';
import type { BondingCurveState, OperationMode, Position, TradeMode } from './types';
import { errorMessage, sleep, withTimeout } from './utils/async';
import { tokenUnitsToUi } from './pumpfun';
import { getLogger } from './utils/logger';

export interface BotStatus {
  mode: TradeMode;
  startedAt: number;
  uptimeSeconds: number;
  wallet: string | null;
  walletBalanceSol: number | null;
  rpcEndpoint: string;
  indexer: IndexerStats;
  sniper: SniperStats;
  openPositions: number;
  trackedTokens: number;
}

/** Operations the REST API needs from the running bot. */
export interface BotController {
  readonly mode: TradeMode;
  status(): BotStatus;
  pause(): void;
  resume(): void;
  openPositions(): PositionSnapshot[];
  sellPosition(mint: string): Promise<Position>;
  livePrice(mint: string): TrackedPrice | undefined;
  trackedPrices(): TrackedPrice[];
  fetchCurve(mint: string): Promise<BondingCurveState | null>;
  publicConfig(): ReturnType<typeof publicConfig>;
  operationStatus?(): object;
  setOperation?(mode: OperationMode, settings?: unknown): Promise<unknown>;
  copySettings?(): unknown;
  configureCopy?(settings: unknown): Promise<unknown>;
  operationLogs?(): unknown[];
}

/** Wires indexer → sniper → position manager and owns their lifecycle. */
export class Bot implements BotController {
  private readonly log = getLogger('bot');
  readonly repo: Repository;
  readonly rpc: RpcManager;
  readonly notifier: Notifier;
  readonly trader: Trader;
  readonly prices: PriceTracker;
  readonly positions: PositionManager;
  readonly sniper: Sniper;
  readonly indexer: PumpFunIndexer;
  readonly copytrade: CopyTradeEngine;
  readonly operations: OperationManager;
  private readonly startedAt = Date.now();
  private maintenance: NodeJS.Timeout | null = null;
  private recovering = false;
  private recoveryCursor = 0;
  private stopping = false;

  constructor(
    private readonly cfg: AppConfig,
    db: Db,
  ) {
    this.repo = new Repository(db);
    this.rpc = new RpcManager(cfg.rpc.endpoints);
    this.notifier = Notifier.fromConfig(cfg);
    this.trader = cfg.trading.dryRun
      ? new PaperTrader(cfg.trading)
      : new LiveTrader(this.rpc, loadKeypair(cfg.wallet.privateKey!), cfg.trading, this.repo);
    this.prices = new PriceTracker(this.repo, {
      trackNewTokensSeconds: cfg.tracking.trackNewTokensSeconds,
      maxTrackedTokens: cfg.tracking.maxTrackedTokens,
      tickIntervalMs: cfg.tracking.priceTickIntervalMs,
    });
    this.positions = new PositionManager(this.repo, this.trader, this.rpc, this.prices, this.notifier, cfg);
    this.sniper = new Sniper(this.repo, this.trader, this.positions, this.prices, this.notifier, cfg.trading);
    this.copytrade = new CopyTradeEngine(this.repo, this.rpc, this.positions, this.prices, cfg);
    this.operations = new OperationManager(this.repo, {
      disableEntries: () => { this.sniper.pause(); this.copytrade.setEntries(false); },
      enableEntries: (mode) => {
        if (mode === 'sniper') this.sniper.resume();
        if (mode === 'copytrade') this.copytrade.setEntries(true);
      },
      configureCopy: (settings) => this.copytrade.configure(settings),
      validateCopy: () => {
        const settings = this.copytrade.getSettings();
        if (!settings.enabled || !settings.wallets.length) throw new Error('Enable copy trading and configure source wallets first');
      },
    });
    this.trader.setEntryGuard?.(() => !this.stopping && this.operations.status().mode === 'sniper' &&
      !this.operations.status().paused && !this.operations.status().transitioning);
    this.indexer = new PumpFunIndexer(this.rpc, {
      commitment: cfg.rpc.detectionCommitment,
      heartbeatTimeoutMs: cfg.rpc.heartbeatTimeoutMs,
    });
  }

  get mode(): TradeMode {
    return this.trader.mode;
  }

  async start(): Promise<void> {
    await this.trader.init();
    this.positions.start();
    await this.recoverPendingBuys();
    await this.copytrade.start();

    this.indexer.on('token', (token) => {
      this.sniper.onToken(token).catch((error) => this.log.error({ err: errorMessage(error) }, 'Sniper error'));
    });
    this.indexer.on('trade', (trade) => {
      this.prices.onTrade(trade);
      this.positions.onTrade(trade);
    });
    this.indexer.start();

    this.maintenance = setInterval(() => this.runMaintenance(), 60_000);
    this.maintenance.unref();

    this.log.info(
      {
        mode: this.mode,
        autoBuy: !this.sniper.isPaused(),
        buyAmountSol: this.cfg.trading.buyAmountSol,
        takeProfit: `${this.cfg.strategy.takeProfitPercent}%`,
        stopLoss: `${this.cfg.strategy.stopLossPercent}%`,
        noGainExit: `${this.cfg.strategy.noGainExitSeconds}s`,
        maxHold: `${this.cfg.strategy.maxHoldSeconds}s`,
      },
      'Bot started',
    );
    this.notifier.info(`Bot started in ${this.mode.toUpperCase()} mode`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.operations.set('idle');
    if (this.maintenance) clearInterval(this.maintenance);
    await withTimeout(this.indexer.stop(), 3_000, 'indexer shutdown').catch(() => {});
    await this.copytrade.stop();
    const settleMs = this.cfg.trading.txConfirmTimeoutMs + 40_000;
    await this.sniper.settle(settleMs);
    const recoveryDeadline = Date.now() + 18_000;
    while (this.recovering && Date.now() < recoveryDeadline) await sleep(25);
    await this.positions.stop(settleMs);
    this.trader.stop();
    const open = this.positions.openCount;
    if (open > 0) this.log.warn({ open }, 'Stopping with open positions – they will be resumed on next start');
  }

  private runMaintenance(): void {
    this.prices.prune();
    try {
      const removed = this.repo.prunePriceTicks(Date.now() - this.cfg.tracking.priceTickRetentionHours * 3_600_000);
      if (removed > 0) this.log.debug({ removed }, 'Pruned old price ticks');
    } catch (error) {
      this.log.warn({ err: errorMessage(error) }, 'Price tick pruning failed');
    }
    void this.recoverPendingBuys();
  }

  private async recoverPendingBuys(): Promise<void> {
    if (this.recovering || this.stopping || this.sniper.getStats().inFlight > 0 || !(this.trader instanceof LiveTrader)) return;
    this.recovering = true;
    try {
      const pending = this.repo.pendingActions().filter((a) => a.kind === 'live_buy' && a.state === 'submitted');
      const batch = Array.from({ length: Math.min(2, pending.length) },
        (_, i) => pending[(this.recoveryCursor + i) % pending.length]);
      this.recoveryCursor = pending.length ? (this.recoveryCursor + batch.length) % pending.length : 0;
      for (const action of batch) {
        if (this.stopping) break;
        const payload = JSON.parse(action.payload) as { mint: string; creator: string; tokenProgram: string };
        try {
          const curve = await withTimeout(this.fetchCurve(payload.mint), 3_000, 'recover curve');
          if (!curve) continue;
          const reserves = { virtualSolReserves: curve.virtualQuoteReserves, virtualTokenReserves: curve.virtualTokenReserves,
            realSolReserves: curve.realQuoteReserves, realTokenReserves: curve.realTokenReserves };
          const result = await this.trader.buy({ mint: new PublicKey(payload.mint), creator: new PublicKey(payload.creator),
            tokenProgram: new PublicKey(payload.tokenProgram), isMayhemMode: curve.isMayhemMode, reserves });
          const token = this.repo.getToken(payload.mint);
          const position = this.repo.atomic(() => {
            const entryPrice = result.solSpent / tokenUnitsToUi(result.tokenAmount);
            const opened = this.repo.createPosition({ mint: payload.mint, name: token?.name ?? payload.mint,
              symbol: token?.symbol ?? 'RECOVERED', mode: 'live', tokenProgram: payload.tokenProgram, creator: payload.creator,
              solSpent: result.solSpent, tokenAmount: result.tokenAmount, entryPrice, buySignature: result.signature,
              openedAt: action.createdAt, origin: 'sniper' });
            this.repo.insertTrade({ positionId: opened.id, mint: payload.mint, side: 'buy', mode: 'live', success: true,
              solAmount: result.solSpent, tokenAmount: result.tokenAmount, price: entryPrice, signature: result.signature,
              error: null, latencyMs: 0, createdAt: Date.now() });
            this.repo.finishAction(action.key, 'completed', { positionId: opened.id });
            if (token) this.repo.finishAction(`sniper:${payload.mint}:${token.signature}`, 'completed', { positionId: opened.id });
            return opened;
          });
          this.positions.add(position, { reserves, creator: payload.creator, isMayhemMode: curve.isMayhemMode });
        } catch (error) {
          this.repo.logOperation('reconcile_pending_buy', { key: action.key, error: errorMessage(error) });
        }
      }
    } finally { this.recovering = false; }
  }

  status(): BotStatus {
    return {
      mode: this.mode,
      startedAt: this.startedAt,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      wallet: this.trader.walletAddress,
      walletBalanceSol: this.trader.cachedBalanceSol(),
      rpcEndpoint: this.rpc.currentEndpoint,
      indexer: this.indexer.getStats(),
      sniper: this.sniper.getStats(),
      openPositions: this.positions.openCount,
      trackedTokens: this.prices.size,
    };
  }

  pause(): void {
    this.operations.pause();
  }

  resume(): void {
    this.operations.resume();
  }

  operationStatus(): object { return { ...this.operations.status(), copytrade: this.copytrade.status() }; }
  setOperation(mode: OperationMode, settings?: unknown): Promise<unknown> {
    if (this.stopping) return Promise.reject(new Error('Bot is shutting down'));
    return this.operations.set(mode, settings);
  }
  copySettings(): unknown { return this.copytrade.getSettings(); }
  configureCopy(settings: unknown): Promise<unknown> { return this.operations.configure(settings); }
  operationLogs(): unknown[] { return this.repo.operationLogs(); }

  openPositions(): PositionSnapshot[] {
    return this.positions.snapshots();
  }

  sellPosition(mint: string): Promise<Position> {
    return this.positions.sellNow(mint);
  }

  livePrice(mint: string): TrackedPrice | undefined {
    return this.prices.get(mint);
  }

  trackedPrices(): TrackedPrice[] {
    return this.prices.list();
  }

  async fetchCurve(mint: string): Promise<BondingCurveState | null> {
    const info = await this.rpc.call('getAccountInfo', (c) => c.getAccountInfo(bondingCurvePda(new PublicKey(mint))));
    return info ? decodeBondingCurve(info.data) : null;
  }

  publicConfig() {
    return publicConfig(this.cfg);
  }
}
