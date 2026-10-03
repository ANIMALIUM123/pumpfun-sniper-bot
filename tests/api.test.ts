import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/api/server';
import type { BotController, BotStatus } from '../src/bot';
import { publicConfig } from '../src/config';
import { openDatabase, type Db } from '../src/database/db';
import { Repository } from '../src/database/repository';
import { makeDetectedToken, randomKey, testConfig } from './helpers';

function fakeBot(): BotController & { paused: boolean } {
  const cfg = testConfig({ API_KEY: 'secret', WALLET_PRIVATE_KEY: 'should-not-leak' });
  const status = (): BotStatus => ({
    mode: 'paper',
    startedAt: 0,
    uptimeSeconds: 5,
    wallet: null,
    walletBalanceSol: null,
    rpcEndpoint: 'https://rpc.example',
    indexer: {
      running: true,
      endpoint: 'x',
      messagesReceived: 1,
      tokensDetected: 1,
      tradesSeen: 0,
      recoveredFromTx: 0,
      reconnects: 0,
      lastMessageAt: null,
      lastTokenAt: null,
      subscribedAt: null,
      avgDetectionLatencyMs: null,
    },
    sniper: { paused: bot.paused, tokensSeen: 1, buysAttempted: 0, buysSucceeded: 0, buysFailed: 0, inFlight: 0, skipped: {}, lastBuyAt: null },
    openPositions: 0,
    trackedTokens: 0,
  });
  const bot = {
    mode: 'paper' as const,
    paused: false,
    status,
    pause: () => void (bot.paused = true),
    resume: () => void (bot.paused = false),
    openPositions: () => [],
    sellPosition: vi.fn(async () => {
      throw new Error('No open position');
    }),
    livePrice: () => undefined,
    trackedPrices: () => [],
    fetchCurve: vi.fn(async () => ({
      virtualTokenReserves: 1_073_000_000_000_000n,
      virtualQuoteReserves: 30_000_000_000n,
      realTokenReserves: 793_100_000_000_000n,
      realQuoteReserves: 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: false,
      creator: null,
      isMayhemMode: false,
      isCashbackCoin: false,
      quoteMint: null,
    })),
    publicConfig: () => publicConfig(cfg),
  };
  return bot;
}

describe('REST API', () => {
  let db: Db;
  let repo: Repository;
  let bot: ReturnType<typeof fakeBot>;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new Repository(db);
    bot = fakeBot();
  });
  afterEach(() => db.close());

  describe('without API key', () => {
    const app = () => createApp({ repo, bot });

    it('serves health, dashboard and security headers', async () => {
      const health = await request(app()).get('/health').expect(200);
      expect(health.body).toMatchObject({ ok: true, mode: 'paper' });
      expect(health.headers['x-content-type-options']).toBe('nosniff');
      expect(health.headers['x-powered-by']).toBeUndefined();
      const page = await request(app()).get('/').expect(200);
      expect(page.text).toContain('Pump.fun Sniper');
      expect(page.headers['content-security-policy']).toContain("script-src 'self'");
      await request(app()).get('/dashboard.js').expect('content-type', /javascript/).expect(200);
    });

    it('lists and fetches tokens with bigint-safe JSON', async () => {
      const token = makeDetectedToken({ symbol: 'PEPE' });
      repo.insertToken(token);
      const list = await request(app()).get('/api/tokens?limit=10&search=pep').expect(200);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0].mint).toBe(token.mint);
      const one = await request(app()).get(`/api/tokens/${token.mint}`).expect(200);
      expect(one.body.tokenTotalSupply).toBe('1000000000000000');
      await request(app()).get(`/api/tokens/${randomKey().toBase58()}`).expect(404);
      await request(app()).get('/api/tokens/not-a-mint').expect(400);
      await request(app()).get('/api/tokens?limit=100000').expect(400);
    });

    it('reads bonding curves from chain (RPC lite)', async () => {
      const res = await request(app()).get(`/api/tokens/${randomKey().toBase58()}/curve`).expect(200);
      expect(res.body.virtualQuoteReserves).toBe('30000000000');
      expect(res.body.marketCapSol).toBeCloseTo(27.96, 1);
      expect(res.body.progressPercent).toBe(0);
    });

    it('exposes status, metrics, positions, trades and config without secrets', async () => {
      expect((await request(app()).get('/api/status').expect(200)).body.mode).toBe('paper');
      expect((await request(app()).get('/api/metrics').expect(200)).body.totalPositions).toBe(0);
      expect((await request(app()).get('/api/positions?status=open').expect(200)).body.items).toEqual([]);
      await request(app()).get('/api/positions?status=bogus').expect(400);
      expect((await request(app()).get('/api/positions/open').expect(200)).body.items).toEqual([]);
      expect((await request(app()).get('/api/trades').expect(200)).body.items).toEqual([]);
      const cfg = await request(app()).get('/api/config').expect(200);
      expect(JSON.stringify(cfg.body)).not.toContain('should-not-leak');
      expect(JSON.stringify(cfg.body)).not.toContain('secret');
      await request(app()).get('/api/nope').expect(404);
    });

    it('refuses control endpoints when no API key is configured', async () => {
      await request(app()).post('/api/bot/pause').expect(403);
      expect(bot.paused).toBe(false);
    });
  });

  describe('with API key', () => {
    const app = () => createApp({ repo, bot, apiKey: 'secret' });

    it('requires the key', async () => {
      await request(app()).get('/api/status').expect(401);
      await request(app()).get('/api/status').set('x-api-key', 'wrong').expect(401);
      await request(app()).get('/api/status').set('x-api-key', 'secret').expect(200);
      await request(app()).get('/api/status').set('authorization', ['Bearer', 'secret'].join(' ')).expect(200);
      await request(app()).get('/health').expect(200);
    });

    it('pauses/resumes and sells', async () => {
      await request(app()).post('/api/bot/pause').set('x-api-key', 'secret').expect(200, { paused: true });
      expect(bot.paused).toBe(true);
      await request(app()).post('/api/bot/resume').set('x-api-key', 'secret').expect(200, { paused: false });
      const res = await request(app()).post(`/api/positions/${randomKey().toBase58()}/sell`).set('x-api-key', 'secret').expect(409);
      expect(res.body.error).toContain('No open position');
    });
  });
});
