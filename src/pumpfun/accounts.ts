import { PublicKey } from '@solana/web3.js';
import { BorshReader, pubkeyOrNull } from './borsh';
import { DISCRIMINATORS } from './constants';
import type { BondingCurveState } from '../types';

/** Decodes a Pump.fun `BondingCurve` account. Returns `null` if the data is not a bonding curve. */
export function decodeBondingCurve(data: Buffer): BondingCurveState | null {
  if (data.length < 8 + 41 || !data.subarray(0, 8).equals(DISCRIMINATORS.bondingCurve)) return null;
  const r = new BorshReader(data.subarray(8));
  const virtualTokenReserves = r.u64();
  const virtualQuoteReserves = r.u64();
  const realTokenReserves = r.u64();
  const realQuoteReserves = r.u64();
  const tokenTotalSupply = r.u64();
  const complete = r.bool();
  const creator = r.remaining >= 32 ? pubkeyOrNull(r.pubkey()) : null;
  const isMayhemMode = r.optional(() => r.bool(), false);
  const isCashbackCoin = r.optional(() => r.bool(), false);
  const quoteMint = r.remaining >= 32 ? pubkeyOrNull(r.pubkey()) : null;
  return {
    virtualTokenReserves,
    virtualQuoteReserves,
    realTokenReserves,
    realQuoteReserves,
    tokenTotalSupply,
    complete,
    creator,
    isMayhemMode,
    isCashbackCoin,
    quoteMint,
  };
}

export interface GlobalState {
  feeBasisPoints: bigint;
  creatorFeeBasisPoints: bigint;
  /** Fee recipients for regular coins (`fee_recipient` + `fee_recipients`). */
  feeRecipients: PublicKey[];
  /** Fee recipients for mayhem-mode coins (`reserved_fee_recipient` + `reserved_fee_recipients`). */
  reservedFeeRecipients: PublicKey[];
  buybackFeeRecipients: PublicKey[];
}

const nonDefault = (keys: PublicKey[]) => keys.filter((k) => !k.equals(PublicKey.default));

/** Decodes the Pump.fun `Global` config account (only the fields the bot needs). */
export function decodeGlobal(data: Buffer): GlobalState | null {
  if (data.length < 8 || !data.subarray(0, 8).equals(DISCRIMINATORS.global)) return null;
  try {
    const r = new BorshReader(data.subarray(8));
    r.bool(); // initialized
    r.pubkey(); // authority
    const feeRecipient = r.pubkey();
    r.u64(); // initial_virtual_token_reserves
    r.u64(); // initial_virtual_sol_reserves
    r.u64(); // initial_real_token_reserves
    r.u64(); // token_total_supply
    const feeBasisPoints = r.u64();
    r.pubkey(); // withdraw_authority
    r.bool(); // enable_migrate
    r.u64(); // pool_migration_fee
    const creatorFeeBasisPoints = r.u64();
    const feeRecipients = Array.from({ length: 7 }, () => r.pubkey());
    r.pubkey(); // set_creator_authority
    r.pubkey(); // admin_set_creator_authority
    r.bool(); // create_v2_enabled
    r.pubkey(); // whitelist_pda
    const reservedFeeRecipient = r.pubkey();
    r.bool(); // mayhem_mode_enabled
    const reservedFeeRecipients = Array.from({ length: 7 }, () => r.pubkey());
    r.bool(); // is_cashback_enabled
    const buybackFeeRecipients = Array.from({ length: 8 }, () => r.pubkey());
    return {
      feeBasisPoints,
      creatorFeeBasisPoints,
      feeRecipients: nonDefault([feeRecipient, ...feeRecipients]),
      reservedFeeRecipients: nonDefault([reservedFeeRecipient, ...reservedFeeRecipients]),
      buybackFeeRecipients: nonDefault(buybackFeeRecipients),
    };
  } catch {
    return null;
  }
}
