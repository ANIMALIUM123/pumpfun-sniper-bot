import { BorshReader, DecodeError, pubkeyOrNull } from './borsh';
import { DISCRIMINATORS, PUMP_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants';
import type { CreateEventData, PumpEvent, TradeEventData } from '../types';

const PUMP_ID = PUMP_PROGRAM_ID.toBase58();
const PROGRAM_DATA_PREFIX = 'Program data: ';
const INVOKE_RE = /^Program (\w+) invoke \[\d+\]$/;
const EXIT_RE = /^Program (\w+) (success|failed)/;

function decodeCreateEvent(r: BorshReader): CreateEventData {
  const name = r.string(1_000);
  const symbol = r.string(1_000);
  const uri = r.string(2_000);
  const mint = r.pubkey().toBase58();
  const bondingCurve = r.pubkey().toBase58();
  const user = r.pubkey().toBase58();
  const creator = r.pubkey().toBase58();
  const timestamp = Number(r.i64());
  const virtualTokenReserves = r.u64();
  const virtualSolReserves = r.u64();
  const realTokenReserves = r.u64();
  // Trailing fields were appended over time; tolerate older/shorter layouts.
  const tokenTotalSupply = r.optional(() => r.u64(), 1_000_000_000_000_000n);
  const tokenProgram = r.optional(() => r.pubkey().toBase58(), TOKEN_PROGRAM_ID.toBase58());
  const isMayhemMode = r.optional(() => r.bool(), false);
  const isCashbackEnabled = r.optional(() => r.bool(), false);
  const quoteMint = r.optional(() => pubkeyOrNull(r.pubkey()), null);
  r.optional(() => r.u64(), 0n); // virtual_quote_reserves
  r.optional(() => r.u64(), 0n); // creator_fee_bps
  const isHolderReward = r.optional(() => r.bool(), false);

  return {
    name,
    symbol,
    uri,
    mint,
    bondingCurve,
    user,
    creator,
    timestamp,
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    tokenTotalSupply,
    tokenProgram,
    isMayhemMode,
    isCashbackEnabled,
    quoteMint,
    isHolderReward,
  };
}

function decodeTradeEvent(r: BorshReader): TradeEventData {
  // Only the stable prefix of the (long and growing) TradeEvent is needed.
  return {
    mint: r.pubkey().toBase58(),
    solAmount: r.u64(),
    tokenAmount: r.u64(),
    isBuy: r.bool(),
    user: r.pubkey().toBase58(),
    timestamp: Number(r.i64()),
    virtualSolReserves: r.u64(),
    virtualTokenReserves: r.u64(),
    realSolReserves: r.u64(),
    realTokenReserves: r.u64(),
  };
}

/**
 * Decodes an Anchor event payload (`discriminator || borsh(event)`).
 * Returns `null` for unknown or malformed events.
 */
export function decodeEventData(data: Buffer): PumpEvent | null {
  if (data.length < 8) return null;
  const disc = data.subarray(0, 8);
  const reader = new BorshReader(data.subarray(8));
  try {
    if (disc.equals(DISCRIMINATORS.createEvent)) return { type: 'create', data: decodeCreateEvent(reader) };
    if (disc.equals(DISCRIMINATORS.tradeEvent)) return { type: 'trade', data: decodeTradeEvent(reader) };
  } catch (error) {
    if (error instanceof DecodeError) return null;
    throw error;
  }
  return null;
}

/** Decodes the data of a self-CPI event instruction (`emit_cpi!`), as found in inner instructions. */
export function decodeEventCpiData(data: Buffer): PumpEvent | null {
  if (data.length < 16 || !data.subarray(0, 8).equals(DISCRIMINATORS.eventCpiTag)) return null;
  return decodeEventData(data.subarray(8));
}

/**
 * Extracts Pump.fun events from transaction logs.
 *
 * Tracks the program invocation stack so that only `Program data:` lines emitted by
 * the Pump program itself are decoded (other programs in the same transaction can
 * emit arbitrary data).
 */
export function parsePumpLogs(logs: readonly string[]): PumpEvent[] {
  const events: PumpEvent[] = [];
  const stack: string[] = [];

  for (const line of logs) {
    const invoke = INVOKE_RE.exec(line);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    if (EXIT_RE.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith(PROGRAM_DATA_PREFIX) && stack[stack.length - 1] === PUMP_ID) {
      const payload = line.slice(PROGRAM_DATA_PREFIX.length).split(' ')[0];
      let buf: Buffer;
      try {
        buf = Buffer.from(payload, 'base64');
      } catch {
        continue;
      }
      const event = decodeEventData(buf);
      if (event) events.push(event);
    }
  }
  return events;
}

/** True when the logs show a Pump.fun coin-creation instruction (legacy `create` or `create_v2`). */
export function logsContainCreate(logs: readonly string[]): boolean {
  return logs.some((l) => l === 'Program log: Instruction: Create' || l === 'Program log: Instruction: CreateV2');
}
