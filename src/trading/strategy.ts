import type { AppConfig } from '../config';
import type { ExitReason } from '../types';

export type StrategyConfig = Pick<
  AppConfig['strategy'],
  'takeProfitPercent' | 'stopLossPercent' | 'trailingStopPercent' | 'minGainPercent' | 'noGainExitSeconds' | 'maxHoldSeconds'
>;

export interface ExitInput {
  /** SOL spent to open the position. */
  costSol: number;
  /** Estimated SOL we would receive if we sold everything now (after fees). */
  valueSol: number;
  /** Highest `valueSol` observed while holding. */
  highestValueSol: number;
  openedAt: number;
  now: number;
}

export interface ExitDecision {
  exit: boolean;
  reason?: ExitReason;
  pnlPercent: number;
  peakPnlPercent: number;
}

const pct = (value: number, cost: number) => (cost > 0 ? (value / cost - 1) * 100 : 0);
/** Tolerance for floating point noise so that e.g. exactly −10% triggers a 10% stop loss. */
const EPS = 1e-9;

/**
 * "Buy at launch, ride the pump, bail out fast if it doesn't move."
 *
 * Rules, evaluated in order:
 *  1. take_profit     – PnL ≥ +TAKE_PROFIT_PERCENT
 *  2. stop_loss       – PnL ≤ −STOP_LOSS_PERCENT
 *  3. trailing_stop   – once peak PnL ≥ MIN_GAIN_PERCENT, exit if value drops TRAILING_STOP_PERCENT from the peak
 *  4. no_gain_timeout – after NO_GAIN_EXIT_SECONDS, exit if PnL is still below MIN_GAIN_PERCENT
 *  5. max_hold_time   – always exit after MAX_HOLD_SECONDS
 */
export function evaluateExit(input: ExitInput, s: StrategyConfig): ExitDecision {
  const pnlPercent = pct(input.valueSol, input.costSol);
  const peakPnlPercent = pct(Math.max(input.highestValueSol, input.valueSol), input.costSol);
  const heldSeconds = (input.now - input.openedAt) / 1000;
  const decision = (reason?: ExitReason): ExitDecision => ({ exit: reason !== undefined, reason, pnlPercent, peakPnlPercent });

  if (pnlPercent >= s.takeProfitPercent - EPS) return decision('take_profit');
  if (pnlPercent <= -s.stopLossPercent + EPS) return decision('stop_loss');

  if (s.trailingStopPercent > 0 && peakPnlPercent >= s.minGainPercent) {
    const peak = Math.max(input.highestValueSol, input.valueSol);
    const drawdown = peak > 0 ? (1 - input.valueSol / peak) * 100 : 0;
    if (drawdown >= s.trailingStopPercent - EPS) return decision('trailing_stop');
  }

  if (s.noGainExitSeconds > 0 && heldSeconds >= s.noGainExitSeconds && pnlPercent < s.minGainPercent) {
    return decision('no_gain_timeout');
  }
  if (heldSeconds >= s.maxHoldSeconds) return decision('max_hold_time');
  return decision();
}
