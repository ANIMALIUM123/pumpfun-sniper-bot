import { PublicKey } from '@solana/web3.js';
import type { AppConfig } from '../config';
import type { Notifier } from '../alerts/notifier';
import type { Repository } from '../database/repository';
import type { PriceTracker } from '../indexer/priceTracker';
import { NATIVE_MINT, lamportsToSol, tokenUnitsToUi } from '../pumpfun';
import type { DetectedToken } from '../types';
import { errorMessage } from '../utils/async';
import { getLogger } from '../utils/logger';
import type { PositionManager } from './positionManager';
import type { Trader } from './trader';

export type SkipReason =
  | 'paused'
  | 'non_sol_quote'
  | 'mayhem_mode'
  | 'too_old'
  | 'dev_buy_too_large'
  | 'max_positions'
  | 'already_holding'
  | 'low_balance';

export interface SniperStats {
  paused: boolean;
  tokensSeen: number;
  buysAttempted: number;
  buysSucceeded: number;
  buysFailed: number;
  inFlight: number;
  skipped: Partial<Record<SkipReason, number>>;
  lastBuyAt: number | null;
}

/** Decides whether to buy each detected token and executes the buy. */
export class Sniper {
  private readonly log = getLogger('sniper');
  private readonly inFlight = new Set<string>();
  private paused: boolean;
  private readonly stats: Omit<SniperStats, 'paused' | 'inFlight'> = {
    tokensSeen: 0,
    buysAttempted: 0,
    buysSucceeded: 0,
    buysFailed: 0,
    skipped: {},
    lastBuyAt: null,
  };

  constructor(
    private readonly repo: Repository,
    private readonly trader: Trader,
    private readonly positions: PositionManager,
    private readonly prices: PriceTracker,
    private readonly notifier: Notifier,
    private readonly cfg: AppConfig['trading'],
  ) {
    this.paused = !cfg.autoBuy;
  }

  pause(): void {
    this.paused = true;
    this.log.warn('Auto-buy paused');
  }

  resume(): void {
    this.paused = false;
    this.log.info('Auto-buy resumed');
  }

  isPaused(): boolean {
    return this.paused;
  }

  getStats(): SniperStats {
    return { ...this.stats, skipped: { ...this.stats.skipped }, paused: this.paused, inFlight: this.inFlight.size };
  }

  /** Entry point for every token detected by the indexer. */
  async onToken(token: DetectedToken): Promise<void> {
    this.stats.tokensSeen++;
    try {
      this.repo.insertToken(token);
    } catch (error) {
      this.log.error({ mint: token.mint, err: errorMessage(error) }, 'Failed to store token');
    }
    this.prices.trackNewToken(token);
    this.notifier.tokenDetected(token);
    this.log.info(
      {
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        mcapSol: token.marketCapSol.toFixed(2),
        devBuySol: lamportsToSol(token.devBuySol).toFixed(3),
        latencyMs: token.detectedAt - token.timestamp * 1000,
      },
      'New token detected',
    );

    const skip = this.shouldSkip(token);
    if (skip) {
      this.stats.skipped[skip] = (this.stats.skipped[skip] ?? 0) + 1;
      this.log.debug({ mint: token.mint, reason: skip }, 'Skipping token');
      return;
    }
    await this.buy(token);
  }

  shouldSkip(token: DetectedToken, now = Date.now()): SkipReason | null {
    if (this.paused) return 'paused';
    if (token.quoteMint !== null && token.quoteMint !== NATIVE_MINT.toBase58()) return 'non_sol_quote';
    if (this.cfg.skipMayhemTokens && token.isMayhemMode) return 'mayhem_mode';
    if (now - token.timestamp * 1000 > this.cfg.maxTokenAgeSeconds * 1000) return 'too_old';
    if (this.cfg.maxDevBuySol > 0 && lamportsToSol(token.devBuySol) > this.cfg.maxDevBuySol) return 'dev_buy_too_large';
    if (this.positions.has(token.mint) || this.inFlight.has(token.mint)) return 'already_holding';
    if (this.positions.openCount + this.inFlight.size >= this.cfg.maxOpenPositions) return 'max_positions';
    const balance = this.trader.cachedBalanceSol();
    if (balance !== null && balance - this.cfg.buyAmountSol < this.cfg.minWalletBalanceSol) return 'low_balance';
    return null;
  }

  private async buy(token: DetectedToken): Promise<void> {
    this.inFlight.add(token.mint);
    this.stats.buysAttempted++;
    const startedAt = Date.now();
    try {
      const result = await this.trader.buy({
        mint: new PublicKey(token.mint),
        creator: new PublicKey(token.creator),
        tokenProgram: new PublicKey(token.tokenProgram),
        isMayhemMode: token.isMayhemMode,
        reserves: token.reserves,
      });
      const tokensUi = tokenUnitsToUi(result.tokenAmount);
      const entryPrice = tokensUi > 0 ? result.solSpent / tokensUi : 0;
      const position = this.repo.createPosition({
        mint: token.mint,
        name: token.name,
        symbol: token.symbol,
        mode: this.trader.mode,
        tokenProgram: token.tokenProgram,
        creator: token.creator,
        solSpent: result.solSpent,
        tokenAmount: result.tokenAmount,
        entryPrice,
        buySignature: result.signature,
        openedAt: Date.now(),
      });
      const totalLatency = Date.now() - token.detectedAt;
      this.repo.insertTrade({
        positionId: position.id,
        mint: token.mint,
        side: 'buy',
        mode: this.trader.mode,
        success: true,
        solAmount: result.solSpent,
        tokenAmount: result.tokenAmount,
        price: entryPrice,
        signature: result.signature,
        error: null,
        latencyMs: totalLatency,
        createdAt: Date.now(),
      });
      this.positions.add(position, {
        reserves: token.reserves,
        creator: token.creator,
        isMayhemMode: token.isMayhemMode,
        tokenTotalSupply: token.tokenTotalSupply,
      });
      this.stats.buysSucceeded++;
      this.stats.lastBuyAt = Date.now();
      this.log.info(
        {
          mint: token.mint,
          symbol: token.symbol,
          solSpent: result.solSpent.toFixed(5),
          tokens: tokensUi.toFixed(0),
          signature: result.signature,
          latencyMs: totalLatency,
          execMs: Date.now() - startedAt,
        },
        'Bought token',
      );
      this.notifier.bought(position, totalLatency);
    } catch (error) {
      this.stats.buysFailed++;
      const message = errorMessage(error);
      const signature = (error as { signature?: string | null }).signature ?? null;
      this.log.error({ mint: token.mint, symbol: token.symbol, err: message }, 'Buy failed');
      try {
        const failed = this.repo.createFailedPosition({
          mint: token.mint,
          name: token.name,
          symbol: token.symbol,
          mode: this.trader.mode,
          tokenProgram: token.tokenProgram,
          creator: token.creator,
          buySignature: signature,
          openedAt: Date.now(),
          error: message,
        });
        this.repo.insertTrade({
          positionId: failed.id,
          mint: token.mint,
          side: 'buy',
          mode: this.trader.mode,
          success: false,
          solAmount: 0, // nothing was spent (only the network fee, if the tx landed and reverted)
          tokenAmount: 0n,
          price: null,
          signature,
          error: message,
          latencyMs: Date.now() - token.detectedAt,
          createdAt: Date.now(),
        });
      } catch (dbError) {
        this.log.error({ err: errorMessage(dbError) }, 'Failed to record failed buy');
      }
      this.notifier.error(`Buy ${token.symbol} failed`, error);
    } finally {
      this.inFlight.delete(token.mint);
    }
  }
}
