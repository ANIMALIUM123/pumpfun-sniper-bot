import { PublicKey } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID } from './constants';

const pda = (seeds: (Buffer | Uint8Array)[], programId: PublicKey = PUMP_PROGRAM_ID): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

const seed = (s: string) => Buffer.from(s, 'utf8');

// Static PDAs are computed once.
export const GLOBAL_PDA = pda([seed('global')]);
export const EVENT_AUTHORITY_PDA = pda([seed('__event_authority')]);
export const GLOBAL_VOLUME_ACCUMULATOR_PDA = pda([seed('global_volume_accumulator')]);
export const FEE_CONFIG_PDA = pda([seed('fee_config'), PUMP_PROGRAM_ID.toBuffer()], PUMP_FEE_PROGRAM_ID);

export const bondingCurvePda = (mint: PublicKey): PublicKey => pda([seed('bonding-curve'), mint.toBuffer()]);

export const creatorVaultPda = (creator: PublicKey): PublicKey => pda([seed('creator-vault'), creator.toBuffer()]);

export const userVolumeAccumulatorPda = (user: PublicKey): PublicKey =>
  pda([seed('user_volume_accumulator'), user.toBuffer()]);

export const sharingConfigPda = (mint: PublicKey): PublicKey =>
  pda([seed('sharing-config'), mint.toBuffer()], PUMP_FEE_PROGRAM_ID);

/** Associated token account address. Works for off-curve (PDA) owners too. */
export const associatedTokenAddress = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey =>
  pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
