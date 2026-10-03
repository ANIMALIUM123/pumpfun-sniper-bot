import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/api/server';
import type { BotController, BotStatus } from '../src/bot';
import { publicConfig } from '../src/config';
import { openDatabase, type Db } from '../src/database/db';
import { Repository } from '../src/database/repository';
import type { WalletVault } from '../src/wallet';
import type { JupiterClient } from '../src/jupiter';
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
      expect(page.text).toContain('lang="pt-BR"');
      expect(page.text).toContain('Copy Trade');
      expect(page.text).toContain('Configurações');
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
      expect(JSON.stringify(cfg.body)).not.toContain('rpc.example');
      const status = await request(app()).get('/api/status').expect(200);
      expect(status.body.rpcEndpoint).toBe('[server configured]');
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
      await request(app()).post(`/api/positions/${randomKey().toBase58()}/sell`).set('x-api-key', 'secret').expect(400);
      expect(bot.sellPosition).not.toHaveBeenCalled();
      const res = await request(app()).post(`/api/positions/${randomKey().toBase58()}/sell`).set('x-api-key', 'secret').send({ confirmed: true }).expect(409);
      expect(res.body.error).toContain('No open position');
    });

    it('rejects rebinding, cross-origin requests and unsupported methods', async () => {
      const server = app();
      await request(server).get('/health').set('Host', 'evil.example').expect(403);
      await request(server).get('/health').set('Host', 'localhost.evil.example').expect(403);
      await request(server).post('/api/bot/pause').set('x-api-key', 'secret').set('Origin', 'https://evil.example').expect(403);
      await request(server).post('/api/bot/pause').set('x-api-key', 'secret').set('sec-fetch-site', 'cross-site').expect(403);
      await request(server).options('/api/status').expect(405);
      await request(server).delete('/api/bot/pause').set('x-api-key', 'secret').expect(405);
      expect(bot.paused).toBe(false);
      const safe = await request(server).get('/api/status').set('x-api-key', 'secret').set('Host', 'localhost:3000').set('Origin', 'http://localhost:3000').expect(200);
      expect(safe.headers['access-control-allow-origin']).toBeUndefined();
      expect(safe.headers['cache-control']).toBe('no-store');
      const proxy = createApp({ repo, bot, apiKey: 'secret', allowedHosts: ['dashboard.example'], allowedOrigins: ['https://dashboard.example', 'https://evil.example'] });
      await request(proxy).get('/api/status').set('x-api-key', 'secret').set('Host', 'dashboard.example').set('Origin', 'https://dashboard.example').expect(200);
      await request(proxy).get('/api/status').set('x-api-key', 'secret').set('Host', 'dashboard.example').set('Origin', 'https://evil.example').expect(403);
    });

    it('rate limits mutations with a bounded bucket', async () => {
      const server = app();
      for (let i = 0; i < 30; i++) await request(server).post('/api/bot/pause').set('x-api-key', 'secret').expect(200);
      await request(server).post('/api/bot/pause').set('x-api-key', 'secret').expect(429);
    });

    it('requires explicit liquidation and does not liquidate when pausing', async () => {
      const server = app();
      await request(server).post('/api/bot/pause').set('x-api-key', 'secret').expect(200);
      expect(bot.sellPosition).not.toHaveBeenCalled();
      await request(server).post('/api/positions/liquidate').set('x-api-key', 'secret').send({ confirmed: false }).expect(400);
      await request(server).post('/api/positions/liquidate').set('x-api-key', 'secret').send({ confirmed: true }).expect(200, { items: [], paused: true });
    });

    it('protects wallet metadata and reauthenticates sensitive exports without caching', async () => {
      const bytes = Array<number>(64).fill(7);
      const vault = {
        status: () => ({ publicAddress: randomKey().toBase58(), locked: true, canSign: false, kind: 'local' }),
        create: vi.fn(async () => undefined),
        unlock: vi.fn(async () => undefined),
        lock: vi.fn(),
        export: vi.fn(async (password: string) => {
          if (password !== 'test-password-123') throw new Error('secret RPC endpoint details');
          return bytes;
        }),
      };
      const server = createApp({ repo, bot, apiKey: 'secret', wallet: vault as unknown as WalletVault });
      await request(server).get('/api/wallet/status').expect(401);
      const status = await request(server).get('/api/wallet/status').set('x-api-key', 'secret').expect(200);
      expect(Object.keys(status.body).sort()).toEqual(['balanceSol', 'capability', 'locked', 'publicKey']);
      await request(server).post('/api/wallet/create').set('x-api-key', 'secret').send({ password: 'short' }).expect(400);
      await request(server).post('/api/wallet/create').set('x-api-key', 'secret').send({ password: 'test-password-123' }).expect(200);
      await request(server).post('/api/wallet/unlock').set('x-api-key', 'secret').send({ password: 'test-password-123' }).expect(200);
      await request(server).post('/api/wallet/lock').set('x-api-key', 'secret').expect(200);
      await request(server).post('/api/wallet/export').set('x-api-key', 'secret').send({ password: 'test-password-123' }).expect(400);
      const refused = await request(server).post('/api/wallet/export').set('x-api-key', 'secret').send({ password: 'wrong-password-123', confirmed: true }).expect(403);
      expect(JSON.stringify(refused.body)).not.toContain('RPC');
      const exported = await request(server).post('/api/wallet/export').set('x-api-key', 'secret').send({ password: 'test-password-123', confirmed: true }).expect(200);
      expect(exported.body).toEqual(Array<number>(64).fill(7));
      expect(bytes.every(value => value === 0)).toBe(true);
      expect(exported.headers['cache-control']).toBe('no-store');
      expect(exported.headers.pragma).toBe('no-cache');
      expect(exported.headers['content-disposition']).toContain('attachment');
      expect(vault.export).toHaveBeenCalledTimes(2);
      await request(server).post('/api/wallet/sign').set('x-api-key', 'secret').send({ transaction: 'arbitrary' }).expect(404);
      await request(createApp({ repo, bot, wallet: vault as unknown as WalletVault })).get('/api/wallet/status').expect(403);
    });

    it('offers bounded quote-only Jupiter requests without signing or endpoint disclosure', async () => {
      const client = {
        status: () => ({ endpoint: 'https://private-endpoint?api-key=sensitive', configured: true, quoteOnly: true, liveExecutionSupported: false }),
        quote: vi.fn(async () => ({ outAmount: '100', expiresAt: Date.now() + 1000 })),
      };
      const server = createApp({ repo, bot, apiKey: 'secret', jupiter: client as unknown as JupiterClient });
      const status = await request(server).get('/api/jupiter/status').set('x-api-key', 'secret').expect(200);
      expect(status.body.liveExecutionSupported).toBe(false);
      expect(JSON.stringify(status.body)).not.toContain('sensitive');
      const body = { inputMint: randomKey().toBase58(), outputMint: randomKey().toBase58(), amount: '1000', slippageBps: 50 };
      await request(server).post('/api/jupiter/quote').send(body).expect(401);
      await request(server).post('/api/jupiter/quote').set('x-api-key', 'secret').send({ ...body, amount: '18446744073709551616' }).expect(400);
      await request(server).post('/api/jupiter/quote').set('x-api-key', 'secret').send({ ...body, transaction: 'arbitrary' }).expect(400);
      await request(server).post('/api/jupiter/quote').set('x-api-key', 'secret').send(body).expect(200);
      expect(client.quote).toHaveBeenCalledTimes(1);
      await request(server).post('/api/jupiter/swap').set('x-api-key', 'secret').send(body).expect(404);
    });

    it('uses authoritative exclusive operation modes and validates copy settings', async () => {
      let active: 'idle' | 'sniper' | 'copytrade' = 'idle';
      const controller = {
        ...bot,
        operationStatus: () => ({ mode: active, paused: bot.paused }),
        setOperation: vi.fn(async (mode: 'idle' | 'sniper' | 'copytrade') => { active = mode; }),
        copySettings: () => ({ wallets: [], execution: 'paper', enabled: false }),
        configureCopy: vi.fn(async (settings: unknown) => settings),
        operationLogs: () => [{ id: 1, createdAt: 1, event: 'copy_error', detail: { error: 'credential-do-not-return', wallet: 'public-address', durationMs: 10 } }],
      };
      const server = createApp({ repo, bot: controller, apiKey: 'secret' });
      await request(server).get('/api/operation').set('x-api-key', 'secret').expect(200, { mode: 'idle', paused: false });
      expect(controller.setOperation).not.toHaveBeenCalled();
      await request(server).post('/api/operation').set('x-api-key', 'secret').send({ mode: 'sniper' }).expect(400);
      await request(server).post('/api/operation').set('x-api-key', 'secret').send({ mode: 'copy', confirmed: true }).expect(400);
      await request(server).post('/api/operation').set('x-api-key', 'secret').send({ mode: 'sniper', confirmed: true }).expect(200, { mode: 'sniper', paused: false });
      await request(server).post('/api/operation').set('x-api-key', 'secret').send({ mode: 'copytrade', confirmed: true }).expect(200, { mode: 'copytrade', paused: false });
      await request(server).post('/api/operation').set('x-api-key', 'secret').send({ mode: 'idle', confirmed: true }).expect(200, { mode: 'idle', paused: false });
      expect(controller.setOperation.mock.calls.map(call => call[0])).toEqual(['sniper', 'copytrade', 'idle']);
      await request(server).get('/api/copy/settings').expect(401);
      await request(server).get('/api/copy/settings').set('x-api-key', 'secret').expect(200);
      await request(server).put('/api/copy/settings').set('x-api-key', 'secret').send({ wallets: [randomKey().toBase58()], sizing: 'proportional', proportionBps: 1000, maxBuySol: 0.05 }).expect(200);
      await request(server).put('/api/copy/settings').set('x-api-key', 'secret').send({ proportionBps: 10001 }).expect(400);
      await request(server).put('/api/copy/settings').set('x-api-key', 'secret').send({ wallets: Array(11).fill(randomKey().toBase58()) }).expect(400);
      await request(server).put('/api/copy/settings').set('x-api-key', 'secret').send({ execution: 'live' }).expect(409);
      await request(server).put('/api/copy/settings').set('x-api-key', 'secret').send({ privateKey: 'arbitrary' }).expect(400);
      expect(controller.configureCopy).toHaveBeenCalledTimes(1);
      const logs = await request(server).get('/api/operation/logs').set('x-api-key', 'secret').expect(200);
      expect(logs.body.items[0].detail.durationMs).toBe(10);
      expect(JSON.stringify(logs.body)).not.toContain('credential');
    });

    it('fails closed on unsupported live sends while permitting emergency pause', async () => {
      const live = { ...bot, mode: 'live' as const, status: () => ({ ...bot.status(), mode: 'live' as const }), setOperation: vi.fn() };
      const server = createApp({ repo, bot: live, apiKey: 'secret' });
      await request(server).post('/api/operation').set('x-api-key', 'secret').send({ mode: 'sniper', confirmed: true }).expect(409);
      await request(server).post('/api/bot/resume').set('x-api-key', 'secret').expect(409);
      await request(server).post('/api/bot/pause').set('x-api-key', 'secret').expect(200);
      await request(server).post(`/api/positions/${randomKey().toBase58()}/sell`).set('x-api-key', 'secret').send({ confirmed: true }).expect(409);
      await request(server).post('/api/positions/liquidate').set('x-api-key', 'secret').send({ confirmed: true }).expect(409);
      expect(bot.sellPosition).not.toHaveBeenCalled();
      expect(live.setOperation).not.toHaveBeenCalled();
    });

    it('an emergency pause wins over an in-flight start and overlapping controls are rejected', async () => {
      let release!: () => void;
      let entered!: () => void;
      const starting = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const controller = {
        ...bot,
        operationStatus: () => ({ mode: 'sniper', paused: bot.paused }),
        setOperation: vi.fn(async () => { entered(); await gate; }),
      };
      const server = createApp({ repo, bot: controller, apiKey: 'secret' });
      const pending = request(server).post('/api/operation').set('x-api-key', 'secret').send({ mode: 'sniper', confirmed: true }).then(response => response);
      await starting;
      await request(server).post('/api/operation').set('x-api-key', 'secret').send({ mode: 'idle', confirmed: true }).expect(409);
      await request(server).post('/api/bot/resume').set('x-api-key', 'secret').expect(409);
      await request(server).post('/api/bot/pause').set('x-api-key', 'secret').expect(200);
      release();
      expect((await pending).body.paused).toBe(true);
      expect(bot.paused).toBe(true);
    });
  });
});
