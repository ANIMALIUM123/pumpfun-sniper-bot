import type { Statement } from 'better-sqlite3';
import type { Db } from './db';
import type {
  DetectedToken,
  ExitReason,
  PerformanceMetrics,
  Position,
  PositionStatus,
  PriceTick,
  TradeMode,
  TradeRecord,
  TradeSide,
} from '../types';

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function rowToPosition(row: Row): Position {
  return {
    id: Number(row.id),
    mint: String(row.mint),
    name: String(row.name),
    symbol: String(row.symbol),
    mode: row.mode as TradeMode,
    status: row.status as PositionStatus,
    tokenProgram: String(row.token_program),
    creator: String(row.creator),
    solSpent: Number(row.sol_spent),
    tokenAmount: BigInt(String(row.token_amount)),
    entryPrice: Number(row.entry_price),
    highestValueSol: Number(row.highest_value_sol),
    lastValueSol: num(row.last_value_sol),
    lastPrice: num(row.last_price),
    exitPrice: num(row.exit_price),
    solReceived: num(row.sol_received),
    pnlSol: num(row.pnl_sol),
    pnlPercent: num(row.pnl_percent),
    exitReason: (row.exit_reason as ExitReason | null) ?? null,
    buySignature: (row.buy_signature as string | null) ?? null,
    sellSignature: (row.sell_signature as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    openedAt: Number(row.opened_at),
    closedAt: num(row.closed_at),
  };
}

function rowToTrade(row: Row): TradeRecord {
  return {
    id: Number(row.id),
    positionId: num(row.position_id),
    mint: String(row.mint),
    side: row.side as TradeSide,
    mode: row.mode as TradeMode,
    success: Number(row.success) === 1,
    solAmount: Number(row.sol_amount),
    tokenAmount: BigInt(String(row.token_amount)),
    price: num(row.price),
    signature: (row.signature as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    latencyMs: num(row.latency_ms),
    createdAt: Number(row.created_at),
  };
}

function rowToTick(row: Row): PriceTick {
  return {
    mint: String(row.mint),
    priceSol: Number(row.price_sol),
    marketCapSol: Number(row.market_cap_sol),
    virtualSolReserves: BigInt(String(row.virtual_sol_reserves)),
    virtualTokenReserves: BigInt(String(row.virtual_token_reserves)),
    realSolReserves: BigInt(String(row.real_sol_reserves)),
    realTokenReserves: BigInt(String(row.real_token_reserves)),
    source: row.source as PriceTick['source'],
    recordedAt: Number(row.recorded_at),
  };
}

export interface StoredToken {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  deployer: string;
  bondingCurve: string;
  tokenProgram: string;
  quoteMint: string | null;
  isMayhemMode: boolean;
  signature: string;
  slot: number;
  createdAt: number;
  detectedAt: number;
  tokenTotalSupply: string;
  devBuySol: number;
  initialPriceSol: number;
  initialMarketCapSol: number;
  lastPriceSol: number | null;
  lastMarketCapSol: number | null;
  curveProgress: number | null;
  lastUpdateAt: number | null;
}

function rowToToken(row: Row): StoredToken {
  return {
    mint: String(row.mint),
    name: String(row.name),
    symbol: String(row.symbol),
    uri: String(row.uri),
    creator: String(row.creator),
    deployer: String(row.deployer),
    bondingCurve: String(row.bonding_curve),
    tokenProgram: String(row.token_program),
    quoteMint: (row.quote_mint as string | null) ?? null,
    isMayhemMode: Number(row.is_mayhem_mode) === 1,
    signature: String(row.signature),
    slot: Number(row.slot),
    createdAt: Number(row.created_at),
    detectedAt: Number(row.detected_at),
    tokenTotalSupply: String(row.token_total_supply),
    devBuySol: Number(row.dev_buy_sol),
    initialPriceSol: Number(row.initial_price_sol),
    initialMarketCapSol: Number(row.initial_market_cap_sol),
    lastPriceSol: num(row.last_price_sol),
    lastMarketCapSol: num(row.last_market_cap_sol),
    curveProgress: num(row.curve_progress),
    lastUpdateAt: num(row.last_update_at),
  };
}

export interface NewPosition {
  mint: string;
  name: string;
  symbol: string;
  mode: TradeMode;
  tokenProgram: string;
  creator: string;
  solSpent: number;
  tokenAmount: bigint;
  entryPrice: number;
  buySignature: string | null;
  openedAt: number;
}

export interface ClosePositionUpdate {
  status: Exclude<PositionStatus, 'open'>;
  exitPrice?: number | null;
  solReceived?: number | null;
  pnlSol?: number | null;
  pnlPercent?: number | null;
  exitReason?: ExitReason | null;
  sellSignature?: string | null;
  error?: string | null;
  closedAt: number;
}

export interface NewTrade {
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

/** Data-access layer. All SQL lives here so the storage engine can be swapped later (e.g. PostgreSQL). */
export class Repository {
  private readonly statements = new Map<string, Statement>();

  constructor(private readonly db: Db) {}

  /** Prepared statements are cached – preparing SQL is comparatively expensive. */
  private stmt(sql: string): Statement {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  // ---------------------------------------------------------------- tokens

  /** Inserts a detected token. Returns `false` if it was already stored. */
  insertToken(t: DetectedToken): boolean {
    const res = this.stmt(
        `INSERT OR IGNORE INTO tokens (
          mint, name, symbol, uri, creator, deployer, bonding_curve, token_program, quote_mint, is_mayhem_mode,
          signature, slot, created_at, detected_at, token_total_supply, initial_virtual_sol, initial_virtual_token,
          initial_real_token, dev_buy_sol, initial_price_sol, initial_market_cap_sol,
          last_price_sol, last_market_cap_sol, last_real_sol, last_update_at
        ) VALUES (
          @mint, @name, @symbol, @uri, @creator, @deployer, @bondingCurve, @tokenProgram, @quoteMint, @isMayhemMode,
          @signature, @slot, @createdAt, @detectedAt, @tokenTotalSupply, @initialVirtualSol, @initialVirtualToken,
          @initialRealToken, @devBuySol, @priceSol, @marketCapSol,
          @priceSol, @marketCapSol, @lastRealSol, @detectedAt
        )`,
      )
      .run({
        mint: t.mint,
        name: t.name,
        symbol: t.symbol,
        uri: t.uri,
        creator: t.creator,
        deployer: t.user,
        bondingCurve: t.bondingCurve,
        tokenProgram: t.tokenProgram,
        quoteMint: t.quoteMint,
        isMayhemMode: t.isMayhemMode ? 1 : 0,
        signature: t.signature,
        slot: t.slot,
        createdAt: t.timestamp * 1000,
        detectedAt: t.detectedAt,
        tokenTotalSupply: t.tokenTotalSupply.toString(),
        initialVirtualSol: t.virtualSolReserves.toString(),
        initialVirtualToken: t.virtualTokenReserves.toString(),
        initialRealToken: t.realTokenReserves.toString(),
        devBuySol: Number(t.devBuySol) / 1e9,
        priceSol: t.priceSol,
        marketCapSol: t.marketCapSol,
        lastRealSol: t.reserves.realSolReserves.toString(),
      });
    return res.changes > 0;
  }

  getToken(mint: string): StoredToken | null {
    const row = this.stmt('SELECT * FROM tokens WHERE mint = ?').get(mint) as Row | undefined;
    return row ? rowToToken(row) : null;
  }

  listTokens(opts: { limit: number; offset: number; search?: string }): { items: StoredToken[]; total: number } {
    const where = opts.search ? 'WHERE name LIKE @q OR symbol LIKE @q OR mint = @exact' : '';
    const params = opts.search ? { q: `%${opts.search}%`, exact: opts.search } : {};
    const items = (
      this.stmt(`SELECT * FROM tokens ${where} ORDER BY detected_at DESC LIMIT @limit OFFSET @offset`)
        .all({ ...params, limit: opts.limit, offset: opts.offset }) as Row[]
    ).map(rowToToken);
    const total = Number((this.stmt(`SELECT COUNT(*) AS c FROM tokens ${where}`).get(params) as Row).c);
    return { items, total };
  }

  countTokensSince(since: number): number {
    return Number((this.stmt('SELECT COUNT(*) AS c FROM tokens WHERE detected_at >= ?').get(since) as Row).c);
  }

  updateTokenMarket(mint: string, priceSol: number, marketCapSol: number, realSol: bigint, progress: number, at: number): void {
    this.stmt(
        `UPDATE tokens SET last_price_sol = ?, last_market_cap_sol = ?, last_real_sol = ?, curve_progress = ?, last_update_at = ?
         WHERE mint = ?`,
      )
      .run(priceSol, marketCapSol, realSol.toString(), progress, at, mint);
  }

  // ----------------------------------------------------------- price ticks

  insertPriceTick(t: PriceTick): void {
    this.stmt(
        `INSERT INTO price_ticks (mint, price_sol, market_cap_sol, virtual_sol_reserves, virtual_token_reserves,
          real_sol_reserves, real_token_reserves, source, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.mint,
        t.priceSol,
        t.marketCapSol,
        t.virtualSolReserves.toString(),
        t.virtualTokenReserves.toString(),
        t.realSolReserves.toString(),
        t.realTokenReserves.toString(),
        t.source,
        t.recordedAt,
      );
  }

  /** Most recent ticks first. */
  getPriceTicks(mint: string, limit: number, since?: number): PriceTick[] {
    return (
      this.stmt('SELECT * FROM price_ticks WHERE mint = ? AND recorded_at >= ? ORDER BY recorded_at DESC LIMIT ?')
        .all(mint, since ?? 0, limit) as Row[]
    ).map(rowToTick);
  }

  getLatestPriceTick(mint: string): PriceTick | null {
    const row = this.stmt('SELECT * FROM price_ticks WHERE mint = ? ORDER BY recorded_at DESC LIMIT 1')
      .get(mint) as Row | undefined;
    return row ? rowToTick(row) : null;
  }

  prunePriceTicks(olderThan: number): number {
    return this.stmt('DELETE FROM price_ticks WHERE recorded_at < ?').run(olderThan).changes;
  }

  // ------------------------------------------------------------- positions

  createPosition(p: NewPosition): Position {
    const res = this.stmt(
        `INSERT INTO positions (mint, name, symbol, mode, status, token_program, creator, sol_spent, token_amount,
          entry_price, highest_value_sol, last_value_sol, buy_signature, opened_at)
         VALUES (@mint, @name, @symbol, @mode, 'open', @tokenProgram, @creator, @solSpent, @tokenAmount,
          @entryPrice, @solSpent, @solSpent, @buySignature, @openedAt)`,
      )
      .run({ ...p, tokenAmount: p.tokenAmount.toString() });
    return this.getPosition(Number(res.lastInsertRowid))!;
  }

  /** Records a buy that never produced a position (e.g. slippage error). */
  createFailedPosition(p: Omit<NewPosition, 'solSpent' | 'tokenAmount' | 'entryPrice'> & { error: string }): Position {
    const res = this.stmt(
        `INSERT INTO positions (mint, name, symbol, mode, status, token_program, creator, buy_signature, error, opened_at, closed_at)
         VALUES (@mint, @name, @symbol, @mode, 'failed', @tokenProgram, @creator, @buySignature, @error, @openedAt, @openedAt)`,
      )
      .run(p);
    return this.getPosition(Number(res.lastInsertRowid))!;
  }

  getPosition(id: number): Position | null {
    const row = this.stmt('SELECT * FROM positions WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToPosition(row) : null;
  }

  getOpenPositions(mode?: TradeMode): Position[] {
    const rows = mode
      ? this.stmt("SELECT * FROM positions WHERE status = 'open' AND mode = ? ORDER BY opened_at").all(mode)
      : this.stmt("SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at").all();
    return (rows as Row[]).map(rowToPosition);
  }

  listPositions(opts: { status?: PositionStatus; mode?: TradeMode; limit: number; offset: number }): Position[] {
    const clauses: string[] = [];
    if (opts.status) clauses.push('status = @status');
    if (opts.mode) clauses.push('mode = @mode');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return (
      this.stmt(`SELECT * FROM positions ${where} ORDER BY opened_at DESC LIMIT @limit OFFSET @offset`)
        .all({ status: opts.status, mode: opts.mode, limit: opts.limit, offset: opts.offset }) as Row[]
    ).map(rowToPosition);
  }

  updatePositionMarket(id: number, lastPrice: number, lastValueSol: number, highestValueSol: number): void {
    this.stmt('UPDATE positions SET last_price = ?, last_value_sol = ?, highest_value_sol = ? WHERE id = ?')
      .run(lastPrice, lastValueSol, highestValueSol, id);
  }

  closePosition(id: number, u: ClosePositionUpdate): Position {
    this.stmt(
        `UPDATE positions SET status = @status, exit_price = @exitPrice, sol_received = @solReceived, pnl_sol = @pnlSol,
          pnl_percent = @pnlPercent, exit_reason = @exitReason, sell_signature = @sellSignature,
          error = COALESCE(@error, error), closed_at = @closedAt
         WHERE id = @id`,
      )
      .run({
        id,
        status: u.status,
        exitPrice: u.exitPrice ?? null,
        solReceived: u.solReceived ?? null,
        pnlSol: u.pnlSol ?? null,
        pnlPercent: u.pnlPercent ?? null,
        exitReason: u.exitReason ?? null,
        sellSignature: u.sellSignature ?? null,
        error: u.error ?? null,
        closedAt: u.closedAt,
      });
    return this.getPosition(id)!;
  }

  setPositionError(id: number, error: string): void {
    this.stmt('UPDATE positions SET error = ? WHERE id = ?').run(error, id);
  }

  // ---------------------------------------------------------------- trades

  insertTrade(t: NewTrade): TradeRecord {
    const res = this.stmt(
        `INSERT INTO trades (position_id, mint, side, mode, success, sol_amount, token_amount, price, signature, error,
          latency_ms, created_at)
         VALUES (@positionId, @mint, @side, @mode, @success, @solAmount, @tokenAmount, @price, @signature, @error,
          @latencyMs, @createdAt)`,
      )
      .run({ ...t, success: t.success ? 1 : 0, tokenAmount: t.tokenAmount.toString() });
    return rowToTrade(this.stmt('SELECT * FROM trades WHERE id = ?').get(res.lastInsertRowid) as Row);
  }

  listTrades(opts: { limit: number; offset: number; mint?: string; mode?: TradeMode }): TradeRecord[] {
    const clauses: string[] = [];
    if (opts.mint) clauses.push('mint = @mint');
    if (opts.mode) clauses.push('mode = @mode');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return (
      this.stmt(`SELECT * FROM trades ${where} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`)
        .all({ mint: opts.mint, mode: opts.mode, limit: opts.limit, offset: opts.offset }) as Row[]
    ).map(rowToTrade);
  }

  linkTradeToPosition(tradeId: number, positionId: number): void {
    this.stmt('UPDATE trades SET position_id = ? WHERE id = ?').run(positionId, tradeId);
  }

  // --------------------------------------------------------------- metrics

  getMetrics(mode: TradeMode): PerformanceMetrics {
    const agg = this.stmt(
        `SELECT
           COUNT(*) AS total,
           SUM(status = 'open') AS open,
           SUM(status IN ('closed','migrated')) AS closed,
           SUM(status = 'failed') AS failed,
           SUM(status = 'closed' AND pnl_sol > 0) AS wins,
           SUM(status = 'closed' AND pnl_sol <= 0) AS losses,
           COALESCE(SUM(CASE WHEN status <> 'failed' THEN sol_spent END), 0) AS spent,
           COALESCE(SUM(CASE WHEN status = 'closed' THEN sol_received END), 0) AS received,
           COALESCE(SUM(CASE WHEN status = 'closed' THEN pnl_sol END), 0) AS pnl,
           AVG(CASE WHEN status = 'closed' THEN pnl_percent END) AS avg_pnl_pct,
           MAX(CASE WHEN status = 'closed' THEN pnl_percent END) AS best,
           MIN(CASE WHEN status = 'closed' THEN pnl_percent END) AS worst,
           AVG(CASE WHEN status = 'closed' THEN (closed_at - opened_at) / 1000.0 END) AS avg_hold
         FROM positions WHERE mode = ?`,
      )
      .get(mode) as Row;

    const reasons = this.stmt(
        `SELECT exit_reason AS reason, COUNT(*) AS c FROM positions
         WHERE mode = ? AND exit_reason IS NOT NULL GROUP BY exit_reason`,
      )
      .all(mode) as Row[];

    const wins = Number(agg.wins ?? 0);
    const losses = Number(agg.losses ?? 0);
    return {
      mode,
      totalPositions: Number(agg.total ?? 0),
      openPositions: Number(agg.open ?? 0),
      closedPositions: Number(agg.closed ?? 0),
      failedPositions: Number(agg.failed ?? 0),
      wins,
      losses,
      winRate: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0,
      totalSolSpent: Number(agg.spent ?? 0),
      totalSolReceived: Number(agg.received ?? 0),
      totalPnlSol: Number(agg.pnl ?? 0),
      avgPnlPercent: Number(agg.avg_pnl_pct ?? 0),
      bestPnlPercent: num(agg.best),
      worstPnlPercent: num(agg.worst),
      avgHoldSeconds: Number(agg.avg_hold ?? 0),
      exitReasons: Object.fromEntries(reasons.map((r) => [String(r.reason), Number(r.c)])),
    };
  }
}
