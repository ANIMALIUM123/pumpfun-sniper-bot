import crypto from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DISCRIMINATORS,
  EVENT_AUTHORITY_PDA,
  FEE_CONFIG_PDA,
  GLOBAL_PDA,
  GLOBAL_VOLUME_ACCUMULATOR_PDA,
  NATIVE_MINT,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  bondingCurvePda,
  buildBuyExactQuoteInV2Instruction,
  buildCloseAccountInstruction,
  buildCreateAtaIdempotentInstruction,
  buildSellV2Instruction,
  creatorVaultPda,
  decodeBondingCurve,
  decodeEventCpiData,
  decodeEventData,
  decodeGlobal,
  logsContainCreate,
  parsePumpLogs,
  sharingConfigPda,
  userVolumeAccumulatorPda,
} from '../src/pumpfun';
import { Enc, createTxLogs, encodeBondingCurve, encodeCreateEvent, encodeTradeEvent, makeCreateEvent, makeTradeEvent, randomKey } from './helpers';

const sha8 = (s: string) => crypto.createHash('sha256').update(s).digest().subarray(0, 8);

describe('discriminators', () => {
  it('match the Anchor sha256 derivation', () => {
    expect(DISCRIMINATORS.buyExactQuoteInV2).toEqual(sha8('global:buy_exact_quote_in_v2'));
    expect(DISCRIMINATORS.sellV2).toEqual(sha8('global:sell_v2'));
    expect(DISCRIMINATORS.createEvent).toEqual(sha8('event:CreateEvent'));
    expect(DISCRIMINATORS.tradeEvent).toEqual(sha8('event:TradeEvent'));
    expect(DISCRIMINATORS.bondingCurve).toEqual(sha8('account:BondingCurve'));
    expect(DISCRIMINATORS.global).toEqual(sha8('account:Global'));
    expect(DISCRIMINATORS.eventCpiTag).toEqual(Buffer.from(sha8('anchor:event')).reverse());
  });
});

describe('PDAs', () => {
  it('derive the well-known program addresses', () => {
    expect(GLOBAL_PDA.toBase58()).toBe('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
    expect(EVENT_AUTHORITY_PDA.toBase58()).toBe('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  });

  it('derive per-mint / per-user PDAs with the documented seeds', () => {
    const mint = randomKey();
    const user = randomKey();
    const find = (seeds: Buffer[], program = PUMP_PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, program)[0];
    expect(bondingCurvePda(mint)).toEqual(find([Buffer.from('bonding-curve'), mint.toBuffer()]));
    expect(creatorVaultPda(user)).toEqual(find([Buffer.from('creator-vault'), user.toBuffer()]));
    expect(userVolumeAccumulatorPda(user)).toEqual(find([Buffer.from('user_volume_accumulator'), user.toBuffer()]));
    expect(sharingConfigPda(mint)).toEqual(find([Buffer.from('sharing-config'), mint.toBuffer()], PUMP_FEE_PROGRAM_ID));
    expect(FEE_CONFIG_PDA).toEqual(find([Buffer.from('fee_config'), PUMP_PROGRAM_ID.toBuffer()], PUMP_FEE_PROGRAM_ID));
  });

  it('derives associated token addresses', () => {
    const owner = randomKey();
    const mint = randomKey();
    const expected = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )[0];
    expect(associatedTokenAddress(owner, mint, TOKEN_2022_PROGRAM_ID)).toEqual(expected);
  });
});

describe('event decoding', () => {
  it('round-trips a CreateEvent', () => {
    const create = makeCreateEvent({ name: 'Ünïcode 🚀', isMayhemMode: true });
    const decoded = decodeEventData(encodeCreateEvent(create));
    expect(decoded).toEqual({ type: 'create', data: create });
  });

  it('tolerates legacy CreateEvents without trailing fields', () => {
    const create = makeCreateEvent();
    const legacy = new Enc()
      .raw(DISCRIMINATORS.createEvent)
      .string(create.name)
      .string(create.symbol)
      .string(create.uri)
      .pubkey(create.mint)
      .pubkey(create.bondingCurve)
      .pubkey(create.user)
      .pubkey(create.creator)
      .i64(BigInt(create.timestamp))
      .u64(create.virtualTokenReserves)
      .u64(create.virtualSolReserves)
      .u64(create.realTokenReserves)
      .buf();
    const decoded = decodeEventData(legacy);
    expect(decoded?.type).toBe('create');
    if (decoded?.type !== 'create') return;
    expect(decoded.data.tokenProgram).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(decoded.data.isMayhemMode).toBe(false);
    expect(decoded.data.quoteMint).toBeNull();
  });

  it('decodes the TradeEvent prefix', () => {
    const trade = makeTradeEvent({ isBuy: false });
    expect(decodeEventData(encodeTradeEvent(trade))).toEqual({ type: 'trade', data: trade });
  });

  it('returns null for unknown or truncated data', () => {
    expect(decodeEventData(Buffer.alloc(4))).toBeNull();
    expect(decodeEventData(Buffer.alloc(64))).toBeNull();
    expect(decodeEventData(encodeTradeEvent(makeTradeEvent()).subarray(0, 40))).toBeNull();
  });

  it('decodes emit_cpi! inner instruction data', () => {
    const trade = makeTradeEvent();
    const data = Buffer.concat([DISCRIMINATORS.eventCpiTag, encodeTradeEvent(trade)]);
    expect(decodeEventCpiData(data)).toEqual({ type: 'trade', data: trade });
    expect(decodeEventCpiData(encodeTradeEvent(trade))).toBeNull();
  });
});

describe('parsePumpLogs', () => {
  it('extracts create + dev-buy events from a launch transaction', () => {
    const create = makeCreateEvent();
    const buy = makeTradeEvent({ mint: create.mint });
    const logs = createTxLogs(create, buy);
    const events = parsePumpLogs(logs);
    expect(events.map((e) => e.type)).toEqual(['create', 'trade']);
    expect(logsContainCreate(logs)).toBe(true);
  });

  it('ignores Program data emitted by other programs', () => {
    const fake = makeCreateEvent();
    const logs = [
      'Program Evi1111111111111111111111111111111111111111 invoke [1]',
      `Program data: ${encodeCreateEvent(fake).toString('base64')}`,
      'Program Evi1111111111111111111111111111111111111111 success',
    ];
    expect(parsePumpLogs(logs)).toEqual([]);
  });

  it('tracks nested invocations', () => {
    const pump = PUMP_PROGRAM_ID.toBase58();
    const trade = makeTradeEvent();
    const logs = [
      'Program Router1111111111111111111111111111111111 invoke [1]',
      `Program ${pump} invoke [2]`,
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3]',
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
      `Program data: ${encodeTradeEvent(trade).toString('base64')}`,
      `Program ${pump} success`,
      `Program data: ${encodeTradeEvent(makeTradeEvent()).toString('base64')}`,
      'Program Router1111111111111111111111111111111111 success',
    ];
    expect(parsePumpLogs(logs)).toEqual([{ type: 'trade', data: trade }]);
  });
});

describe('account decoding', () => {
  it('decodes a bonding curve', () => {
    const creator = randomKey();
    const data = encodeBondingCurve({
      virtualTokenReserves: 1n,
      virtualSolReserves: 2n,
      realTokenReserves: 3n,
      realSolReserves: 4n,
      complete: true,
      creator,
    });
    expect(decodeBondingCurve(data)).toMatchObject({
      virtualTokenReserves: 1n,
      virtualQuoteReserves: 2n,
      realTokenReserves: 3n,
      realQuoteReserves: 4n,
      complete: true,
      creator: creator.toBase58(),
      quoteMint: NATIVE_MINT.toBase58(),
    });
    expect(decodeBondingCurve(Buffer.alloc(100))).toBeNull();
  });

  it('decodes fee recipients from Global', () => {
    const fee = Array.from({ length: 8 }, () => randomKey());
    const reserved = Array.from({ length: 8 }, () => randomKey());
    const buyback = Array.from({ length: 8 }, () => randomKey());
    const e = new Enc()
      .raw(DISCRIMINATORS.global)
      .bool(true)
      .pubkey(randomKey())
      .pubkey(fee[0])
      .u64(1n)
      .u64(2n)
      .u64(3n)
      .u64(4n)
      .u64(95n)
      .pubkey(randomKey())
      .bool(true)
      .u64(0n)
      .u64(5n);
    fee.slice(1).forEach((k) => e.pubkey(k));
    e.pubkey(randomKey()).pubkey(randomKey()).bool(true).pubkey(randomKey()).pubkey(reserved[0]).bool(true);
    reserved.slice(1).forEach((k) => e.pubkey(k));
    e.bool(false);
    buyback.slice(0, 7).forEach((k) => e.pubkey(k));
    e.pubkey(PublicKey.default); // unused slot is filtered out
    const global = decodeGlobal(e.buf());
    expect(global?.feeBasisPoints).toBe(95n);
    expect(global?.creatorFeeBasisPoints).toBe(5n);
    expect(global?.feeRecipients).toEqual(fee);
    expect(global?.reservedFeeRecipients).toEqual(reserved);
    expect(global?.buybackFeeRecipients).toEqual(buyback.slice(0, 7));
  });
});

describe('instructions', () => {
  const user = Keypair.generate().publicKey;
  const mint = randomKey();
  const creator = randomKey();
  const feeRecipient = randomKey();
  const buybackFeeRecipient = randomKey();
  const base = { user, mint, creator, baseTokenProgram: TOKEN_2022_PROGRAM_ID, feeRecipient, buybackFeeRecipient };
  const ata = (owner: PublicKey, m: PublicKey, program: PublicKey) => associatedTokenAddress(owner, m, program);
  const wsolAta = (owner: PublicKey) => ata(owner, NATIVE_MINT, TOKEN_PROGRAM_ID);

  it('builds buy_exact_quote_in_v2 with the IDL account order', () => {
    const ix = buildBuyExactQuoteInV2Instruction({ ...base, spendableQuoteIn: 10_000_000n, minTokensOut: 123n });
    expect(ix.programId).toEqual(PUMP_PROGRAM_ID);
    expect(ix.data).toEqual(Buffer.concat([DISCRIMINATORS.buyExactQuoteInV2, u64(10_000_000n), u64(123n)]));
    const bc = bondingCurvePda(mint);
    const vault = creatorVaultPda(creator);
    const uva = userVolumeAccumulatorPda(user);
    const expected: [PublicKey, boolean, boolean][] = [
      [GLOBAL_PDA, false, false],
      [mint, false, false],
      [NATIVE_MINT, false, false],
      [TOKEN_2022_PROGRAM_ID, false, false],
      [TOKEN_PROGRAM_ID, false, false],
      [ASSOCIATED_TOKEN_PROGRAM_ID, false, false],
      [feeRecipient, false, true],
      [wsolAta(feeRecipient), false, true],
      [buybackFeeRecipient, false, true],
      [wsolAta(buybackFeeRecipient), false, true],
      [bc, false, true],
      [ata(bc, mint, TOKEN_2022_PROGRAM_ID), false, true],
      [wsolAta(bc), false, true],
      [user, true, true],
      [ata(user, mint, TOKEN_2022_PROGRAM_ID), false, true],
      [wsolAta(user), false, true],
      [vault, false, true],
      [wsolAta(vault), false, true],
      [sharingConfigPda(mint), false, false],
      [GLOBAL_VOLUME_ACCUMULATOR_PDA, false, false],
      [uva, false, true],
      [wsolAta(uva), false, true],
      [FEE_CONFIG_PDA, false, false],
      [PUMP_FEE_PROGRAM_ID, false, false],
      [SYSTEM_PROGRAM_ID, false, false],
      [EVENT_AUTHORITY_PDA, false, false],
      [PUMP_PROGRAM_ID, false, false],
    ];
    expect(ix.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable])).toEqual(expected);
  });

  it('builds sell_v2 without the global volume accumulator', () => {
    const buy = buildBuyExactQuoteInV2Instruction({ ...base, spendableQuoteIn: 1n, minTokensOut: 1n });
    const sell = buildSellV2Instruction({ ...base, amount: 5n, minSolOutput: 6n });
    expect(sell.data).toEqual(Buffer.concat([DISCRIMINATORS.sellV2, u64(5n), u64(6n)]));
    expect(sell.keys).toHaveLength(26);
    expect(sell.keys).toEqual(buy.keys.filter((k) => !k.pubkey.equals(GLOBAL_VOLUME_ACCUMULATOR_PDA)));
  });

  it('builds ATA create-idempotent and close-account instructions', () => {
    const create = buildCreateAtaIdempotentInstruction(user, user, mint, TOKEN_2022_PROGRAM_ID);
    expect(create.programId).toEqual(ASSOCIATED_TOKEN_PROGRAM_ID);
    expect([...create.data]).toEqual([1]);
    expect(create.keys[1].pubkey).toEqual(ata(user, mint, TOKEN_2022_PROGRAM_ID));
    const close = buildCloseAccountInstruction(ata(user, mint, TOKEN_2022_PROGRAM_ID), user, user, TOKEN_2022_PROGRAM_ID);
    expect(close.programId).toEqual(TOKEN_2022_PROGRAM_ID);
    expect([...close.data]).toEqual([9]);
  });
});

function u64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
