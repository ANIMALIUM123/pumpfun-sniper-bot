import type { Repository } from '../database/repository';
import { NATIVE_MINT, bondingCurveProgress, marketCapSol, priceSolPerToken } from '../pumpfun';
import type { CurveReserves, DetectedToken, PriceTick, TradeEventData } from '../types';
import { errorMessage } from '../utils/async';
import { getLogger } from '../utils/logger';

export interface TrackedPrice {
  mint: string;
  priceSol: number;
  marketCapSol: number;
  curveProgress: number;
  reserves: CurveReserves;
  tokenTotalSupply: bigint;
  updatedAt: number;
  source: PriceTick['source'];
}

interface Entry extends TrackedPrice {
  trackUntil: number;
  pinned: boolean;
  lastPersistedAt: number;
}

export interface PriceTrackerOptions {
  /** How long a freshly detected token keeps being tracked (seconds). 0 disables. */
  trackNewTokensSeconds: number;
  maxTrackedTokens: number;
  /** Minimum interval between persisted ticks per token (ms). */
  tickIntervalMs: number;
}

/**
 * Keeps the latest price of recently launched tokens and open positions, fed for free by the
 * indexer's trade stream (plus RPC polling for positions). Ticks are persisted with a per-token
 * throttle to keep the database small.
 */
export class PriceTracker {
  private readonly log = getLogger('prices');
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly repo: Repository,
    private readonly opts: PriceTrackerOptions,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** Starts tracking a freshly detected token for `trackNewTokensSeconds`. */
  trackNewToken(token: DetectedToken): void {
    const solPaired = token.quoteMint === null || token.quoteMint === NATIVE_MINT.toBase58();
    if (this.opts.trackNewTokensSeconds <= 0 || !solPaired) return;
    this.upsert(token.mint, token.reserves, token.tokenTotalSupply, 'stream', {
      trackUntil: token.detectedAt + this.opts.trackNewTokensSeconds * 1000,
    });
  }

  /** Tracks a token for as long as we hold it. */
  pin(mint: string, reserves: CurveReserves, tokenTotalSupply: bigint): void {
    this.upsert(mint, reserves, tokenTotalSupply, 'poll', { pinned: true });
  }

  unpin(mint: string): void {
    const e = this.entries.get(mint);
    if (e) e.pinned = false;
  }

  /** Updates price from a trade event. Returns the new price if the mint is tracked. */
  onTrade(trade: TradeEventData): TrackedPrice | undefined {
    const e = this.entries.get(trade.mint);
    if (!e) return undefined;
    return this.update(e, {
      virtualSolReserves: trade.virtualSolReserves,
      virtualTokenReserves: trade.virtualTokenReserves,
      realSolReserves: trade.realSolReserves,
      realTokenReserves: trade.realTokenReserves,
    }, 'stream');
  }

  /** Updates price from a polled bonding-curve account. */
  onCurve(mint: string, reserves: CurveReserves, tokenTotalSupply: bigint): TrackedPrice {
    const e = this.entries.get(mint);
    if (!e) return this.upsert(mint, reserves, tokenTotalSupply, 'poll', {});
    e.tokenTotalSupply = tokenTotalSupply;
    return this.update(e, reserves, 'poll');
  }

  get(mint: string): TrackedPrice | undefined {
    const e = this.entries.get(mint);
    return e ? this.view(e) : undefined;
  }

  list(): TrackedPrice[] {
    return [...this.entries.values()].map((e) => this.view(e)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Drops tokens whose tracking window expired. */
  prune(now = Date.now()): void {
    for (const [mint, e] of this.entries) {
      if (!e.pinned && e.trackUntil < now) this.entries.delete(mint);
    }
  }

  private upsert(
    mint: string,
    reserves: CurveReserves,
    tokenTotalSupply: bigint,
    source: PriceTick['source'],
    extra: { trackUntil?: number; pinned?: boolean },
  ): TrackedPrice {
    let e = this.entries.get(mint);
    if (!e) {
      this.evictIfFull();
      e = {
        mint,
        priceSol: 0,
        marketCapSol: 0,
        curveProgress: 0,
        reserves,
        tokenTotalSupply,
        updatedAt: 0,
        source,
        trackUntil: extra.trackUntil ?? 0,
        pinned: extra.pinned ?? false,
        lastPersistedAt: 0,
      };
      this.entries.set(mint, e);
    } else {
      if (extra.trackUntil) e.trackUntil = Math.max(e.trackUntil, extra.trackUntil);
      if (extra.pinned) e.pinned = true;
    }
    return this.update(e, reserves, source);
  }

  private update(e: Entry, reserves: CurveReserves, source: PriceTick['source']): TrackedPrice {
    const now = Date.now();
    e.reserves = reserves;
    e.priceSol = priceSolPerToken(reserves.virtualSolReserves, reserves.virtualTokenReserves);
    e.marketCapSol = marketCapSol(e.priceSol, e.tokenTotalSupply);
    e.curveProgress = bondingCurveProgress(reserves.realTokenReserves);
    e.updatedAt = now;
    e.source = source;

    if (now - e.lastPersistedAt >= this.opts.tickIntervalMs) {
      e.lastPersistedAt = now;
      try {
        this.repo.insertPriceTick({
          mint: e.mint,
          priceSol: e.priceSol,
          marketCapSol: e.marketCapSol,
          ...reserves,
          source,
          recordedAt: now,
        });
        this.repo.updateTokenMarket(e.mint, e.priceSol, e.marketCapSol, reserves.realSolReserves, e.curveProgress, now);
      } catch (error) {
        this.log.warn({ mint: e.mint, err: errorMessage(error) }, 'Failed to persist price tick');
      }
    }
    return this.view(e);
  }

  private evictIfFull(): void {
    if (this.entries.size < this.opts.maxTrackedTokens) return;
    this.prune();
    if (this.entries.size < this.opts.maxTrackedTokens) return;
    for (const [mint, e] of this.entries) {
      if (!e.pinned) {
        this.entries.delete(mint);
        return;
      }
    }
  }

  private view(e: Entry): TrackedPrice {
    return {
      mint: e.mint,
      priceSol: e.priceSol,
      marketCapSol: e.marketCapSol,
      curveProgress: e.curveProgress,
      reserves: e.reserves,
      tokenTotalSupply: e.tokenTotalSupply,
      updatedAt: e.updatedAt,
      source: e.source,
    };
  }
}
