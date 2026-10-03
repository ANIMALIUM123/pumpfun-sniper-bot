import { PublicKey, TransactionMessage, VersionedTransaction, type VersionedTransactionResponse } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Notifier } from '../src/alerts/notifier';
import { Bot } from '../src/bot';
import { CopyTradeEngine, supportedPaperMint } from '../src/copytrade/engine';
import { DEFAULT_COPY_SETTINGS, validateCopySettings } from '../src/copytrade/settings';
import { decodeCopySignal, fractionalAmount, type CopySignal } from '../src/copytrade/signals';
import { migrate, openDatabase, type Db } from '../src/database/db';
import { Repository } from '../src/database/repository';
import { PriceTracker } from '../src/indexer/priceTracker';
import { DEFAULT_BUYBACK_FEE_RECIPIENTS, DEFAULT_FEE_RECIPIENTS, PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  associatedTokenAddress, buildBuyExactQuoteInV2Instruction, buildSellV2Instruction } from '../src/pumpfun';
import type { RpcManager } from '../src/rpc/rpcManager';
import { OperationManager } from '../src/trading/operationManager';
import { PositionManager } from '../src/trading/positionManager';
import { PaperTrader } from '../src/trading/trader';
import type { TradeEventData } from '../src/types';
import { encodeBondingCurve, encodeTradeEvent, makeDetectedToken, makeTradeEvent, randomKey, testConfig } from './helpers';

function sourceTransaction(trade: TradeEventData): VersionedTransactionResponse {
  const user = new PublicKey(trade.user);
  const mint = new PublicKey(trade.mint);
  const params = { user, mint, creator: randomKey(), baseTokenProgram: TOKEN_2022_PROGRAM_ID,
    feeRecipient: DEFAULT_FEE_RECIPIENTS[0], buybackFeeRecipient: DEFAULT_BUYBACK_FEE_RECIPIENTS[0] };
  const ix = trade.isBuy ? buildBuyExactQuoteInV2Instruction({ ...params, spendableQuoteIn: trade.solAmount, minTokensOut: 1n })
    : buildSellV2Instruction({ ...params, amount: trade.tokenAmount, minSolOutput: 0n });
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: user, recentBlockhash: randomKey().toBase58(), instructions: [ix],
  }).compileToV0Message());
  const keys = transaction.message.staticAccountKeys;
  const accountIndex = keys.findIndex((k) => k.equals(associatedTokenAddress(user, mint, TOKEN_2022_PROGRAM_ID)));
  const balance = (amount: bigint) => ({ accountIndex, mint: trade.mint, owner: trade.user,
    uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null, uiAmountString: '0' } });
  const pre = trade.isBuy ? 0n : trade.tokenAmount * 4n;
  const preBalances = keys.map(() => 2_000_000_000);
  const postBalances = [...preBalances];
  postBalances[0] += trade.isBuy ? -1_000_000_000 : 1_000_000_000;
  const pump = PUMP_PROGRAM_ID.toBase58();
  return {
    slot: 42, blockTime: Math.floor(Date.now() / 1000), transaction,
    meta: { err: null, preBalances, postBalances, fee: 5000,
      preTokenBalances: [balance(pre)], postTokenBalances: [balance(pre + (trade.isBuy ? trade.tokenAmount : -trade.tokenAmount))],
      loadedAddresses: { readonly: [], writable: [] },
      logMessages: [`Program ${pump} invoke [1]`, `Program data: ${encodeTradeEvent(trade).toString('base64')}`, `Program ${pump} success`],
    },
  } as unknown as VersionedTransactionResponse;
}

describe('conservative source transaction decoder', () => {
  it('accepts direct v2 buys and fractional sells using integer owner deltas', () => {
    for (const isBuy of [true, false]) {
      const trade = makeTradeEvent({ isBuy });
      expect(decodeCopySignal(sourceTransaction(trade), trade.user, 'source')).toMatchObject({ trade, wallet: trade.user, signature: 'source' });
    }
    expect(fractionalAmount(9_007_199_254_740_993n, 1n, 3n)).toBe(3_002_399_751_580_331n);
    expect(fractionalAmount(3n, 1n, 10n)).toBe(0n);
    expect(fractionalAmount(100n, 101n, 100n)).toBe(100n);
    expect(() => fractionalAmount(1n, 1n, 0n)).toThrow();
  });

  it('ignores failed transactions, transfers, wrong signers, and multi-swap ambiguity', () => {
    const trade = makeTradeEvent();
    const failed = sourceTransaction(trade);
    failed.meta!.err = { InstructionError: [0, 'InvalidArgument'] };
    expect(decodeCopySignal(failed, trade.user, 'failed')).toBeNull();
    const transfer = sourceTransaction(trade);
    transfer.meta!.logMessages = [];
    expect(decodeCopySignal(transfer, trade.user, 'transfer')).toBeNull();
    expect(decodeCopySignal(sourceTransaction(trade), randomKey().toBase58(), 'other')).toBeNull();
    const multi = sourceTransaction(trade);
    multi.meta!.logMessages!.push(...multi.meta!.logMessages!);
    expect(decodeCopySignal(multi, trade.user, 'multi')).toBeNull();
    const differentDelta = sourceTransaction(trade);
    differentDelta.meta!.postTokenBalances![0].uiTokenAmount.amount = '1';
    expect(decodeCopySignal(differentDelta, trade.user, 'ambiguous')).toBeNull();
  });

  it('rejects unsupported Token-2022 transfer extensions but accepts metadata extensions', () => {
    expect(supportedPaperMint(Buffer.alloc(82))).toBe(true);
    const metadata = Buffer.alloc(174);
    metadata[165] = 1;
    metadata.writeUInt16LE(18, 166);
    metadata.writeUInt16LE(4, 168);
    expect(supportedPaperMint(metadata)).toBe(true);
    metadata.writeUInt16LE(1, 166);
    expect(supportedPaperMint(metadata)).toBe(false);
    expect(supportedPaperMint(Buffer.alloc(100))).toBe(false);
  });
});

describe('serialized operation manager', () => {
  let db: Db;
  beforeEach(() => { db = openDatabase(':memory:'); });
  afterEach(() => db.close());

  it('starts idle after restart; pause prevents entries without affecting liquidations', async () => {
    const repo = new Repository(db);
    const hooks = { disableEntries: vi.fn(), enableEntries: vi.fn(), configureCopy: vi.fn().mockResolvedValue({}), validateCopy: vi.fn() };
    const manager = new OperationManager(repo, hooks);
    await manager.set('sniper');
    expect(hooks.enableEntries).toHaveBeenCalledWith('sniper');
    manager.pause();
    await manager.set('copytrade');
    expect(manager.status()).toMatchObject({ mode: 'copytrade', paused: true });
    expect(hooks.enableEntries).toHaveBeenCalledTimes(1);
    manager.resume();
    expect(hooks.enableEntries).toHaveBeenLastCalledWith('copytrade');
    expect(new OperationManager(repo, hooks).status()).toMatchObject({ mode: 'idle', paused: false });
    expect(repo.operationLogs().length).toBeGreaterThan(0);
  });

  it('serializes requests, cancels stale enablement, and remains idle on invalid configuration', async () => {
    const repo = new Repository(db);
    let finish!: () => void;
    const configure = new Promise<void>((resolve) => { finish = resolve; });
    const hooks = { disableEntries: vi.fn(), enableEntries: vi.fn(), configureCopy: vi.fn(() => configure), validateCopy: vi.fn() };
    const manager = new OperationManager(repo, hooks);
    const first = manager.set('copytrade', {});
    await Promise.resolve();
    const second = manager.set('idle');
    finish();
    await Promise.all([first, second]);
    expect(manager.status()).toMatchObject({ mode: 'idle', transitioning: false });
    expect(hooks.enableEntries).not.toHaveBeenCalledWith('copytrade');
    hooks.validateCopy.mockImplementation(() => { throw new Error('missing wallets'); });
    await expect(manager.set('copytrade')).rejects.toThrow('missing wallets');
    expect(manager.status().mode).toBe('idle');
  });

  it('validates persisted settings, explicitly blocks live copy and preserves optional controller compatibility', async () => {
    expect(validateCopySettings({})).toEqual(DEFAULT_COPY_SETTINGS);
    expect(() => validateCopySettings({ execution: 'live' })).toThrow(/blocked/);
    expect(() => validateCopySettings({ wallets: ['invalid'] })).toThrow();
    expect(() => validateCopySettings({ maxBuySol: -1 })).toThrow();
    const bot = new Bot(testConfig(), db);
    expect(bot.operationStatus()).toMatchObject({ mode: 'idle' });
    await bot.setOperation('sniper');
    expect(bot.sniper.isPaused()).toBe(false);
    bot.pause();
    expect(bot.sniper.isPaused()).toBe(true);
    await bot.setOperation('idle');
    bot.resume();
    expect(bot.sniper.isPaused()).toBe(true);
    await bot.configureCopy({ enabled: true, wallets: [randomKey().toBase58()] });
    await bot.setOperation('copytrade');
    expect(bot.operationStatus()).toMatchObject({ mode: 'copytrade', copytrade: { entriesEnabled: true, liveSupported: false } });
  });
});

describe('durable paper copy trading', () => {
  let db: Db;
  let repo: Repository;
  let engine: CopyTradeEngine;
  let positions: PositionManager;
  let signal: CopySignal;
  let curveLookup: () => Promise<unknown[]>;
  const connection = {
    onLogs: vi.fn(() => 1), removeOnLogsListener: vi.fn(async () => {}),
    getSignaturesForAddress: vi.fn(async () => []),
    getTransaction: vi.fn(async (): Promise<VersionedTransactionResponse | null> => null),
    getMultipleAccountsInfo: vi.fn(async () => curveLookup()),
    getAccountInfo: vi.fn(async () => null),
  };

  beforeEach(async () => {
    db = openDatabase(':memory:');
    repo = new Repository(db);
    const cfg = testConfig();
    const rpc = { connection, rotate: () => connection, call: async (_label: string, fn: (c: unknown) => unknown) => fn(connection) } as unknown as RpcManager;
    const prices = new PriceTracker(repo, { ...cfg.tracking, tickIntervalMs: cfg.tracking.priceTickIntervalMs });
    positions = new PositionManager(repo, new PaperTrader(cfg.trading), rpc, prices, new Notifier([]), cfg);
    engine = new CopyTradeEngine(repo, rpc, positions, prices, cfg);
    const token = makeDetectedToken();
    const trade = makeTradeEvent({ mint: token.mint, user: randomKey().toBase58(), tokenAmount: 1000n });
    signal = { wallet: trade.user, signature: 'source-buy', slot: 1, observedAt: Date.now(), trade, sourcePreBalance: 0n };
    const mint = Buffer.alloc(82);
    mint[44] = 6; mint[45] = 1;
    curveLookup = async () => [
      { owner: PUMP_PROGRAM_ID, data: encodeBondingCurve({ virtualSolReserves: token.reserves.virtualSolReserves,
        virtualTokenReserves: token.reserves.virtualTokenReserves, realSolReserves: 100_000_000_000n,
        realTokenReserves: token.reserves.realTokenReserves, creator: new PublicKey(token.creator) }) },
      { owner: TOKEN_2022_PROGRAM_ID, data: mint },
    ];
    await engine.configure({ enabled: true, wallets: [signal.wallet] });
    await engine.start();
    engine.setEntries(true);
  });

  afterEach(async () => {
    await engine.stop();
    await positions.stop();
    db.close();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('persists dedupe and source tags; repeats cannot open or sell twice', async () => {
    expect(repo.claimSignal(signal.wallet, 'dedupe')).toBe(true);
    expect(new Repository(db).claimSignal(signal.wallet, 'dedupe')).toBe(false);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    await engine.onSignal(signal);
    await engine.onSignal(signal);
    const opened = repo.getOpenPositions()[0];
    expect(opened).toMatchObject({ mode: 'paper', origin: 'copytrade', sourceWallet: signal.wallet, sourceSignature: signal.signature });
    expect(repo.getOpenPositions()).toHaveLength(1);
    const sell: CopySignal = { ...signal, slot: 2, signature: 'source-sell', sourcePreBalance: 1000n,
      trade: { ...signal.trade, isBuy: false, tokenAmount: 250n } };
    await engine.onSignal(sell);
    const partial = repo.getPosition(opened.id)!;
    expect(partial.status).toBe('open');
    expect(partial.tokenAmount).toBe(opened.tokenAmount - opened.tokenAmount / 4n);
    expect(partial.solReceived).toBeGreaterThan(0);
    await engine.onSignal(sell);
    expect(repo.getPosition(opened.id)!.tokenAmount).toBe(partial.tokenAmount);
    const final = await positions.sellNow(opened.mint);
    expect(final.status).toBe('closed');
    expect(final.solReceived!).toBeGreaterThan(partial.solReceived!);
    expect(final.pnlSol).toBeCloseTo(final.solReceived! - opened.solSpent, 10);
    expect(repo.listTrades({ limit: 10, offset: 0 })).toHaveLength(3);
  });

  it('source sells continue during idle/pause but cannot liquidate another wallet or sniper origin', async () => {
    await engine.onSignal(signal);
    const opened = repo.getOpenPositions()[0];
    engine.setEntries(false);
    await engine.onSignal({ ...signal, signature: 'older-backfill-sell', sourcePreBalance: 1000n,
      trade: { ...signal.trade, isBuy: false } });
    expect(repo.getPosition(opened.id)!.status).toBe('open');
    await engine.onSignal({ ...signal, slot: 2, signature: 'wrong-wallet', wallet: randomKey().toBase58(),
      sourcePreBalance: 1000n, trade: { ...signal.trade, isBuy: false } });
    expect(repo.getPosition(opened.id)!.status).toBe('open');
    await engine.onSignal({ ...signal, slot: 2, signature: 'idle-exit', sourcePreBalance: 1000n,
      trade: { ...signal.trade, isBuy: false } });
    expect(repo.getPosition(opened.id)!.status).toBe('closed');
    const token = makeDetectedToken();
    repo.createPosition({ mint: token.mint, name: 'sniper', symbol: 'S', mode: 'paper', tokenProgram: token.tokenProgram,
      creator: token.creator, solSpent: 0.01, tokenAmount: 1000n, entryPrice: 0.01, buySignature: null, openedAt: Date.now() });
    await engine.onSignal({ ...signal, signature: 'not-sniper', sourcePreBalance: 1000n,
      trade: { ...signal.trade, mint: token.mint, isBuy: false } });
    expect(repo.getOpenPositions()).toHaveLength(1);
    expect(repo.getOpenPositions()[0].origin).toBe('sniper');
  });

  it('bounds proportional size and daily/exposure risk, skips stale and unsupported assets', async () => {
    await engine.configure({ sizing: 'proportional', proportionBps: 5000, maxBuySol: 0.02 });
    engine.setEntries(true);
    await engine.onSignal({ ...signal, signature: 'stale', observedAt: Date.now() - 60_000 });
    expect(repo.getOpenPositions()).toHaveLength(0);
    await engine.onSignal(signal);
    const opened = repo.getOpenPositions()[0];
    expect(opened.solSpent).toBeGreaterThanOrEqual(0.02);
    expect(opened.solSpent).toBeLessThan(0.021);
    await positions.sellNow(opened.mint);
    await engine.configure({ maxDailySpendSol: 0.021 });
    engine.setEntries(true);
    await expect(engine.onSignal({ ...signal, signature: 'daily-limit' })).rejects.toThrow(/risk limit/);
    expect(repo.getOpenPositions()).toHaveLength(0);
    const original = curveLookup;
    curveLookup = async () => {
      const rows = await original() as { data: Buffer; owner: PublicKey }[];
      rows[1].data = Buffer.alloc(200);
      rows[1].data[44] = 6; rows[1].data[45] = 1;
      return rows;
    };
    await expect(engine.onSignal({ ...signal, signature: 'unsupported' })).rejects.toThrow(/Unsupported/);
  });

  it('cancels an entry awaiting RPC when mode switches, without creating a position', async () => {
    const original = curveLookup;
    let finish!: (rows: unknown[]) => void;
    curveLookup = () => new Promise((resolve) => { finish = resolve; });
    const buying = engine.onSignal(signal);
    await Promise.resolve();
    engine.setEntries(false);
    finish(await original());
    await buying;
    expect(repo.getOpenPositions()).toHaveLength(0);
    expect(repo.action(`copy:${signal.wallet}:${signal.signature}:buy`)!.state).toBe('cancelled');
  });

  it('recovers pending paper exits after restart while entry mode stays idle', async () => {
    await engine.onSignal(signal);
    const opened = repo.getOpenPositions()[0];
    repo.createAction('pending-exit', 'copy_sell', { mint: opened.mint, wallet: signal.wallet, positionId: opened.id,
      numerator: '1', denominator: '2' });
    await engine.stop();
    const cfg = testConfig();
    const rpc = { connection, call: async (_label: string, fn: (c: unknown) => unknown) => fn(connection) } as unknown as RpcManager;
    engine = new CopyTradeEngine(repo, rpc, positions, new PriceTracker(repo, { ...cfg.tracking, tickIntervalMs: cfg.tracking.priceTickIntervalMs }), cfg);
    await engine.start();
    expect(engine.status().entriesEnabled).toBe(false);
    expect(repo.action('pending-exit')!.state).toBe('completed');
    expect(repo.getPosition(opened.id)!.tokenAmount).toBe(opened.tokenAmount - opened.tokenAmount / 2n);
  });

  it('fetches confirmed transactions with bounded retries, and persists stream dedupe', async () => {
    vi.useFakeTimers();
    const tx = sourceTransaction(signal.trade);
    connection.getTransaction.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(tx);
    const callback = connection.onLogs.mock.calls.length;
    expect(callback).toBeGreaterThan(0);
    const internal = engine as unknown as { enqueue(wallet: string, signature: string): void };
    internal.enqueue(signal.wallet, 'stream-sig');
    await vi.advanceTimersByTimeAsync(1500);
    expect(connection.getTransaction).toHaveBeenCalledTimes(3);
    expect(repo.getOpenPositions()).toHaveLength(1);
    internal.enqueue(signal.wallet, 'stream-sig');
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.getTransaction).toHaveBeenCalledTimes(3);
  });

  it('caps websocket reconnect attempts and uses bounded signature backfill', async () => {
    await engine.stop();
    vi.useFakeTimers();
    connection.onLogs.mockClear();
    await engine.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(engine.status().reconnects).toBe(5);
    expect(connection.onLogs).toHaveBeenCalledTimes(6);
    expect(connection.getSignaturesForAddress).toHaveBeenCalledWith(
      new PublicKey(signal.wallet), { limit: 50 }, 'confirmed');
  });
});
