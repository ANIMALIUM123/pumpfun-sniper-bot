import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { BorshWriter } from './borsh';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DISCRIMINATORS,
  NATIVE_MINT,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './constants';
import {
  EVENT_AUTHORITY_PDA,
  FEE_CONFIG_PDA,
  GLOBAL_PDA,
  GLOBAL_VOLUME_ACCUMULATOR_PDA,
  associatedTokenAddress,
  bondingCurvePda,
  creatorVaultPda,
  sharingConfigPda,
  userVolumeAccumulatorPda,
} from './pda';

export interface TradeAccountsParams {
  user: PublicKey;
  mint: PublicKey;
  /** `bonding_curve.creator` – needed for the creator vault PDA. */
  creator: PublicKey;
  /** Token program of the coin mint (Token-2022 for `create_v2` coins, legacy SPL Token otherwise). */
  baseTokenProgram: PublicKey;
  feeRecipient: PublicKey;
  buybackFeeRecipient: PublicKey;
  /** Defaults to wrapped SOL (SOL-paired coins). */
  quoteMint?: PublicKey;
  /** Defaults to the legacy SPL Token program (correct for wrapped SOL). */
  quoteTokenProgram?: PublicKey;
}

const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

/**
 * Shared account list of `buy_v2` / `buy_exact_quote_in_v2` / `sell_v2`.
 * The only difference is that buys include `global_volume_accumulator` right before
 * `user_volume_accumulator`.
 */
function tradeAccounts(p: TradeAccountsParams, side: 'buy' | 'sell'): AccountMeta[] {
  const quoteMint = p.quoteMint ?? NATIVE_MINT;
  const quoteTokenProgram = p.quoteTokenProgram ?? TOKEN_PROGRAM_ID;
  const bondingCurve = bondingCurvePda(p.mint);
  const creatorVault = creatorVaultPda(p.creator);
  const userVolumeAccumulator = userVolumeAccumulatorPda(p.user);
  const ata = (owner: PublicKey, mint: PublicKey, program: PublicKey) => associatedTokenAddress(owner, mint, program);

  const keys: AccountMeta[] = [
    r(GLOBAL_PDA),
    r(p.mint),
    r(quoteMint),
    r(p.baseTokenProgram),
    r(quoteTokenProgram),
    r(ASSOCIATED_TOKEN_PROGRAM_ID),
    w(p.feeRecipient),
    w(ata(p.feeRecipient, quoteMint, quoteTokenProgram)),
    w(p.buybackFeeRecipient),
    w(ata(p.buybackFeeRecipient, quoteMint, quoteTokenProgram)),
    w(bondingCurve),
    w(ata(bondingCurve, p.mint, p.baseTokenProgram)),
    w(ata(bondingCurve, quoteMint, quoteTokenProgram)),
    { pubkey: p.user, isSigner: true, isWritable: true },
    w(ata(p.user, p.mint, p.baseTokenProgram)),
    w(ata(p.user, quoteMint, quoteTokenProgram)),
    w(creatorVault),
    w(ata(creatorVault, quoteMint, quoteTokenProgram)),
    r(sharingConfigPda(p.mint)),
  ];
  if (side === 'buy') keys.push(r(GLOBAL_VOLUME_ACCUMULATOR_PDA));
  keys.push(
    w(userVolumeAccumulator),
    w(ata(userVolumeAccumulator, quoteMint, quoteTokenProgram)),
    r(FEE_CONFIG_PDA),
    r(PUMP_FEE_PROGRAM_ID),
    r(SYSTEM_PROGRAM_ID),
    r(EVENT_AUTHORITY_PDA),
    r(PUMP_PROGRAM_ID),
  );
  return keys;
}

/**
 * `buy_exact_quote_in_v2`: spend exactly `spendableQuoteIn` (fees included) and
 * receive at least `minTokensOut` tokens. Ideal for sniping a fixed SOL amount.
 */
export function buildBuyExactQuoteInV2Instruction(
  p: TradeAccountsParams & { spendableQuoteIn: bigint; minTokensOut: bigint },
): TransactionInstruction {
  const data = new BorshWriter()
    .raw(DISCRIMINATORS.buyExactQuoteInV2)
    .u64(p.spendableQuoteIn)
    .u64(p.minTokensOut)
    .toBuffer();
  return new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys: tradeAccounts(p, 'buy'), data });
}

/** `sell_v2`: sell `amount` tokens for at least `minSolOutput` lamports (after fees). */
export function buildSellV2Instruction(
  p: TradeAccountsParams & { amount: bigint; minSolOutput: bigint },
): TransactionInstruction {
  const data = new BorshWriter().raw(DISCRIMINATORS.sellV2).u64(p.amount).u64(p.minSolOutput).toBuffer();
  return new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys: tradeAccounts(p, 'sell'), data });
}

/** Associated Token Program `CreateIdempotent` – no-op if the account already exists. */
export function buildCreateAtaIdempotentInstruction(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      w(associatedTokenAddress(owner, mint, tokenProgram)),
      r(owner),
      r(mint),
      r(SYSTEM_PROGRAM_ID),
      r(tokenProgram),
    ],
    data: Buffer.from([1]),
  });
}

/** SPL Token / Token-2022 `CloseAccount` – reclaims the rent of an empty token account. */
export function buildCloseAccountInstruction(
  account: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  tokenProgram: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [w(account), w(destination), { pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.from([9]),
  });
}
