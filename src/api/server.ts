import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { PublicKey } from '@solana/web3.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import type { BotController } from '../bot';
import type { Repository } from '../database/repository';
import type { JupiterClient } from '../jupiter';
import type { WalletVault } from '../wallet';
import { copySettingsSchema } from '../copytrade/settings';
import { bondingCurveProgress, marketCapSol, priceSolPerToken } from '../pumpfun';
import { errorMessage } from '../utils/async';
import { getLogger } from '../utils/logger';
import { DASHBOARD_HTML, DASHBOARD_JS } from './dashboard';

export interface ApiOptions {
  repo: Repository;
  bot: BotController;
  /** When set, every `/api` request must send it via `x-api-key` or `Authorization: Bearer`. */
  apiKey?: string;
  /** Explicit non-loopback hosts for deployments behind a trusted reverse proxy. */
  allowedHosts?: string[];
  /** Explicit same-host browser origins when TLS terminates at a trusted proxy. */
  allowedOrigins?: string[];
  wallet?: WalletVault;
  jupiter?: JupiterClient;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const log = getLogger('api');

const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const modeSchema = z.enum(['live', 'paper']).optional();
const confirmation = z.object({ confirmed: z.literal(true) }).strict();

function parseMint(value: unknown): string {
  try {
    return new PublicKey(String(value)).toBase58();
  } catch {
    throw new HttpError(400, 'Invalid mint address');
  }
}

/** Constant-time comparison of the provided API key with the configured one. */
function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b); // keep timing independent of where the mismatch is
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function providedKey(req: Request): string | undefined {
  const header = req.header('x-api-key');
  if (header) return header;
  const auth = req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}

export function createApp({ repo, bot, apiKey, allowedHosts = [], allowedOrigins = [], wallet, jupiter }: ApiOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('json replacer', (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
  app.use((req, res, next) => {
    let hostname: string;
    try {
      const host = req.headers.host ?? '';
      if (!/^(?:\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)(?::[0-9]{1,5})?$/.test(host)) {
        throw new Error('Malformed host');
      }
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      return next(new HttpError(403, 'Invalid Host'));
    }
    if (!['localhost', '127.0.0.1', '[::1]', ...allowedHosts].includes(hostname)) {
      return next(new HttpError(403, 'Host not allowed'));
    }
    if (!['GET', 'HEAD', 'POST', 'PUT'].includes(req.method)) {
      return next(new HttpError(405, 'Method not allowed'));
    }
    const origin = req.header('origin');
    let originAllowed = !origin || origin === `${req.protocol}://${req.headers.host}`;
    if (!originAllowed && origin && allowedOrigins.includes(origin)) {
      try {
        const parsed = new URL(origin);
        originAllowed = parsed.hostname === hostname && ['https:', 'http:'].includes(parsed.protocol);
      } catch {
        originAllowed = false;
      }
    }
    if (!originAllowed || req.header('sec-fetch-site') === 'cross-site') {
      return next(new HttpError(403, 'Cross-origin requests are not allowed'));
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '10kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // ---------------------------------------------------------------- public
  app.get('/health', (_req, res) => {
    res.json({ ok: true, mode: bot.mode, uptimeSeconds: bot.status().uptimeSeconds });
  });

  app.get('/', (_req, res) => {
    res
      .setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'")
      .type('html')
      .send(DASHBOARD_HTML);
  });
  app.get('/dashboard.js', (_req, res) => {
    res.type('application/javascript').send(DASHBOARD_JS);
  });

  // ------------------------------------------------------------- protected
  const api = express.Router();

  api.use((req, _res, next) => {
    if (!apiKey) return next();
    const key = providedKey(req);
    if (!key || !safeEqual(key, apiKey)) return next(new HttpError(401, 'Unauthorized'));
    next();
  });

  // One bounded bucket per application, rather than an unbounded map of client addresses.
  let windowStarted = Date.now();
  let mutations = 0;
  api.use((req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (Date.now() - windowStarted >= 60_000) {
      windowStarted = Date.now();
      mutations = 0;
    }
    if (++mutations > 30) return next(new HttpError(429, 'Too many control requests; try again in a minute'));
    next();
  });

  /** Mutating endpoints are only available when an API key is configured. */
  const requireKeyConfigured = (_req: Request, _res: Response, next: NextFunction) => {
    if (!apiKey) return next(new HttpError(403, 'Set API_KEY to enable control endpoints'));
    next();
  };

  api.get('/status', (_req, res) => {
    const { rpcEndpoint: _rpcEndpoint, ...status } = bot.status();
    res.json({ ...status, rpcEndpoint: '[server configured]' });
  });

  api.get('/config', (_req, res) => {
    const config = bot.publicConfig();
    res.json({ ...config, rpc: { ...config.rpc, endpoints: config.rpc.endpoints.map(() => '[server configured]') } });
  });

  const operationStatus = () => bot.operationStatus?.() ?? {
    mode: bot.status().sniper.paused ? 'idle' : 'sniper',
    paused: bot.status().sniper.paused,
    transitioning: false,
  };
  api.get('/operation', (_req, res) => res.json(operationStatus()));
  api.get('/operation/logs', (_req, res) => {
    const safeFields = ['mode', 'paused', 'mint', 'wallet', 'sourceSignature', 'positionId', 'paper', 'durationMs', 'executionLatencyMs', 'signalLatencyMs', 'fraction'];
    const items = (bot.operationLogs?.() ?? []).slice(0, 100).map((item) => {
      const entry = item as { id?: number; event?: string; createdAt?: number; detail?: Record<string, unknown> };
      const detail = Object.fromEntries(safeFields.filter((key) => ['string', 'number', 'boolean'].includes(typeof entry.detail?.[key]))
        .map((key) => [key, entry.detail?.[key]]));
      return { id: entry.id, event: entry.event, createdAt: entry.createdAt, detail };
    });
    res.json({ items });
  });
  let configuringOperation = false;
  let pauseRevision = 0;
  api.post('/operation', requireKeyConfigured, async (req, res) => {
    const { mode } = z.object({ mode: z.enum(['idle', 'sniper', 'copytrade']), confirmed: z.literal(true) }).strict().parse(req.body);
    if (!bot.setOperation) throw new HttpError(503, 'Operation control is unavailable');
    if (configuringOperation || liquidating) throw new HttpError(409, 'Another control operation is in progress');
    if (mode !== 'idle' && bot.mode === 'live') throw new HttpError(409, 'Live execution is not supported by these unverified execution paths');
    configuringOperation = true;
    const revision = pauseRevision;
    try {
      await bot.setOperation(mode);
      if (mode !== 'idle' && revision === pauseRevision) bot.resume();
      res.json(operationStatus());
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(409, 'Operation transition refused; verify wallet and copy settings');
    } finally {
      configuringOperation = false;
    }
  });
  api.get('/copy/settings', requireKeyConfigured, (_req, res) => {
    if (!bot.copySettings) throw new HttpError(503, 'Copy trading is unavailable');
    res.json(bot.copySettings());
  });
  api.put('/copy/settings', requireKeyConfigured, async (req, res) => {
    if (!bot.configureCopy) throw new HttpError(503, 'Copy trading is unavailable');
    const settings = copySettingsSchema.partial().parse(req.body);
    if (settings.execution === 'live') throw new HttpError(409, 'Live copy trading is not supported');
    if (configuringOperation || liquidating) throw new HttpError(409, 'Another control operation is in progress');
    configuringOperation = true;
    try {
      res.json(await bot.configureCopy(settings));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(409, 'Copy settings refused');
    } finally {
      configuringOperation = false;
    }
  });

  const requireWallet = (): WalletVault => {
    if (!wallet) throw new HttpError(503, 'Local wallet is not configured');
    return wallet;
  };
  const walletMetadata = () => {
    const status = requireWallet().status();
    const botStatus = bot.status();
    return {
      publicKey: status.publicAddress,
      locked: status.locked,
      capability: status.canSign ? 'local-signer' : 'readonly',
      balanceSol: status.publicAddress && status.publicAddress === botStatus.wallet ? botStatus.walletBalanceSol : null,
    };
  };
  const passwordBody = z.object({ password: z.string().min(12).max(256) }).strict();
  api.get('/wallet/status', requireKeyConfigured, (_req, res) => res.json(walletMetadata()));
  api.post('/wallet/create', requireKeyConfigured, async (req, res) => {
    const { password } = passwordBody.parse(req.body);
    try {
      await requireWallet().create(password);
      res.json(walletMetadata());
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(409, 'Unable to create encrypted wallet');
    }
  });
  api.post('/wallet/unlock', requireKeyConfigured, async (req, res) => {
    const { password } = passwordBody.parse(req.body);
    try {
      await requireWallet().unlock(password);
      res.json(walletMetadata());
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(403, 'Wallet unlock refused');
    }
  });
  api.post('/wallet/lock', requireKeyConfigured, (_req, res) => {
    requireWallet().lock();
    res.json(walletMetadata());
  });
  api.post('/wallet/export', requireKeyConfigured, async (req, res) => {
    const { password } = passwordBody.extend({ confirmed: z.literal(true) }).parse(req.body);
    try {
      const secret = await requireWallet().export(password);
      res.setHeader('Content-Disposition', 'attachment; filename="carteira-solana-privada.json"');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.json(secret);
      secret.fill(0);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(403, 'Wallet export refused; reauthentication required');
    }
  });
  api.get('/jupiter/status', requireKeyConfigured, (_req, res) => {
    if (!jupiter) return void res.json({ configured: false, quoteOnly: true, liveExecutionSupported: false });
    const { endpoint: _endpoint, ...status } = jupiter.status();
    res.json(status);
  });
  api.post('/jupiter/quote', requireKeyConfigured, async (req, res) => {
    if (!jupiter) throw new HttpError(503, 'Jupiter is not configured');
    const quote = z.object({
      inputMint: z.string().max(44).transform(parseMint),
      outputMint: z.string().max(44).transform(parseMint),
      amount: z.string().regex(/^[1-9][0-9]{0,19}$/).refine((value) => BigInt(value) <= (1n << 64n) - 1n),
      slippageBps: z.number().int().min(0).max(1000).optional(),
    }).strict().parse(req.body);
    try {
      res.json(await jupiter.quote({ ...quote, amount: BigInt(quote.amount) }));
    } catch {
      throw new HttpError(409, 'Quote unavailable; no transaction was signed or sent');
    }
  });

  api.get('/metrics', (req, res) => {
    const mode = modeSchema.parse(req.query.mode) ?? bot.mode;
    res.json(repo.getMetrics(mode));
  });

  api.get('/tokens', (req, res) => {
    const { limit, offset } = pagination.parse(req.query);
    const search = z.string().trim().max(64).optional().parse(req.query.search) || undefined;
    res.json({ ...repo.listTokens({ limit, offset, search }), limit, offset });
  });

  api.get('/tokens/:mint', (req, res) => {
    const mint = parseMint(req.params.mint);
    const token = repo.getToken(mint);
    if (!token) throw new HttpError(404, 'Token not found');
    res.json({ ...token, livePrice: bot.livePrice(mint) ?? null });
  });

  api.get('/tokens/:mint/price', (req, res) => {
    const mint = parseMint(req.params.mint);
    const live = bot.livePrice(mint);
    if (live) return void res.json({ ...live, live: true });
    const tick = repo.getLatestPriceTick(mint);
    if (!tick) throw new HttpError(404, 'No price data for this token');
    res.json({ ...tick, live: false });
  });

  api.get('/tokens/:mint/prices', (req, res) => {
    const mint = parseMint(req.params.mint);
    const limit = z.coerce.number().int().min(1).max(5000).default(500).parse(req.query.limit);
    const since = z.coerce.number().int().min(0).optional().parse(req.query.since);
    res.json({ mint, items: repo.getPriceTicks(mint, limit, since) });
  });

  /** "RPC lite": reads the bonding curve straight from the chain. Works for any Pump.fun coin. */
  api.get('/tokens/:mint/curve', async (req, res) => {
    const mint = parseMint(req.params.mint);
    const curve = await bot.fetchCurve(mint);
    if (!curve) throw new HttpError(404, 'Bonding curve not found');
    const priceSol = priceSolPerToken(curve.virtualQuoteReserves, curve.virtualTokenReserves);
    res.json({
      mint,
      ...curve,
      priceSol,
      marketCapSol: marketCapSol(priceSol, curve.tokenTotalSupply),
      progressPercent: curve.complete ? 100 : bondingCurveProgress(curve.realTokenReserves),
    });
  });

  api.get('/prices/live', (_req, res) => {
    res.json({ items: bot.trackedPrices() });
  });

  api.get('/positions', (req, res) => {
    const { limit, offset } = pagination.parse(req.query);
    const status = z.enum(['open', 'closed', 'failed', 'migrated']).optional().parse(req.query.status);
    const mode = modeSchema.parse(req.query.mode);
    res.json({ items: repo.listPositions({ status, mode, limit, offset }), limit, offset });
  });

  api.get('/positions/open', (_req, res) => {
    res.json({ items: bot.openPositions() });
  });

  api.get('/positions/:id', (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const position = repo.getPosition(id);
    if (!position) throw new HttpError(404, 'Position not found');
    res.json({ ...position, trades: repo.listTrades({ limit: 50, offset: 0, mint: position.mint }) });
  });

  api.post('/positions/:mint/sell', requireKeyConfigured, async (req, res) => {
    confirmation.parse(req.body);
    const mint = parseMint(req.params.mint);
    if (bot.mode === 'live') throw new HttpError(409, 'Live liquidation is not supported');
    try {
      res.json(await bot.sellPosition(mint));
    } catch (error) {
      // Upstream transport errors can contain RPC credentials; never forward them.
      throw new HttpError(409, errorMessage(error) === 'No open position' ? 'No open position' : 'Position could not be sold');
    }
  });

  let liquidating = false;
  api.post('/positions/liquidate', requireKeyConfigured, async (req, res) => {
    confirmation.parse(req.body);
    if (liquidating || configuringOperation) throw new HttpError(409, 'Another control operation is in progress');
    if (bot.mode === 'live') throw new HttpError(409, 'Live liquidation is not supported');
    const positions = bot.openPositions();
    if (positions.length > 50) throw new HttpError(409, 'Too many positions; sell individually');
    liquidating = true;
    try {
      bot.pause();
      const items: { mint: string; success: boolean }[] = [];
      for (const position of positions) {
        try {
          await bot.sellPosition(position.mint);
          items.push({ mint: position.mint, success: true });
        } catch {
          items.push({ mint: position.mint, success: false });
        }
      }
      res.json({ items, paused: true });
    } finally {
      liquidating = false;
    }
  });

  api.get('/trades', (req, res) => {
    const { limit, offset } = pagination.parse(req.query);
    const mode = modeSchema.parse(req.query.mode);
    const mint = req.query.mint ? parseMint(req.query.mint) : undefined;
    res.json({ items: repo.listTrades({ limit, offset, mint, mode }), limit, offset });
  });

  api.post('/bot/pause', requireKeyConfigured, (_req, res) => {
    pauseRevision++;
    bot.pause();
    res.json({ paused: true });
  });

  api.post('/bot/resume', requireKeyConfigured, (_req, res) => {
    if (configuringOperation || liquidating) throw new HttpError(409, 'Another control operation is in progress');
    if (bot.mode === 'live') throw new HttpError(409, 'Live execution is not supported');
    bot.resume();
    res.json({ paused: false });
  });

  app.use('/api', api);

  app.use((_req, _res, next) => next(new HttpError(404, 'Not found')));

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) return void res.status(error.status).json({ error: error.message });
    if (error instanceof ZodError) {
      return void res.status(400).json({ error: 'Invalid request', details: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    if ((error as { type?: string }).type === 'entity.parse.failed') {
      return void res.status(400).json({ error: 'Invalid JSON body' });
    }
    if ((error as { type?: string }).type === 'entity.too.large') {
      return void res.status(413).json({ error: 'Request body too large' });
    }
    log.error({ path: req.route?.path ?? 'unknown' }, 'Unhandled API error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export function startApiServer(app: express.Express, host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      log.info({ url: `http://${host}:${port}` }, 'API & dashboard listening');
      resolve(server);
    });
    server.once('error', reject);
  });
}
