import './env';
import { z } from 'zod';

const DEFAULT_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

const bool = (defaultValue: boolean) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === '') return defaultValue;
      if (['true', '1', 'yes', 'on'].includes(value)) return true;
      if (['false', '0', 'no', 'off'].includes(value)) return false;
      ctx.addIssue({ code: 'custom', message: `expected a boolean, received "${value}"` });
      return z.NEVER;
    });

const num = (defaultValue: number, opts: { min?: number; max?: number; int?: boolean } = {}) => {
  let schema = z.coerce.number();
  if (opts.int) schema = schema.int();
  if (opts.min !== undefined) schema = schema.min(opts.min);
  if (opts.max !== undefined) schema = schema.max(opts.max);
  return z.preprocess((v) => (v === undefined || v === '' ? defaultValue : v), schema);
};

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

const httpUrl = z
  .string()
  .trim()
  .refine((v) => /^https?:\/\//i.test(v), 'must be an http(s) URL');

const envSchema = z.object({
  // --- RPC ---------------------------------------------------------------
  RPC_URL: optionalString.pipe(httpUrl.optional()),
  WS_URL: optionalString,
  HELIUS_API_KEY: optionalString,
  FALLBACK_RPC_URLS: z.string().optional(),
  DETECTION_COMMITMENT: z.enum(['processed', 'confirmed']).default('processed'),
  WS_HEARTBEAT_TIMEOUT_MS: num(30_000, { min: 5_000, int: true }),

  // --- Wallet / execution -------------------------------------------------
  WALLET_PRIVATE_KEY: optionalString,
  DRY_RUN: bool(true),
  AUTO_BUY: bool(true),

  // --- Buy settings -------------------------------------------------------
  BUY_AMOUNT_SOL: num(0.01, { min: 0.0001 }),
  SLIPPAGE_PERCENT: num(15, { min: 0, max: 99 }),
  ESTIMATED_FEE_PERCENT: num(1.5, { min: 0, max: 20 }),
  PRIORITY_FEE_MICRO_LAMPORTS: num(100_000, { min: 0, int: true }),
  COMPUTE_UNIT_LIMIT: num(400_000, { min: 50_000, max: 1_400_000, int: true }),
  SKIP_PREFLIGHT: bool(true),
  TX_CONFIRM_TIMEOUT_MS: num(45_000, { min: 5_000, int: true }),
  MAX_OPEN_POSITIONS: num(3, { min: 1, int: true }),
  MIN_WALLET_BALANCE_SOL: num(0.02, { min: 0 }),
  MAX_TOKEN_AGE_SECONDS: num(15, { min: 1 }),
  SKIP_MAYHEM_TOKENS: bool(true),
  MAX_DEV_BUY_SOL: num(0, { min: 0 }),
  CLOSE_TOKEN_ACCOUNT_AFTER_SELL: bool(true),

  // --- Exit strategy ------------------------------------------------------
  TAKE_PROFIT_PERCENT: num(50, { min: 0.1 }),
  STOP_LOSS_PERCENT: num(10, { min: 0.1, max: 100 }),
  TRAILING_STOP_PERCENT: num(0, { min: 0, max: 100 }),
  MIN_GAIN_PERCENT: num(5, { min: 0 }),
  NO_GAIN_EXIT_SECONDS: num(20, { min: 0 }),
  MAX_HOLD_SECONDS: num(120, { min: 1 }),
  PRICE_CHECK_INTERVAL_MS: num(1_500, { min: 250, int: true }),
  SELL_RETRY_DELAY_MS: num(3_000, { min: 250, int: true }),

  // --- Indexer / price tracking --------------------------------------------
  TRACK_NEW_TOKENS_SECONDS: num(300, { min: 0 }),
  MAX_TRACKED_TOKENS: num(500, { min: 1, int: true }),
  PRICE_TICK_INTERVAL_MS: num(2_000, { min: 0, int: true }),
  PRICE_TICK_RETENTION_HOURS: num(24, { min: 1 }),

  // --- Database -----------------------------------------------------------
  DATABASE_PATH: z.string().trim().default('./data/pumpfun.db'),

  // --- API ----------------------------------------------------------------
  API_ENABLED: bool(true),
  API_HOST: z.string().trim().default('127.0.0.1'),
  API_PORT: num(3000, { min: 0, max: 65535, int: true }),
  API_KEY: optionalString,

  // --- Alerts -------------------------------------------------------------
  DISCORD_WEBHOOK_URL: optionalString.pipe(httpUrl.optional()),
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,
  ALERT_ON_DETECTION: bool(false),

  // --- Logging ------------------------------------------------------------
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool(true),
});

export interface RpcEndpoint {
  http: string;
  ws: string;
  label: string;
}

export interface AppConfig {
  rpc: {
    endpoints: RpcEndpoint[];
    detectionCommitment: 'processed' | 'confirmed';
    heartbeatTimeoutMs: number;
  };
  wallet: {
    /** Secret key (base58 or JSON array). Never exposed through the API. */
    privateKey?: string;
  };
  trading: {
    dryRun: boolean;
    autoBuy: boolean;
    buyAmountSol: number;
    slippagePercent: number;
    estimatedFeePercent: number;
    priorityFeeMicroLamports: number;
    computeUnitLimit: number;
    skipPreflight: boolean;
    txConfirmTimeoutMs: number;
    maxOpenPositions: number;
    minWalletBalanceSol: number;
    maxTokenAgeSeconds: number;
    skipMayhemTokens: boolean;
    /** 0 disables the filter. */
    maxDevBuySol: number;
    closeTokenAccountAfterSell: boolean;
  };
  strategy: {
    takeProfitPercent: number;
    stopLossPercent: number;
    /** 0 disables trailing stop. */
    trailingStopPercent: number;
    minGainPercent: number;
    /** 0 disables the no-gain timeout. */
    noGainExitSeconds: number;
    maxHoldSeconds: number;
    priceCheckIntervalMs: number;
    sellRetryDelayMs: number;
  };
  tracking: {
    trackNewTokensSeconds: number;
    maxTrackedTokens: number;
    priceTickIntervalMs: number;
    priceTickRetentionHours: number;
  };
  database: { path: string };
  api: { enabled: boolean; host: string; port: number; apiKey?: string };
  alerts: {
    discordWebhookUrl?: string;
    telegramBotToken?: string;
    telegramChatId?: string;
    alertOnDetection: boolean;
  };
  logging: { level: string; pretty: boolean };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Converts an http(s) RPC URL into its websocket counterpart. */
export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`);
}

function endpointLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'rpc';
  }
}

function buildEndpoints(env: z.infer<typeof envSchema>): RpcEndpoint[] {
  const endpoints: RpcEndpoint[] = [];
  const primary =
    env.RPC_URL ??
    (env.HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(env.HELIUS_API_KEY)}`
      : undefined);

  if (primary) {
    endpoints.push({ http: primary, ws: env.WS_URL ?? toWsUrl(primary), label: endpointLabel(primary) });
  }

  const fallbacks = (env.FALLBACK_RPC_URLS ?? DEFAULT_PUBLIC_RPC)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const url of fallbacks) {
    if (!/^https?:\/\//i.test(url)) {
      throw new ConfigError(`FALLBACK_RPC_URLS contains an invalid URL: ${url}`);
    }
    if (endpoints.some((e) => e.http === url)) continue;
    endpoints.push({ http: url, ws: toWsUrl(url), label: endpointLabel(url) });
  }

  if (endpoints.length === 0) {
    throw new ConfigError('No RPC endpoint configured. Set RPC_URL, HELIUS_API_KEY or FALLBACK_RPC_URLS.');
  }
  return endpoints;
}

/**
 * Parses and validates configuration from environment variables.
 * Throws a {@link ConfigError} with a readable message when something is wrong.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid configuration:\n${details}`);
  }
  const env = parsed.data;

  if (!env.DRY_RUN && !env.WALLET_PRIVATE_KEY) {
    throw new ConfigError('WALLET_PRIVATE_KEY is required when DRY_RUN=false.');
  }
  if (Boolean(env.TELEGRAM_BOT_TOKEN) !== Boolean(env.TELEGRAM_CHAT_ID)) {
    throw new ConfigError('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together.');
  }

  return {
    rpc: {
      endpoints: buildEndpoints(env),
      detectionCommitment: env.DETECTION_COMMITMENT,
      heartbeatTimeoutMs: env.WS_HEARTBEAT_TIMEOUT_MS,
    },
    wallet: { privateKey: env.WALLET_PRIVATE_KEY },
    trading: {
      dryRun: env.DRY_RUN,
      autoBuy: env.AUTO_BUY,
      buyAmountSol: env.BUY_AMOUNT_SOL,
      slippagePercent: env.SLIPPAGE_PERCENT,
      estimatedFeePercent: env.ESTIMATED_FEE_PERCENT,
      priorityFeeMicroLamports: env.PRIORITY_FEE_MICRO_LAMPORTS,
      computeUnitLimit: env.COMPUTE_UNIT_LIMIT,
      skipPreflight: env.SKIP_PREFLIGHT,
      txConfirmTimeoutMs: env.TX_CONFIRM_TIMEOUT_MS,
      maxOpenPositions: env.MAX_OPEN_POSITIONS,
      minWalletBalanceSol: env.MIN_WALLET_BALANCE_SOL,
      maxTokenAgeSeconds: env.MAX_TOKEN_AGE_SECONDS,
      skipMayhemTokens: env.SKIP_MAYHEM_TOKENS,
      maxDevBuySol: env.MAX_DEV_BUY_SOL,
      closeTokenAccountAfterSell: env.CLOSE_TOKEN_ACCOUNT_AFTER_SELL,
    },
    strategy: {
      takeProfitPercent: env.TAKE_PROFIT_PERCENT,
      stopLossPercent: env.STOP_LOSS_PERCENT,
      trailingStopPercent: env.TRAILING_STOP_PERCENT,
      minGainPercent: env.MIN_GAIN_PERCENT,
      noGainExitSeconds: env.NO_GAIN_EXIT_SECONDS,
      maxHoldSeconds: env.MAX_HOLD_SECONDS,
      priceCheckIntervalMs: env.PRICE_CHECK_INTERVAL_MS,
      sellRetryDelayMs: env.SELL_RETRY_DELAY_MS,
    },
    tracking: {
      trackNewTokensSeconds: env.TRACK_NEW_TOKENS_SECONDS,
      maxTrackedTokens: env.MAX_TRACKED_TOKENS,
      priceTickIntervalMs: env.PRICE_TICK_INTERVAL_MS,
      priceTickRetentionHours: env.PRICE_TICK_RETENTION_HOURS,
    },
    database: { path: env.DATABASE_PATH },
    api: { enabled: env.API_ENABLED, host: env.API_HOST, port: env.API_PORT, apiKey: env.API_KEY },
    alerts: {
      discordWebhookUrl: env.DISCORD_WEBHOOK_URL,
      telegramBotToken: env.TELEGRAM_BOT_TOKEN,
      telegramChatId: env.TELEGRAM_CHAT_ID,
      alertOnDetection: env.ALERT_ON_DETECTION,
    },
    logging: { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY },
  };
}

/** Removes query strings (which usually carry API keys) from a URL for display. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search ? '?***' : ''}`;
  } catch {
    return '***';
  }
}

/** Configuration safe to expose via the API / logs (no secrets). */
export function publicConfig(cfg: AppConfig) {
  return {
    rpc: {
      endpoints: cfg.rpc.endpoints.map((e) => redactUrl(e.http)),
      detectionCommitment: cfg.rpc.detectionCommitment,
    },
    trading: cfg.trading,
    strategy: cfg.strategy,
    tracking: cfg.tracking,
    api: { enabled: cfg.api.enabled, host: cfg.api.host, port: cfg.api.port, authEnabled: Boolean(cfg.api.apiKey) },
    alerts: {
      discord: Boolean(cfg.alerts.discordWebhookUrl),
      telegram: Boolean(cfg.alerts.telegramBotToken),
      alertOnDetection: cfg.alerts.alertOnDetection,
    },
    walletConfigured: Boolean(cfg.wallet.privateKey),
  };
}
