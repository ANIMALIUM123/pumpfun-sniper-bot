import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { PublicKey } from '@solana/web3.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import type { BotController } from '../bot';
import type { Repository } from '../database/repository';
import { bondingCurveProgress, marketCapSol, priceSolPerToken } from '../pumpfun';
import { errorMessage } from '../utils/async';
import { getLogger } from '../utils/logger';
import { DASHBOARD_HTML, DASHBOARD_JS } from './dashboard';

export interface ApiOptions {
  repo: Repository;
  bot: BotController;
  /** When set, every `/api` request must send it via `x-api-key` or `Authorization: Bearer`. */
  apiKey?: string;
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

export function createApp({ repo, bot, apiKey }: ApiOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('json replacer', (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
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

  /** Mutating endpoints are only available when an API key is configured. */
  const requireKeyConfigured = (_req: Request, _res: Response, next: NextFunction) => {
    if (!apiKey) return next(new HttpError(403, 'Set API_KEY to enable control endpoints'));
    next();
  };

  api.get('/status', (_req, res) => {
    res.json(bot.status());
  });

  api.get('/config', (_req, res) => {
    res.json(bot.publicConfig());
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
    const mint = parseMint(req.params.mint);
    try {
      res.json(await bot.sellPosition(mint));
    } catch (error) {
      throw new HttpError(409, errorMessage(error));
    }
  });

  api.get('/trades', (req, res) => {
    const { limit, offset } = pagination.parse(req.query);
    const mode = modeSchema.parse(req.query.mode);
    const mint = req.query.mint ? parseMint(req.query.mint) : undefined;
    res.json({ items: repo.listTrades({ limit, offset, mint, mode }), limit, offset });
  });

  api.post('/bot/pause', requireKeyConfigured, (_req, res) => {
    bot.pause();
    res.json({ paused: true });
  });

  api.post('/bot/resume', requireKeyConfigured, (_req, res) => {
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
    log.error({ path: req.path, err: errorMessage(error) }, 'Unhandled API error');
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
