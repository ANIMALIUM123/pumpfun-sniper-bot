import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

const wallet = z.string().refine((s) => {
  try { return PublicKey.isOnCurve(new PublicKey(s).toBytes()); } catch { return false; }
}, 'Invalid source wallet');

export const copySettingsSchema = z.object({
  enabled: z.boolean(),
  wallets: z.array(wallet).max(10).refine((a) => new Set(a).size === a.length, 'Duplicate wallets'),
  execution: z.enum(['paper', 'live']),
  sizing: z.enum(['fixed', 'proportional']),
  fixedSol: z.number().finite().min(0.000001).max(10),
  proportionBps: z.number().int().min(1).max(10_000),
  maxBuySol: z.number().finite().min(0.000001).max(10),
  maxOpenPositions: z.number().int().min(1).max(100),
  maxExposureSol: z.number().finite().positive().max(100),
  maxDailySpendSol: z.number().finite().positive().max(100),
  minSourceSol: z.number().finite().nonnegative().max(100),
  maxSignalAgeSeconds: z.number().int().min(1).max(300),
  copySells: z.boolean(),
}).strict();

export type CopySettings = z.infer<typeof copySettingsSchema>;
export const DEFAULT_COPY_SETTINGS: CopySettings = {
  enabled: false, wallets: [], execution: 'paper', sizing: 'fixed', fixedSol: 0.01,
  proportionBps: 1_000, maxBuySol: 0.05, maxOpenPositions: 3, maxExposureSol: 0.15,
  maxDailySpendSol: 0.5, minSourceSol: 0.001, maxSignalAgeSeconds: 30, copySells: true,
};

export function validateCopySettings(input: unknown, current = DEFAULT_COPY_SETTINGS): CopySettings {
  const patch = copySettingsSchema.partial().parse(input);
  const result = copySettingsSchema.parse({ ...current, ...patch });
  if (result.execution === 'live') throw new Error('Live copy trading is blocked: current Pump execution paths are not mainnet verified');
  return result;
}
