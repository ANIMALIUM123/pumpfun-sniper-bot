import { Keypair, PublicKey } from '@solana/web3.js';
import { loadConfig, type AppConfig } from '../src/config';
import { DISCRIMINATORS, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, PUMP_PROGRAM_ID } from '../src/pumpfun';
import type { CreateEventData, DetectedToken, TradeEventData } from '../src/types';

/** Minimal borsh encoder used to build fixtures. */
export class Enc {
  private readonly parts: Buffer[] = [];
  raw(b: Buffer) {
    this.parts.push(Buffer.from(b));
    return this;
  }
  u8(v: number) {
    this.parts.push(Buffer.from([v]));
    return this;
  }
  bool(v: boolean) {
    return this.u8(v ? 1 : 0);
  }
  u64(v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    this.parts.push(b);
    return this;
  }
  i64(v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    this.parts.push(b);
    return this;
  }
  string(s: string) {
    const bytes = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length);
    this.parts.push(len, bytes);
    return this;
  }
  pubkey(k: PublicKey | string) {
    this.parts.push(new PublicKey(k).toBuffer());
    return this;
  }
  buf() {
    return Buffer.concat(this.parts);
  }
}

export const randomKey = () => Keypair.generate().publicKey;

export function makeCreateEvent(overrides: Partial<CreateEventData> = {}): CreateEventData {
  const mint = randomKey().toBase58();
  return {
    name: 'Test Coin',
    symbol: 'TEST',
    uri: 'https://example.com/meta.json',
    mint,
    bondingCurve: randomKey().toBase58(),
    user: randomKey().toBase58(),
    creator: randomKey().toBase58(),
    timestamp: Math.floor(Date.now() / 1000),
    virtualTokenReserves: 1_073_000_000_000_000n,
    virtualSolReserves: 30_000_000_000n,
    realTokenReserves: 793_100_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    isMayhemMode: false,
    isCashbackEnabled: false,
    quoteMint: NATIVE_MINT.toBase58(),
    isHolderReward: false,
    ...overrides,
  };
}

export function encodeCreateEvent(e: CreateEventData): Buffer {
  return new Enc()
    .raw(DISCRIMINATORS.createEvent)
    .string(e.name)
    .string(e.symbol)
    .string(e.uri)
    .pubkey(e.mint)
    .pubkey(e.bondingCurve)
    .pubkey(e.user)
    .pubkey(e.creator)
    .i64(BigInt(e.timestamp))
    .u64(e.virtualTokenReserves)
    .u64(e.virtualSolReserves)
    .u64(e.realTokenReserves)
    .u64(e.tokenTotalSupply)
    .pubkey(e.tokenProgram)
    .bool(e.isMayhemMode)
    .bool(e.isCashbackEnabled)
    .pubkey(e.quoteMint ?? PublicKey.default)
    .u64(e.virtualSolReserves)
    .u64(30n)
    .bool(e.isHolderReward)
    .buf();
}

export function makeTradeEvent(overrides: Partial<TradeEventData> = {}): TradeEventData {
  return {
    mint: randomKey().toBase58(),
    solAmount: 1_000_000_000n,
    tokenAmount: 34_000_000_000_000n,
    isBuy: true,
    user: randomKey().toBase58(),
    timestamp: Math.floor(Date.now() / 1000),
    virtualSolReserves: 31_000_000_000n,
    virtualTokenReserves: 1_039_000_000_000_000n,
    realSolReserves: 1_000_000_000n,
    realTokenReserves: 759_100_000_000_000n,
    ...overrides,
  };
}

export function encodeTradeEvent(e: TradeEventData): Buffer {
  return (
    new Enc()
      .raw(DISCRIMINATORS.tradeEvent)
      .pubkey(e.mint)
      .u64(e.solAmount)
      .u64(e.tokenAmount)
      .bool(e.isBuy)
      .pubkey(e.user)
      .i64(BigInt(e.timestamp))
      .u64(e.virtualSolReserves)
      .u64(e.virtualTokenReserves)
      .u64(e.realSolReserves)
      .u64(e.realTokenReserves)
      // trailing fields the decoder ignores (fee_recipient, fee_basis_points, ...)
      .pubkey(randomKey())
      .u64(95n)
      .buf()
  );
}

export function encodeBondingCurve(opts: {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply?: bigint;
  complete?: boolean;
  creator?: PublicKey;
}): Buffer {
  return new Enc()
    .raw(DISCRIMINATORS.bondingCurve)
    .u64(opts.virtualTokenReserves)
    .u64(opts.virtualSolReserves)
    .u64(opts.realTokenReserves)
    .u64(opts.realSolReserves)
    .u64(opts.tokenTotalSupply ?? 1_000_000_000_000_000n)
    .bool(opts.complete ?? false)
    .pubkey(opts.creator ?? randomKey())
    .bool(false)
    .bool(false)
    .pubkey(NATIVE_MINT)
    .buf();
}

/** Logs as produced by a `create_v2` transaction that also includes the dev buy. */
export function createTxLogs(create: CreateEventData, devBuy?: TradeEventData): string[] {
  const pump = PUMP_PROGRAM_ID.toBase58();
  const logs = [
    'Program ComputeBudget111111111111111111111111111111 invoke [1]',
    'Program ComputeBudget111111111111111111111111111111 success',
    `Program ${pump} invoke [1]`,
    'Program log: Instruction: CreateV2',
    `Program data: ${encodeCreateEvent(create).toString('base64')}`,
    `Program ${pump} consumed 120000 of 200000 compute units`,
    `Program ${pump} success`,
  ];
  if (devBuy) {
    logs.push(
      `Program ${pump} invoke [1]`,
      'Program log: Instruction: BuyExactQuoteInV2',
      `Program data: ${encodeTradeEvent(devBuy).toString('base64')}`,
      `Program ${pump} success`,
    );
  }
  return logs;
}

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ DATABASE_PATH: ':memory:', ...env });
}

export function makeDetectedToken(overrides: Partial<DetectedToken> = {}): DetectedToken {
  const create = makeCreateEvent();
  return {
    ...create,
    signature: 'sig' + Math.random().toString(36).slice(2),
    slot: 1,
    detectedAt: Date.now(),
    reserves: {
      virtualSolReserves: create.virtualSolReserves,
      virtualTokenReserves: create.virtualTokenReserves,
      realSolReserves: 0n,
      realTokenReserves: create.realTokenReserves,
    },
    devBuySol: 0n,
    priceSol: 0.000000028,
    marketCapSol: 28,
    ...overrides,
  };
}
