import { PublicKey } from '@solana/web3.js';
import { publicConfig, type AppConfig } from './config';
import { Notifier } from './alerts/notifier';
import type { Db } from './database/db';
import { Repository } from './database/repository';
import { PumpFunIndexer, type IndexerStats } from './indexer/pumpfunIndexer';
import { PriceTracker, type TrackedPrice } from './indexer/priceTracker';
import { bondingCurvePda, decodeBondingCurve } from './pumpfun';
import { RpcManager } from './rpc/rpcManager';
import { PositionManager, type PositionSnapshot } from './trading/positionManager';
import { Sniper, type SniperStats } from './trading/sniper';
import { LiveTrader, PaperTrader, type Trader } from './trading/trader';
import { loadKeypair } from './trading/wallet';
import type { BondingCurveState, Position, TradeMode } from './types';
import { errorMessage } from './utils/async';
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
  private readonly startedAt = Date.now();
  private maintenance: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: AppConfig,
    db: Db,
  ) {
    this.repo = new Repository(db);
    this.rpc = new RpcManager(cfg.rpc.endpoints);
    this.notifier = Notifier.fromConfig(cfg);
    this.trader = cfg.trading.dryRun
      ? new PaperTrader(cfg.trading)
      : new LiveTrader(this.rpc, loadKeypair(cfg.wallet.privateKey!), cfg.trading);
    this.prices = new PriceTracker(this.repo, {
      trackNewTokensSeconds: cfg.tracking.trackNewTokensSeconds,
      maxTrackedTokens: cfg.tracking.maxTrackedTokens,
      tickIntervalMs: cfg.tracking.priceTickIntervalMs,
    });
    this.positions = new PositionManager(this.repo, this.trader, this.rpc, this.prices, this.notifier, cfg);
    this.sniper = new Sniper(this.repo, this.trader, this.positions, this.prices, this.notifier, cfg.trading);
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
    if (this.maintenance) clearInterval(this.maintenance);
    await this.indexer.stop();
    this.positions.stop();
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
    this.sniper.pause();
  }

  resume(): void {
    this.sniper.resume();
  }

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
