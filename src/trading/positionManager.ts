import { EventEmitter } from 'node:events';
import { PublicKey } from '@solana/web3.js';
import type { AppConfig } from '../config';
import type { Repository } from '../database/repository';
import type { Notifier } from '../alerts/notifier';
import type { PriceTracker } from '../indexer/priceTracker';
import {
  bondingCurvePda,
  decodeBondingCurve,
  estimateSellProceeds,
  lamportsToSol,
  priceSolPerToken,
  tokenUnitsToUi,
} from '../pumpfun';
import type { RpcManager } from '../rpc/rpcManager';
import type { BondingCurveState, CurveReserves, ExitReason, Position, TradeEventData } from '../types';
import { errorMessage, sleep, withTimeout } from '../utils/async';
import { getLogger } from '../utils/logger';
import { evaluateExit } from './strategy';
import { LiveTrader, NothingToSellError, PaperTrader, type Trader } from './trader';

const DEFAULT_TOTAL_SUPPLY = 1_000_000_000_000_000n;

interface Tracked {
  position: Position;
  reserves: CurveReserves | null;
  creator: string;
  isMayhemMode: boolean;
  tokenTotalSupply: bigint;
  valueSol: number;
  priceSol: number;
  highestValueSol: number;
  selling: boolean;
  sellFailures: number;
  nextSellAttemptAt: number;
  lastPersistAt: number;
  priceUpdatedAt: number;
}

export interface PositionSnapshot extends Position {
  currentValueSol: number;
  currentPriceSol: number;
  unrealizedPnlSol: number;
  unrealizedPnlPercent: number;
  heldSeconds: number;
  priceUpdatedAt: number;
  selling: boolean;
}

export interface PositionManagerEvents {
  closed: [position: Position];
}

type Cfg = Pick<AppConfig, 'strategy' | 'trading'>;

const toReserves = (c: BondingCurveState): CurveReserves => ({
  virtualSolReserves: c.virtualQuoteReserves,
  virtualTokenReserves: c.virtualTokenReserves,
  realSolReserves: c.realQuoteReserves,
  realTokenReserves: c.realTokenReserves,
});

/**
 * Watches open positions in real time and exits them according to the strategy.
 * Prices come from the indexer's trade stream (instant, free) and from a batched
 * `getMultipleAccounts` poll of the bonding curves (one RPC call per tick for all positions).
 */
export class PositionManager extends EventEmitter<PositionManagerEvents> {
  private readonly log = getLogger('positions');
  private readonly tracked = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopping = false;
  private readonly sells = new Set<Promise<Position | null>>();
  private readonly paper: PaperTrader;

  constructor(
    private readonly repo: Repository,
    private readonly trader: Trader,
    private readonly rpc: RpcManager,
    private readonly prices: PriceTracker,
    private readonly notifier: Notifier,
    private readonly cfg: Cfg,
  ) {
    super();
    this.paper = new PaperTrader(cfg.trading);
  }

  /** Resumes open positions from the database and starts the monitoring loop. */
  start(): void {
    this.stopping = false;
    for (const position of this.repo.getOpenPositions()) {
      this.track(position, { reserves: null, creator: position.creator, isMayhemMode: false });
      this.log.info({ mint: position.mint, symbol: position.symbol }, 'Resumed open position');
    }
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.cfg.strategy.priceCheckIntervalMs);
    this.timer.unref();
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + timeoutMs;
    while ((this.sells.size || this.polling) && Date.now() < deadline) await sleep(25);
    for (const t of this.tracked.values()) {
      this.repo.updatePositionMarket(t.position.id, t.priceSol, t.valueSol, t.highestValueSol);
    }
  }

  get openCount(): number {
    return this.tracked.size;
  }

  has(mint: string): boolean {
    return this.tracked.has(mint);
  }

  /** Starts managing a newly opened position. */
  add(
    position: Position,
    meta: { reserves: CurveReserves | null; creator: string; isMayhemMode: boolean; tokenTotalSupply?: bigint },
  ): void {
    this.track(position, meta);
  }

  snapshots(): PositionSnapshot[] {
    const now = Date.now();
    return [...this.tracked.values()].map((t) => ({
      ...t.position,
      currentValueSol: t.valueSol,
      currentPriceSol: t.priceSol,
      unrealizedPnlSol: t.valueSol - t.position.solSpent,
      unrealizedPnlPercent: t.position.solSpent > 0 ? (t.valueSol / t.position.solSpent - 1) * 100 : 0,
      heldSeconds: Math.round((now - t.position.openedAt) / 1000),
      priceUpdatedAt: t.priceUpdatedAt,
      selling: t.selling,
    }));
  }

  /** Real-time price update from the indexer trade stream. */
  onTrade(trade: TradeEventData): void {
    if (this.stopping) return;
    const t = this.tracked.get(trade.mint);
    if (!t) return;
    this.updatePrice(t, {
      virtualSolReserves: trade.virtualSolReserves,
      virtualTokenReserves: trade.virtualTokenReserves,
      realSolReserves: trade.realSolReserves,
      realTokenReserves: trade.realTokenReserves,
    });
    void this.evaluate(t);
  }

  /** Manually closes a position (API). */
  async sellNow(mint: string): Promise<Position> {
    const t = this.tracked.get(mint);
    if (!t) throw new Error(`No open position for ${mint}`);
    const closed = await this.sell(t, 'manual', true);
    if (!closed) throw new Error(t.position.error ?? 'Sell failed – will retry automatically');
    return closed;
  }

  async sellFraction(mint: string, numerator: bigint, denominator: bigint, actionKey: string): Promise<Position> {
    const action = this.repo.action(actionKey);
    if (action?.state === 'completed' && action.positionId) return this.repo.getPosition(action.positionId)!;
    const t = this.tracked.get(mint);
    if (!t || t.position.origin !== 'copytrade') throw new Error('No matching copy position');
    if (numerator <= 0n || denominator <= 0n) throw new Error('Invalid source sell fraction');
    const amount = t.position.tokenAmount * (numerator > denominator ? denominator : numerator) / denominator;
    if (amount === 0n) {
      this.repo.finishAction(actionKey, 'completed', { positionId: t.position.id });
      return t.position;
    }
    const sold = await this.sell(t, 'manual', true, amount, actionKey);
    if (!sold) throw new Error('Copy sell pending or failed');
    return sold;
  }

  private track(
    position: Position,
    meta: { reserves: CurveReserves | null; creator: string; isMayhemMode: boolean; tokenTotalSupply?: bigint },
  ): void {
    const t: Tracked = {
      position,
      reserves: null,
      creator: meta.creator,
      isMayhemMode: meta.isMayhemMode,
      tokenTotalSupply: meta.tokenTotalSupply ?? DEFAULT_TOTAL_SUPPLY,
      valueSol: position.lastValueSol ?? position.solSpent,
      priceSol: position.lastPrice ?? position.entryPrice,
      highestValueSol: Math.max(position.highestValueSol, position.solSpent),
      selling: false,
      sellFailures: 0,
      nextSellAttemptAt: 0,
      lastPersistAt: 0,
      priceUpdatedAt: 0,
    };
    this.tracked.set(position.mint, t);
    if (meta.reserves) this.updatePrice(t, meta.reserves);
  }

  private updatePrice(t: Tracked, reserves: CurveReserves): void {
    t.reserves = reserves;
    t.priceSol = priceSolPerToken(reserves.virtualSolReserves, reserves.virtualTokenReserves);
    t.valueSol = (t.position.solReceived ?? 0) + lamportsToSol(estimateSellProceeds(reserves, t.position.tokenAmount, this.cfg.trading.estimatedFeePercent));
    t.highestValueSol = Math.max(t.highestValueSol, t.valueSol);
    t.priceUpdatedAt = Date.now();
    this.prices.pin(t.position.mint, reserves, t.tokenTotalSupply);

    if (t.priceUpdatedAt - t.lastPersistAt >= 1_000) {
      t.lastPersistAt = t.priceUpdatedAt;
      this.repo.updatePositionMarket(t.position.id, t.priceSol, t.valueSol, t.highestValueSol);
    }
  }

  /** One monitoring cycle: refresh all curves with a single RPC call, then evaluate every position. */
  async tick(): Promise<void> {
    if (this.stopping || this.polling || this.tracked.size === 0) return;
    this.polling = true;
    try {
      const list = [...this.tracked.values()];
      try {
        const infos = await withTimeout(this.rpc.call('getMultipleAccountsInfo', (c) =>
          c.getMultipleAccountsInfo(list.map((t) => bondingCurvePda(new PublicKey(t.position.mint))), 'processed'),
        ), 4_000, 'position curve poll');
        infos.forEach((info, i) => {
          const curve = info ? decodeBondingCurve(info.data) : null;
          if (curve) this.applyCurve(list[i], curve);
        });
      } catch (error) {
        this.log.warn({ err: errorMessage(error) }, 'Bonding curve poll failed – using last known prices');
      }
      // Time-based exits must fire even when the price does not change.
      await Promise.all([...this.tracked.values()].map((t) => this.evaluate(t)));
    } finally {
      this.polling = false;
    }
  }

  private applyCurve(t: Tracked, curve: BondingCurveState): void {
    if (curve.creator) t.creator = curve.creator;
    t.isMayhemMode = curve.isMayhemMode;
    t.tokenTotalSupply = curve.tokenTotalSupply;
    if (curve.complete) {
      void this.markMigrated(t);
      return;
    }
    this.updatePrice(t, toReserves(curve));
  }

  private async evaluate(t: Tracked): Promise<void> {
    if (this.stopping || t.selling || !this.tracked.has(t.position.mint) || Date.now() < t.nextSellAttemptAt) return;
    const decision = evaluateExit(
      {
        costSol: t.position.solSpent,
        valueSol: t.valueSol,
        highestValueSol: t.highestValueSol,
        openedAt: t.position.openedAt,
        now: Date.now(),
      },
      this.cfg.strategy,
    );
    if (!decision.exit || !decision.reason) return;
    // Without any price information we cannot evaluate PnL rules – but time-based exits still apply.
    if (t.priceUpdatedAt === 0 && (decision.reason === 'take_profit' || decision.reason === 'stop_loss' || decision.reason === 'trailing_stop')) {
      return;
    }
    this.log.info(
      { mint: t.position.mint, symbol: t.position.symbol, reason: decision.reason, pnlPercent: decision.pnlPercent.toFixed(2) },
      'Exit signal',
    );
    await this.sell(t, decision.reason, false);
  }

  /** Fetches the freshest curve right before selling (accurate slippage + migration check). */
  private async refreshCurve(t: Tracked): Promise<BondingCurveState | null> {
    try {
      const info = await withTimeout(
        this.rpc.call('getAccountInfo', (c) => c.getAccountInfo(bondingCurvePda(new PublicKey(t.position.mint)), 'processed')),
        2_500,
        'curve refresh',
      );
      return info ? decodeBondingCurve(info.data) : null;
    } catch (error) {
      this.log.debug({ mint: t.position.mint, err: errorMessage(error) }, 'Curve refresh failed');
      return null;
    }
  }

  private sell(t: Tracked, reason: ExitReason, manual: boolean, amount?: bigint, actionKey?: string): Promise<Position | null> {
    const promise = this.executeSell(t, reason, manual, amount, actionKey);
    this.sells.add(promise);
    void promise.finally(() => this.sells.delete(promise)).catch(() => {});
    return promise;
  }

  private async executeSell(t: Tracked, reason: ExitReason, manual: boolean, amount?: bigint, actionKey?: string): Promise<Position | null> {
    if (t.selling) return null;
    t.selling = true;
    const mint = t.position.mint;
    try {
      const curve = await this.refreshCurve(t);
      if (curve) {
        if (curve.complete) {
          await this.markMigrated(t);
          return this.repo.getPosition(t.position.id);
        }
        this.applyCurve(t, curve);
      }
      if (!t.reserves) throw new Error('No bonding-curve data available yet');

      const trader = t.position.mode === 'paper' ? this.paper : this.trader;
      if (trader.mode !== t.position.mode) throw new Error('Live position requires live trader; liquidation not simulated');
      const result = await trader.sell(
        {
          mint: new PublicKey(mint),
          creator: new PublicKey(t.creator),
          tokenProgram: new PublicKey(t.position.tokenProgram),
          isMayhemMode: t.isMayhemMode,
          reserves: t.reserves,
        },
        amount ?? t.position.tokenAmount,
      );

      const totalReceived = (t.position.solReceived ?? 0) + result.solReceived;
      const pnlSol = totalReceived - t.position.solSpent;
      const pnlPercent = t.position.solSpent > 0 ? (pnlSol / t.position.solSpent) * 100 : 0;
      const tokensUi = tokenUnitsToUi(result.tokenAmountSold);
      const exitPrice = tokensUi > 0 ? result.solReceived / tokensUi : t.priceSol;
      const now = Date.now();

      const saved = this.repo.atomic(() => {
        this.repo.insertTrade({
        positionId: t.position.id,
        mint,
        side: 'sell',
        mode: t.position.mode,
        success: true,
        solAmount: result.solReceived,
        tokenAmount: result.tokenAmountSold,
        price: exitPrice,
        signature: result.signature,
        error: null,
        latencyMs: result.latencyMs,
        createdAt: now,
      });
        const remaining = t.position.tokenAmount - result.tokenAmountSold;
        const position = remaining > 0n
          ? this.repo.applyPartialSell(t.position.id, remaining, result.solReceived)
          : this.repo.closePosition(t.position.id, {
        status: 'closed',
        exitPrice,
        solReceived: totalReceived,
        pnlSol,
        pnlPercent,
        exitReason: reason,
        sellSignature: result.signature,
        closedAt: now,
          });
        if (actionKey) this.repo.finishAction(actionKey, 'completed', { positionId: position.id, signature: result.signature });
        if (trader instanceof LiveTrader) this.repo.finishAction(trader.executionKey('sell', mint), 'completed', { positionId: position.id });
        return position;
      });
      if (saved.status === 'open') {
        t.position = saved;
        this.updatePrice(t, t.reserves);
        return saved;
      }
      const closed = saved;
      this.untrack(mint);
      this.log.info(
        { mint, symbol: closed.symbol, reason, pnlSol: pnlSol.toFixed(5), pnlPercent: pnlPercent.toFixed(2), signature: result.signature },
        'Position closed',
      );
      this.notifier.sold(closed);
      this.emit('closed', closed);
      return closed;
    } catch (error) {
      return this.handleSellError(t, reason, error, manual);
    } finally {
      t.selling = false;
    }
  }

  private handleSellError(t: Tracked, reason: ExitReason, error: unknown, manual: boolean): Position | null {
    const message = errorMessage(error);
    const mint = t.position.mint;
    this.repo.insertTrade({
      positionId: t.position.id,
      mint,
      side: 'sell',
      mode: t.position.mode,
      success: false,
      solAmount: 0,
      tokenAmount: t.position.tokenAmount,
      price: null,
      signature: (error as { signature?: string | null }).signature ?? null,
      error: message,
      latencyMs: null,
      createdAt: Date.now(),
    });

    if (error instanceof NothingToSellError) {
      // Tokens are gone (sold manually elsewhere?) – close the position as a full loss.
      const closed = this.repo.closePosition(t.position.id, {
        status: 'closed',
        solReceived: 0,
        pnlSol: -t.position.solSpent,
        pnlPercent: -100,
        exitReason: reason,
        error: message,
        closedAt: Date.now(),
      });
      this.untrack(mint);
      this.emit('closed', closed);
      return closed;
    }

    t.sellFailures++;
    t.nextSellAttemptAt = Date.now() + this.cfg.strategy.sellRetryDelayMs * Math.min(t.sellFailures, 5);
    this.repo.setPositionError(t.position.id, message);
    t.position = { ...t.position, error: message };
    this.log.error({ mint, reason, attempt: t.sellFailures, err: message }, 'Sell failed – will retry');
    if (t.sellFailures === 3 || manual) this.notifier.error(`Sell ${t.position.symbol} failed (attempt ${t.sellFailures})`, error);
    return null;
  }

  private async markMigrated(t: Tracked): Promise<void> {
    if (!this.tracked.has(t.position.mint)) return;
    const closed = this.repo.closePosition(t.position.id, {
      status: 'migrated',
      exitPrice: t.priceSol,
      exitReason: 'curve_complete',
      error: 'Bonding curve completed – coin migrated to PumpSwap. Sell it manually there.',
      closedAt: Date.now(),
    });
    this.untrack(t.position.mint);
    this.log.warn({ mint: t.position.mint, symbol: t.position.symbol }, 'Bonding curve completed – position must be sold on PumpSwap');
    this.notifier.info(`${t.position.symbol} graduated to PumpSwap 🎓 – sell ${t.position.mint} manually.`);
    this.emit('closed', closed);
  }

  private untrack(mint: string): void {
    this.tracked.delete(mint);
    this.prices.unpin(mint);
  }
}
