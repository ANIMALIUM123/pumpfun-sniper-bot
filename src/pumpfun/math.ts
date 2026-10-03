import { INITIAL_REAL_TOKEN_RESERVES, LAMPORTS_PER_SOL, TOKEN_DECIMALS } from './constants';
import type { CurveReserves } from '../types';

const TOKEN_UNIT = 10 ** TOKEN_DECIMALS;
const BPS = 10_000n;

export const lamportsToSol = (lamports: bigint | number): number => Number(lamports) / LAMPORTS_PER_SOL;

export const solToLamports = (sol: number): bigint => BigInt(Math.round(sol * LAMPORTS_PER_SOL));

export const tokenUnitsToUi = (amount: bigint): number => Number(amount) / TOKEN_UNIT;

/** Spot price in SOL per whole token, from virtual reserves. */
export function priceSolPerToken(virtualSolReserves: bigint, virtualTokenReserves: bigint): number {
  if (virtualTokenReserves === 0n) return 0;
  return lamportsToSol(virtualSolReserves) / tokenUnitsToUi(virtualTokenReserves);
}

/** Fully diluted market cap in SOL. */
export function marketCapSol(price: number, tokenTotalSupply: bigint): number {
  return price * tokenUnitsToUi(tokenTotalSupply);
}

/** Bonding-curve completion (0-100%). Pump.fun migrates the coin once it reaches 100%. */
export function bondingCurveProgress(realTokenReserves: bigint): number {
  if (realTokenReserves >= INITIAL_REAL_TOKEN_RESERVES) return 0;
  return Number(((INITIAL_REAL_TOKEN_RESERVES - realTokenReserves) * 10_000n) / INITIAL_REAL_TOKEN_RESERVES) / 100;
}

export const percentToBps = (percent: number): bigint => BigInt(Math.round(percent * 100));

/** Removes fees from a gross SOL input: `net = gross * 10000 / (10000 + feeBps)`. */
export function netOfBuyFees(grossLamports: bigint, feeBps: bigint): bigint {
  return (grossLamports * BPS) / (BPS + feeBps);
}

/** Tokens received for `solIn` lamports (already net of fees) on a constant-product curve. */
export function tokensOutForSolIn(reserves: Pick<CurveReserves, 'virtualSolReserves' | 'virtualTokenReserves' | 'realTokenReserves'>, solIn: bigint): bigint {
  if (solIn <= 0n) return 0n;
  const out = (reserves.virtualTokenReserves * solIn) / (reserves.virtualSolReserves + solIn);
  return out < reserves.realTokenReserves ? out : reserves.realTokenReserves;
}

/** Gross SOL (lamports, before fees) returned for selling `tokensIn` on a constant-product curve. */
export function solOutForTokensIn(reserves: Pick<CurveReserves, 'virtualSolReserves' | 'virtualTokenReserves'>, tokensIn: bigint): bigint {
  if (tokensIn <= 0n) return 0n;
  return (reserves.virtualSolReserves * tokensIn) / (reserves.virtualTokenReserves + tokensIn);
}

/** Applies a percentage haircut (fees or slippage) to an amount. */
export function applyPercentDown(amount: bigint, percent: number): bigint {
  const bps = percentToBps(percent);
  if (bps >= BPS) return 0n;
  return (amount * (BPS - bps)) / BPS;
}

/**
 * Estimated SOL (lamports) we would receive if we sold `tokenAmount` right now,
 * after fees. Used as the position's liquidation value for PnL decisions.
 */
export function estimateSellProceeds(reserves: CurveReserves, tokenAmount: bigint, feePercent: number): bigint {
  return applyPercentDown(solOutForTokensIn(reserves, tokenAmount), feePercent);
}
