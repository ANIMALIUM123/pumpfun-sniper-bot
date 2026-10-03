import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Ordered list of schema migrations. Each entry upgrades the schema by one version
 * (tracked with `PRAGMA user_version`). Never edit an existing migration – append a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE tokens (
    mint                    TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    symbol                  TEXT NOT NULL,
    uri                     TEXT NOT NULL,
    creator                 TEXT NOT NULL,
    deployer                TEXT NOT NULL,
    bonding_curve           TEXT NOT NULL,
    token_program           TEXT NOT NULL,
    quote_mint              TEXT,
    is_mayhem_mode          INTEGER NOT NULL DEFAULT 0,
    signature               TEXT NOT NULL,
    slot                    INTEGER NOT NULL,
    created_at              INTEGER NOT NULL,
    detected_at             INTEGER NOT NULL,
    token_total_supply      TEXT NOT NULL,
    initial_virtual_sol     TEXT NOT NULL,
    initial_virtual_token   TEXT NOT NULL,
    initial_real_token      TEXT NOT NULL,
    dev_buy_sol             REAL NOT NULL DEFAULT 0,
    initial_price_sol       REAL NOT NULL,
    initial_market_cap_sol  REAL NOT NULL,
    last_price_sol          REAL,
    last_market_cap_sol     REAL,
    last_real_sol           TEXT,
    curve_progress          REAL,
    last_update_at          INTEGER
  );
  CREATE INDEX idx_tokens_detected_at ON tokens(detected_at DESC);
  CREATE INDEX idx_tokens_creator ON tokens(creator);

  CREATE TABLE positions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    mint              TEXT NOT NULL,
    name              TEXT NOT NULL,
    symbol            TEXT NOT NULL,
    mode              TEXT NOT NULL CHECK (mode IN ('live','paper')),
    status            TEXT NOT NULL CHECK (status IN ('open','closed','failed','migrated')),
    token_program     TEXT NOT NULL,
    creator           TEXT NOT NULL,
    sol_spent         REAL NOT NULL DEFAULT 0,
    token_amount      TEXT NOT NULL DEFAULT '0',
    entry_price       REAL NOT NULL DEFAULT 0,
    highest_value_sol REAL NOT NULL DEFAULT 0,
    last_value_sol    REAL,
    last_price        REAL,
    exit_price        REAL,
    sol_received      REAL,
    pnl_sol           REAL,
    pnl_percent       REAL,
    exit_reason       TEXT,
    buy_signature     TEXT,
    sell_signature    TEXT,
    error             TEXT,
    opened_at         INTEGER NOT NULL,
    closed_at         INTEGER
  );
  CREATE INDEX idx_positions_status ON positions(status, mode);
  CREATE INDEX idx_positions_mint ON positions(mint);

  CREATE TABLE trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id   INTEGER REFERENCES positions(id) ON DELETE SET NULL,
    mint          TEXT NOT NULL,
    side          TEXT NOT NULL CHECK (side IN ('buy','sell')),
    mode          TEXT NOT NULL CHECK (mode IN ('live','paper')),
    success       INTEGER NOT NULL,
    sol_amount    REAL NOT NULL,
    token_amount  TEXT NOT NULL,
    price         REAL,
    signature     TEXT,
    error         TEXT,
    latency_ms    INTEGER,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX idx_trades_created_at ON trades(created_at DESC);
  CREATE INDEX idx_trades_mint ON trades(mint);

  CREATE TABLE price_ticks (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    mint                   TEXT NOT NULL,
    price_sol              REAL NOT NULL,
    market_cap_sol         REAL NOT NULL,
    virtual_sol_reserves   TEXT NOT NULL,
    virtual_token_reserves TEXT NOT NULL,
    real_sol_reserves      TEXT NOT NULL,
    real_token_reserves    TEXT NOT NULL,
    source                 TEXT NOT NULL,
    recorded_at            INTEGER NOT NULL
  );
  CREATE INDEX idx_price_ticks_mint_time ON price_ticks(mint, recorded_at DESC);
  CREATE INDEX idx_price_ticks_time ON price_ticks(recorded_at);
  `,
  `
  ALTER TABLE positions ADD COLUMN origin TEXT NOT NULL DEFAULT 'sniper';
  ALTER TABLE positions ADD COLUMN source_wallet TEXT;
  ALTER TABLE positions ADD COLUMN source_signature TEXT;
  CREATE TABLE operation_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE copy_signals (
    wallet TEXT NOT NULL, signature TEXT NOT NULL, state TEXT NOT NULL,
    error TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(wallet, signature)
  );
  CREATE TABLE actions (
    key TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
    payload TEXT NOT NULL, signature TEXT, position_id INTEGER REFERENCES positions(id),
    error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_actions_state ON actions(state, kind);
  CREATE TABLE operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  `,
];

export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

/** Opens (and creates/migrates if needed) the SQLite database. Use `:memory:` for tests. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
