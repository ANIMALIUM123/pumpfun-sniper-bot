/**
 * Shared domain types used across the indexer, trading engine, database and API.
 *
 * Conventions:
 *  - Raw on-chain integer amounts (lamports, token base units, reserves) are `bigint`.
 *  - Human friendly amounts (SOL, prices) are `number`.
 *  - Timestamps are unix epoch milliseconds unless the field name says otherwise.
 */

/** Decoded Pump.fun `CreateEvent` (emitted when a new coin is launched). */
export interface CreateEventData {
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string;
  /** Unix timestamp in seconds (block time). */
  timestamp: number;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  tokenProgram: string;
  isMayhemMode: boolean;
  isCashbackEnabled: boolean;
  /** `null` means the coin is paired with native SOL. */
  quoteMint: string | null;
  isHolderReward: boolean;
}

/** Decoded Pump.fun `TradeEvent` (emitted on every bonding-curve buy/sell). */
export interface TradeEventData {
  mint: string;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: string;
  /** Unix timestamp in seconds (block time). */
  timestamp: number;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
}

export type PumpEvent =
  | { type: 'create'; data: CreateEventData }
  | { type: 'trade'; data: TradeEventData };

/** Decoded Pump.fun `BondingCurve` account. */
export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: string | null;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** `null` means the coin is paired with native SOL. */
  quoteMint: string | null;
}

/** Minimal reserve snapshot needed to price a coin. */
export interface CurveReserves {
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
}

/** A freshly launched token as detected by the indexer. */
export interface DetectedToken extends CreateEventData {
  signature: string;
  slot: number;
  /** When our indexer saw the event (ms). */
  detectedAt: number;
  /** Reserves right after the creation transaction (includes the creator's dev buy, if any). */
  reserves: CurveReserves;
  /** SOL spent by the creator in the creation transaction (dev buy), in lamports. */
  devBuySol: bigint;
  priceSol: number;
  marketCapSol: number;
}

export type TradeMode = 'live' | 'paper';
export type OperationMode = 'idle' | 'sniper' | 'copytrade';

export type PositionStatus = 'open' | 'closed' | 'failed' | 'migrated';

export type ExitReason =
  | 'take_profit'
  | 'stop_loss'
  | 'trailing_stop'
  | 'no_gain_timeout'
  | 'max_hold_time'
  | 'manual'
  | 'curve_complete';

export interface Position {
  origin?: 'sniper' | 'copytrade';
  sourceWallet?: string | null;
  sourceSignature?: string | null;
  id: number;
  mint: string;
  symbol: string;
  name: string;
  mode: TradeMode;
  status: PositionStatus;
  tokenProgram: string;
  creator: string;
  /** SOL spent including fees (what actually left the wallet). */
  solSpent: number;
  tokenAmount: bigint;
  entryPrice: number;
  /** Highest estimated liquidation value seen while holding (SOL). */
  highestValueSol: number;
  lastValueSol: number | null;
  lastPrice: number | null;
  exitPrice: number | null;
  solReceived: number | null;
  pnlSol: number | null;
  pnlPercent: number | null;
  exitReason: ExitReason | null;
  buySignature: string | null;
  sellSignature: string | null;
  error: string | null;
  openedAt: number;
  closedAt: number | null;
}

export interface DurableAction {
  key: string;
  kind: 'copy_buy' | 'copy_sell' | 'sniper_buy' | 'live_buy' | 'live_sell';
  state: 'pending' | 'submitted' | 'completed' | 'cancelled' | 'failed';
  payload: string;
  signature: string | null;
  positionId: number | null;
  error: string | null;
  createdAt: number;
}

export type TradeSide = 'buy' | 'sell';

export interface TradeRecord {
  id: number;
  positionId: number | null;
  mint: string;
  side: TradeSide;
  mode: TradeMode;
  success: boolean;
  solAmount: number;
  tokenAmount: bigint;
  price: number | null;
  signature: string | null;
  error: string | null;
  latencyMs: number | null;
  createdAt: number;
}

export interface PriceTick {
  mint: string;
  priceSol: number;
  marketCapSol: number;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  source: 'stream' | 'poll';
  recordedAt: number;
}

export interface PerformanceMetrics {
  mode: TradeMode;
  totalPositions: number;
  openPositions: number;
  closedPositions: number;
  failedPositions: number;
  wins: number;
  losses: number;
  winRate: number;
  totalSolSpent: number;
  totalSolReceived: number;
  totalPnlSol: number;
  avgPnlPercent: number;
  bestPnlPercent: number | null;
  worstPnlPercent: number | null;
  avgHoldSeconds: number;
  exitReasons: Record<string, number>;
}
