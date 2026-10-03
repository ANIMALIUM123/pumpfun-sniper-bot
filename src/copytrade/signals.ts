import type { TokenBalance, VersionedTransactionResponse } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, DISCRIMINATORS, NATIVE_MINT, PUMP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, parsePumpLogs } from '../pumpfun';
import type { TradeEventData } from '../types';

export interface CopySignal {
  wallet: string;
  signature: string;
  slot: number;
  observedAt: number;
  trade: TradeEventData;
  sourcePreBalance: bigint;
}

const SUPPORT = new Set([
  'ComputeBudget111111111111111111111111111111', SYSTEM_PROGRAM_ID.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
]);

/** Only direct, single native-SOL Pump v2 swaps with matching owner deltas are supported.
 * Account indexes/discriminators were checked against the official pump.json IDL.
 */
export function decodeCopySignal(tx: VersionedTransactionResponse | null, wallet: string, signature: string): CopySignal | null {
  try {
    if (!tx?.meta || tx.meta.err || !tx.blockTime || !tx.meta.logMessages) return null;
    const message = tx.transaction.message;
    const keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    let walletIndex = -1;
    for (let i = 0; i < message.header.numRequiredSignatures; i++) {
      if (keys.get(i)?.toBase58() === wallet) walletIndex = i;
    }
    if (walletIndex < 0) return null;
    const instructions = message.compiledInstructions;
    const pump = instructions.filter((ix) => keys.get(ix.programIdIndex)?.equals(PUMP_PROGRAM_ID));
    if (pump.length !== 1 || instructions.some((ix) => {
      const program = keys.get(ix.programIdIndex)?.toBase58();
      return program !== PUMP_PROGRAM_ID.toBase58() && !SUPPORT.has(program ?? '');
    })) return null;
    const events = parsePumpLogs(tx.meta.logMessages).filter((e) => e.type === 'trade');
    if (events.length !== 1) return null;
    const trade = events[0].data;
    const ix = pump[0];
    const data = Buffer.from(ix.data);
    const expected = trade.isBuy ? DISCRIMINATORS.buyExactQuoteInV2 : DISCRIMINATORS.sellV2;
    if (data.length !== 24 || !data.subarray(0, 8).equals(expected)) return null;
    if (trade.user !== wallet || trade.solAmount <= 0n || trade.tokenAmount <= 0n) return null;
    if (keys.get(ix.accountKeyIndexes[1])?.toBase58() !== trade.mint ||
      !keys.get(ix.accountKeyIndexes[2])?.equals(NATIVE_MINT) ||
      keys.get(ix.accountKeyIndexes[13])?.toBase58() !== wallet) return null;
    if (!trade.isBuy && data.readBigUInt64LE(8) !== trade.tokenAmount) return null;
    const sums = (list: TokenBalance[] | null | undefined) => {
      const map = new Map<string, bigint>();
      for (const b of list ?? []) {
        if (b.owner !== wallet || b.mint === NATIVE_MINT.toBase58()) continue;
        if (b.mint === trade.mint && b.uiTokenAmount.decimals !== 6) throw new Error('Unsupported decimals');
        map.set(b.mint, (map.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount.amount));
      }
      return map;
    };
    const pre = sums(tx.meta.preTokenBalances);
    const post = sums(tx.meta.postTokenBalances);
    const changed = [...new Set([...pre.keys(), ...post.keys()])]
      .filter((mint) => (post.get(mint) ?? 0n) !== (pre.get(mint) ?? 0n));
    if (changed.length !== 1 || changed[0] !== trade.mint) return null;
    const delta = (post.get(trade.mint) ?? 0n) - (pre.get(trade.mint) ?? 0n);
    if (delta !== (trade.isBuy ? trade.tokenAmount : -trade.tokenAmount)) return null;
    const solDelta = (tx.meta.postBalances[walletIndex] ?? 0) - (tx.meta.preBalances[walletIndex] ?? 0);
    if (trade.isBuy ? solDelta >= 0 : solDelta <= 0) return null;
    if (trade.virtualSolReserves <= 0n || trade.virtualTokenReserves <= 0n) return null;
    return { wallet, signature, slot: tx.slot, observedAt: tx.blockTime * 1000, trade,
      sourcePreBalance: pre.get(trade.mint) ?? 0n };
  } catch {
    return null;
  }
}

export function fractionalAmount(amount: bigint, sold: bigint, sourceBalance: bigint): bigint {
  if (amount < 0n || sold < 0n || sourceBalance <= 0n) throw new Error('Invalid fractional amounts');
  return amount * (sold > sourceBalance ? sourceBalance : sold) / sourceBalance;
}
