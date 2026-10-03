import { PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordChannel, Notifier, TelegramChannel, type AlertChannel } from '../src/alerts/notifier';
import { openDatabase, type Db } from '../src/database/db';
import { Repository } from '../src/database/repository';
import { PumpFunIndexer } from '../src/indexer/pumpfunIndexer';
import { PriceTracker } from '../src/indexer/priceTracker';
import { bondingCurvePda } from '../src/pumpfun';
import type { RpcManager } from '../src/rpc/rpcManager';
import { PositionManager } from '../src/trading/positionManager';
import { Sniper } from '../src/trading/sniper';
import { PaperTrader } from '../src/trading/trader';
import type { CurveReserves, DetectedToken } from '../src/types';
import { createTxLogs, encodeBondingCurve, makeCreateEvent, makeDetectedToken, makeTradeEvent, randomKey, testConfig } from './helpers';

/** RpcManager stand-in backed by an in-memory map of bonding curves. */
class FakeRpc {
  curves = new Map<string, Buffer>();
  currentEndpoint = 'fake';
  failing = false;
  private readonly connection = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => this.info(k)),
    getAccountInfo: async (key: PublicKey) => this.info(key),
  };
  private info(key: PublicKey) {
    if (this.failing) throw new Error('rpc down');
    const data = this.curves.get(key.toBase58());
    return data ? { data } : null;
  }
  setCurve(mint: string, r: CurveReserves, complete = false) {
    this.curves.set(
      bondingCurvePda(new PublicKey(mint)).toBase58(),
      encodeBondingCurve({
        virtualSolReserves: r.virtualSolReserves,
        virtualTokenReserves: r.virtualTokenReserves,
        realSolReserves: r.realSolReserves,
        realTokenReserves: r.realTokenReserves,
        complete,
      }),
    );
  }
  async call<T>(_label: string, fn: (c: unknown) => Promise<T>): Promise<T> {
    return fn(this.connection);
  }
}

class MemoryChannel implements AlertChannel {
  readonly name = 'memory';
  messages: string[] = [];
  async send(text: string) {
    this.messages.push(text);
  }
}

/** Reserves after someone else bought `extraSol` lamports worth. */
function pumped(r: CurveReserves, extraSol: bigint): CurveReserves {
  const k = r.virtualSolReserves * r.virtualTokenReserves;
  const vSol = r.virtualSolReserves + extraSol;
  const vTok = k / vSol;
  return {
    virtualSolReserves: vSol,
    virtualTokenReserves: vTok,
    realSolReserves: r.realSolReserves + extraSol,
    realTokenReserves: r.realTokenReserves - (r.virtualTokenReserves - vTok),
  };
}

describe('repository', () => {
  let db: Db;
  let repo: Repository;
  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new Repository(db);
  });
  afterEach(() => db.close());

  it('stores and searches tokens, ignoring duplicates', () => {
    const token = makeDetectedToken({ name: 'Doge Moon', symbol: 'DMOON', devBuySol: 1_500_000_000n });
    expect(repo.insertToken(token)).toBe(true);
    expect(repo.insertToken(token)).toBe(false);
    const stored = repo.getToken(token.mint)!;
    expect(stored).toMatchObject({ mint: token.mint, symbol: 'DMOON', devBuySol: 1.5, isMayhemMode: false });
    expect(repo.listTokens({ limit: 10, offset: 0, search: 'moon' }).total).toBe(1);
    expect(repo.listTokens({ limit: 10, offset: 0, search: 'zzz' }).items).toEqual([]);
    expect(repo.listTokens({ limit: 10, offset: 0 }).items).toHaveLength(1);
    repo.insertToken(makeDetectedToken({ name: '100% PUMP', symbol: 'P_1' }));
    expect(repo.listTokens({ limit: 10, offset: 0, search: '%' }).items.map((t) => t.symbol)).toEqual(['P_1']);
    expect(repo.listTokens({ limit: 10, offset: 0, search: '_' }).items.map((t) => t.symbol)).toEqual(['P_1']);
  });

  it('keeps price ticks and prunes old ones', () => {
    const now = Date.now();
    repo.insertPriceTick({ mint: 'm', priceSol: 1, marketCapSol: 2, virtualSolReserves: 1n, virtualTokenReserves: 2n, realSolReserves: 0n, realTokenReserves: 3n, source: 'stream', recordedAt: now - 10_000 });
    repo.insertPriceTick({ mint: 'm', priceSol: 3, marketCapSol: 4, virtualSolReserves: 1n, virtualTokenReserves: 2n, realSolReserves: 0n, realTokenReserves: 3n, source: 'poll', recordedAt: now });
    expect(repo.getLatestPriceTick('m')?.priceSol).toBe(3);
    expect(repo.getPriceTicks('m', 10)).toHaveLength(2);
    expect(repo.prunePriceTicks(now - 1)).toBe(1);
  });

  it('computes performance metrics', () => {
    const base = { name: 'n', symbol: 's', mode: 'paper' as const, tokenProgram: 't', creator: 'c', tokenAmount: 1n, entryPrice: 1, buySignature: null, openedAt: 0 };
    const win = repo.createPosition({ ...base, mint: 'a', solSpent: 1 });
    const loss = repo.createPosition({ ...base, mint: 'b', solSpent: 1 });
    repo.createPosition({ ...base, mint: 'c', solSpent: 1 });
    repo.createPosition({ ...base, mint: 'live', solSpent: 1, mode: 'live' });
    repo.closePosition(win.id, { status: 'closed', solReceived: 1.5, pnlSol: 0.5, pnlPercent: 50, exitReason: 'take_profit', closedAt: 10_000 });
    repo.closePosition(loss.id, { status: 'closed', solReceived: 0.9, pnlSol: -0.1, pnlPercent: -10, exitReason: 'stop_loss', closedAt: 20_000 });
    const m = repo.getMetrics('paper');
    expect(m).toMatchObject({ totalPositions: 3, openPositions: 1, closedPositions: 2, wins: 1, losses: 1, winRate: 50 });
    expect(m.totalPnlSol).toBeCloseTo(0.4);
    expect(m.exitReasons).toEqual({ take_profit: 1, stop_loss: 1 });
    expect(repo.getOpenPositions('paper').map((p) => p.mint)).toEqual(['c']);
    expect(repo.listPositions({ limit: 10, offset: 0 })).toHaveLength(4);
    expect(repo.listPositions({ status: 'closed', limit: 10, offset: 0 })).toHaveLength(2);
    expect(repo.listPositions({ mode: 'live', limit: 10, offset: 0 })).toHaveLength(1);
  });
});

describe('indexer', () => {
  it('detects new tokens from log notifications with post-dev-buy reserves', () => {
    const indexer = new PumpFunIndexer(new FakeRpc() as unknown as RpcManager, { commitment: 'processed', heartbeatTimeoutMs: 30_000 });
    const tokens: DetectedToken[] = [];
    const trades: unknown[] = [];
    indexer.on('token', (t) => tokens.push(t));
    indexer.on('trade', (t) => trades.push(t));

    const create = makeCreateEvent();
    const devBuy = makeTradeEvent({ mint: create.mint, solAmount: 2_000_000_000n });
    const logs = { signature: 'sig1', err: null, logs: createTxLogs(create, devBuy) };
    indexer.onLogs(logs, { slot: 42 });
    indexer.onLogs(logs, { slot: 42 }); // duplicate notification
    indexer.onLogs({ ...logs, err: { InstructionError: [0, 'Custom'] } }, { slot: 43 });

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      mint: create.mint,
      symbol: 'TEST',
      slot: 42,
      signature: 'sig1',
      devBuySol: 2_000_000_000n,
      reserves: { virtualSolReserves: devBuy.virtualSolReserves, realTokenReserves: devBuy.realTokenReserves },
    });
    expect(tokens[0].marketCapSol).toBeGreaterThan(0);
    expect(trades).toHaveLength(2);
    expect(indexer.getStats()).toMatchObject({ messagesReceived: 3, tokensDetected: 1, tradesSeen: 2 });
  });
});

describe('sniper + position manager (paper trading)', () => {
  let db: Db;
  let repo: Repository;
  let rpc: FakeRpc;
  let alerts: MemoryChannel;
  let positions: PositionManager;
  let sniper: Sniper;

  const setup = (env: Record<string, string> = {}) => {
    const cfg = testConfig({ NO_GAIN_EXIT_SECONDS: '20', TAKE_PROFIT_PERCENT: '50', STOP_LOSS_PERCENT: '10', ...env });
    db = openDatabase(':memory:');
    repo = new Repository(db);
    rpc = new FakeRpc();
    alerts = new MemoryChannel();
    const notifier = new Notifier([alerts], false, '[PAPER] ');
    const trader = new PaperTrader(cfg.trading);
    const prices = new PriceTracker(repo, { trackNewTokensSeconds: 300, maxTrackedTokens: 100, tickIntervalMs: 0 });
    positions = new PositionManager(repo, trader, rpc as unknown as RpcManager, prices, notifier, cfg);
    sniper = new Sniper(repo, trader, positions, prices, notifier, cfg.trading);
  };
  afterEach(() => {
    positions.stop();
    db.close();
    vi.useRealTimers();
  });

  it('buys a fresh token and takes profit when it pumps', async () => {
    setup();
    const token = makeDetectedToken();
    await sniper.onToken(token);
    expect(positions.openCount).toBe(1);
    const [open] = repo.getOpenPositions('paper');
    expect(open.solSpent).toBeGreaterThan(0.01);
    expect(open.tokenAmount).toBeGreaterThan(0n);
    expect(repo.getToken(token.mint)).not.toBeNull();

    // someone buys 10 SOL after us → big pump
    const after = pumped(token.reserves, 10_000_000_000n);
    rpc.setCurve(token.mint, after);
    await positions.tick();
    await vi.waitFor(() => expect(positions.openCount).toBe(0));

    const closed = repo.getPosition(open.id)!;
    expect(closed).toMatchObject({ status: 'closed', exitReason: 'take_profit' });
    expect(closed.pnlPercent!).toBeGreaterThan(50);
    expect(repo.listTrades({ limit: 10, offset: 0 }).map((t) => t.side).sort()).toEqual(['buy', 'sell']);
    expect(repo.getMetrics('paper')).toMatchObject({ wins: 1, closedPositions: 1 });
    await vi.waitFor(() => expect(alerts.messages.some((m) => m.includes('[PAPER]'))).toBe(true));
  });

  it('cuts losses on dumps (stop loss) using the live trade stream', async () => {
    setup();
    const token = makeDetectedToken();
    await sniper.onToken(token);
    const [open] = repo.getOpenPositions('paper');
    // dev sells: price drops ~30%
    const k = token.reserves.virtualSolReserves * token.reserves.virtualTokenReserves;
    const vSol = (token.reserves.virtualSolReserves * 8n) / 10n;
    const dumped = { ...token.reserves, virtualSolReserves: vSol, virtualTokenReserves: k / vSol };
    rpc.setCurve(token.mint, dumped);
    positions.onTrade(makeTradeEvent({ mint: token.mint, isBuy: false, ...dumped }));
    await vi.waitFor(() => expect(repo.getPosition(open.id)?.status).toBe('closed'));
    expect(repo.getPosition(open.id)).toMatchObject({ exitReason: 'stop_loss' });
    expect(repo.getPosition(open.id)!.pnlPercent!).toBeLessThan(-10);
  });

  it('exits quickly when the token does not appreciate', async () => {
    setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    const token = makeDetectedToken({ timestamp: Math.floor(Date.now() / 1000) });
    await sniper.onToken(token);
    rpc.setCurve(token.mint, token.reserves);
    await positions.tick();
    expect(positions.openCount).toBe(1);
    vi.setSystemTime(Date.now() + 21_000);
    await positions.tick();
    expect(positions.openCount).toBe(0);
    const [closed] = repo.listPositions({ status: 'closed', limit: 1, offset: 0 });
    expect(closed.exitReason).toBe('no_gain_timeout');
  });

  it('marks graduated coins as migrated', async () => {
    setup();
    const token = makeDetectedToken();
    await sniper.onToken(token);
    rpc.setCurve(token.mint, token.reserves, true);
    await positions.tick();
    expect(repo.listPositions({ status: 'migrated', limit: 5, offset: 0 })).toHaveLength(1);
  });

  it('applies the buy filters', async () => {
    setup({ MAX_OPEN_POSITIONS: '1', MAX_DEV_BUY_SOL: '1' });
    const old = makeDetectedToken({ timestamp: Math.floor(Date.now() / 1000) - 60 });
    expect(sniper.shouldSkip(old)).toBe('too_old');
    expect(sniper.shouldSkip(makeDetectedToken({ isMayhemMode: true }))).toBe('mayhem_mode');
    expect(sniper.shouldSkip(makeDetectedToken({ quoteMint: randomKey().toBase58() }))).toBe('non_sol_quote');
    expect(sniper.shouldSkip(makeDetectedToken({ devBuySol: 3_000_000_000n }))).toBe('dev_buy_too_large');

    await sniper.onToken(makeDetectedToken());
    expect(sniper.shouldSkip(makeDetectedToken())).toBe('max_positions');
    sniper.pause();
    expect(sniper.shouldSkip(makeDetectedToken())).toBe('paused');
    expect(sniper.getStats()).toMatchObject({ tokensSeen: 1, buysSucceeded: 1, paused: true });
  });

  it('sells manually from detection reserves even when the RPC is down', async () => {
    setup();
    const token = makeDetectedToken();
    await sniper.onToken(token);
    rpc.failing = true;
    const [open] = repo.getOpenPositions('paper');
    // reserves are known from detection, so paper sell still works even if RPC is down
    const closed = await positions.sellNow(token.mint);
    expect(closed).toMatchObject({ id: open.id, status: 'closed', exitReason: 'manual' });
    await expect(positions.sellNow(token.mint)).rejects.toThrow(/No open position/);
  });

  it('resumes open positions after a restart', async () => {
    setup();
    await sniper.onToken(makeDetectedToken());
    positions.stop();
    const cfg = testConfig();
    const prices = new PriceTracker(repo, { trackNewTokensSeconds: 0, maxTrackedTokens: 10, tickIntervalMs: 0 });
    const restarted = new PositionManager(repo, new PaperTrader(cfg.trading), rpc as unknown as RpcManager, prices, new Notifier([]), cfg);
    restarted.start();
    expect(restarted.openCount).toBe(1);
    restarted.stop();
  });
});

describe('alert channels', () => {
  it('posts to Discord and Telegram', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await new DiscordChannel('https://discord.example/webhook', fetchFn).send('hello');
    await new TelegramChannel('TOKEN', '123', fetchFn).send('hi');
    expect(calls[0]).toEqual({ url: 'https://discord.example/webhook', body: expect.objectContaining({ content: 'hello' }) });
    expect(calls[1].url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(calls[1].body).toMatchObject({ chat_id: '123', text: 'hi' });
  });

  it('never throws when a channel fails', async () => {
    const failing: AlertChannel = { name: 'x', send: async () => Promise.reject(new Error('boom')) };
    await expect(new Notifier([failing]).send('test')).resolves.toBeUndefined();
  });
});

describe('price tracker', () => {
  it('tracks SOL-paired new tokens and records ticks from the trade stream', () => {
    const db = openDatabase(':memory:');
    const repo = new Repository(db);
    const prices = new PriceTracker(repo, { trackNewTokensSeconds: 300, maxTrackedTokens: 10, tickIntervalMs: 0 });
    const token = makeDetectedToken();
    repo.insertToken(token);
    prices.trackNewToken(token);
    prices.trackNewToken(makeDetectedToken({ quoteMint: randomKey().toBase58() })); // non-SOL quote: ignored
    expect(prices.size).toBe(1);
    const trade = makeTradeEvent({ mint: token.mint });
    expect(prices.onTrade(trade)?.priceSol).toBeGreaterThan(token.priceSol);
    expect(repo.getLatestPriceTick(token.mint)).toMatchObject({ source: 'stream' });
    expect(repo.getToken(token.mint)?.lastPriceSol).toBeGreaterThan(0);
    db.close();
  });
});
