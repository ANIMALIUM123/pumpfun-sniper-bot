import { PublicKey, type Connection } from '@solana/web3.js';
import type { AppConfig } from '../config';
import type { Repository } from '../database/repository';
import type { PriceTracker } from '../indexer/priceTracker';
import { PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT,
  bondingCurvePda, decodeBondingCurve, lamportsToSol, tokenUnitsToUi } from '../pumpfun';
import type { RpcManager } from '../rpc/rpcManager';
import type { PositionManager } from '../trading/positionManager';
import { PaperTrader } from '../trading/trader';
import { errorMessage, sleep, withTimeout } from '../utils/async';
import { DEFAULT_COPY_SETTINGS, validateCopySettings, type CopySettings } from './settings';
import { decodeCopySignal, type CopySignal } from './signals';

export class CopyTradeEngine {
  private settings: CopySettings;
  private entries = false;
  private generation = 0;
  private running = false;
  private worker: Promise<void> | null = null;
  private readonly queue: { wallet: string; signature: string; generation: number }[] = [];
  private subscriptions: { connection: Connection; id: number }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private maintaining = false;
  private maintenanceTask: Promise<void> | null = null;
  private lastMessageAt = Date.now();
  private reconnects = 0;
  private nextReconnectAt = 0;
  private lastBackfillAt = 0;
  private stats = { observed: 0, ignored: 0, buys: 0, sells: 0, errors: 0, dropped: 0 };

  constructor(private readonly repo: Repository, private readonly rpc: RpcManager,
    private readonly positions: PositionManager, private readonly prices: PriceTracker, private readonly cfg: AppConfig) {
    this.settings = validateCopySettings(repo.setting('copytrade') ?? {}, DEFAULT_COPY_SETTINGS);
  }

  getSettings(): CopySettings { return { ...this.settings, wallets: [...this.settings.wallets] }; }
  status() { return { ...this.stats, entriesEnabled: this.entries, running: this.running,
    queued: this.queue.length, reconnects: this.reconnects, liveSupported: false }; }

  async configure(input: unknown): Promise<CopySettings> {
    const settings = validateCopySettings(input, this.settings);
    this.repo.saveSetting('copytrade', settings);
    this.settings = settings;
    this.generation++;
    if (this.running) await this.refreshSubscriptions();
    this.repo.logOperation('copy_settings', settings);
    return this.getSettings();
  }

  setEntries(enabled: boolean): void {
    this.entries = enabled;
    this.generation++;
    if (!enabled) {
      for (const action of this.repo.pendingActions()) {
        if (action.kind === 'copy_buy' && action.state === 'pending') this.repo.finishAction(action.key, 'cancelled');
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.refreshSubscriptions();
    for (const signal of this.repo.pendingSignals()) this.enqueue(signal.wallet, signal.signature, false);
    this.timer = setInterval(() => {
      if (this.maintenanceTask) return;
      this.maintenanceTask = this.maintenance().catch((e) => this.recordError(e))
        .finally(() => { this.maintenanceTask = null; });
    }, 10_000);
    this.timer.unref();
    for (const action of this.repo.pendingActions()) {
      if (action.kind === 'copy_buy') this.repo.finishAction(action.key, 'cancelled');
    }
    await this.recoverSells();
  }

  async stop(): Promise<void> {
    this.setEntries(false);
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.unsubscribe();
    await withTimeout(Promise.all([this.worker, this.maintenanceTask]), 18_000, 'copy shutdown').catch(() => {});
  }

  private wallets(): string[] {
    return [...new Set([...this.settings.wallets,
      ...this.repo.getOpenPositions().filter((p) => p.origin === 'copytrade' && p.sourceWallet).map((p) => p.sourceWallet!)])].slice(0, 20);
  }

  private async unsubscribe(): Promise<void> {
    const old = this.subscriptions;
    this.subscriptions = [];
    await Promise.all(old.map((s) => withTimeout(s.connection.removeOnLogsListener(s.id), 2_000, 'unsubscribe').catch(() => {})));
  }

  private async refreshSubscriptions(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.unsubscribe();
      if (!this.running) return;
      for (const wallet of this.wallets()) {
        const connection = this.rpc.connection;
        const id = connection.onLogs(new PublicKey(wallet), (logs) => {
          if (!this.running) return;
          this.lastMessageAt = Date.now();
          this.reconnects = 0;
          if (!logs.err) this.enqueue(wallet, logs.signature);
        }, 'confirmed');
        this.subscriptions.push({ connection, id });
      }
      await this.backfill();
    } finally {
      this.refreshing = false;
    }
  }

  private async backfill(): Promise<void> {
    this.lastBackfillAt = Date.now();
    for (const wallet of this.wallets()) {
      if (!this.running) return;
      try {
        const recent = await withTimeout(this.rpc.call('copy backfill', (c) =>
          c.getSignaturesForAddress(new PublicKey(wallet), { limit: 50 }, 'confirmed')), 4_000, 'copy backfill');
        for (const row of recent.reverse()) if (!row.err) this.enqueue(wallet, row.signature);
      } catch (e) { this.recordError(e); }
    }
  }

  private enqueue(wallet: string, signature: string, claim = true): void {
    if (!this.running) return;
    if (this.queue.length >= 200) { this.stats.dropped++; return; }
    if (claim && !this.repo.claimSignal(wallet, signature)) return;
    this.queue.push({ wallet, signature, generation: this.generation });
    if (!this.worker) {
      this.worker = this.drain().finally(() => { this.worker = null; });
    }
  }

  private async drain(): Promise<void> {
    while (this.running && this.queue.length) {
      const item = this.queue.shift()!;
      try {
        let tx = null;
        for (let attempt = 0; attempt < 4 && this.running; attempt++) {
          tx = await withTimeout(this.rpc.call('copy transaction', (c) =>
            c.getTransaction(item.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })),
          3_000, 'copy transaction').catch(() => null);
          if (tx) break;
          if (attempt < 3) await sleep(200 * (attempt + 1));
        }
        if (!this.running) return;
        if (!tx) {
          // Remain pending durably; a later backfill/restart may recover delayed RPC metadata.
          this.recordError(new Error(`Transaction metadata unavailable: ${item.signature}`));
          continue;
        }
        const signal = decodeCopySignal(tx, item.wallet, item.signature);
        this.stats.observed++;
        if (signal) await this.onSignal(signal, item.generation);
        else this.stats.ignored++;
        this.repo.finishSignal(item.wallet, item.signature, signal ? 'processed' : 'ignored');
      } catch (e) {
        this.repo.finishSignal(item.wallet, item.signature, 'failed', errorMessage(e));
        this.recordError(e);
      }
    }
  }

  async onSignal(signal: CopySignal, generation = this.generation): Promise<void> {
    const { trade, wallet, signature } = signal;
    const key = `copy:${wallet}:${signature}:${trade.isBuy ? 'buy' : 'sell'}`;
    if (this.repo.action(key)) return;
    if (!trade.isBuy) {
      const position = this.repo.getOpenPositions().find((p) => p.mint === trade.mint &&
        p.origin === 'copytrade' && p.sourceWallet === wallet && p.mode === 'paper');
      if (!this.settings.copySells || !position || signal.sourcePreBalance <= 0n) return;
      const entry = position.sourceSignature ? this.repo.action(`copy:${wallet}:${position.sourceSignature}:buy`) : null;
      const entrySlot = entry ? (JSON.parse(entry.payload) as { slot?: number }).slot : undefined;
      if (entrySlot === undefined || signal.slot <= entrySlot) return;
      this.repo.createAction(key, 'copy_sell', { mint: trade.mint, wallet, positionId: position.id,
        numerator: trade.tokenAmount.toString(), denominator: signal.sourcePreBalance.toString() });
      await this.executeSell(key);
      return;
    }
    const settings = this.getSettings();
    const canEnter = () => this.running && this.entries && this.settings.enabled &&
      generation === this.generation && this.settings.wallets.includes(wallet);
    if (!canEnter() || Date.now() - signal.observedAt > settings.maxSignalAgeSeconds * 1_000 ||
      signal.observedAt > Date.now() + 5_000 || lamportsToSol(trade.solAmount) < settings.minSourceSol) return;
    const proportional = trade.solAmount * BigInt(settings.proportionBps) / 10_000n;
    const spend = Math.min(settings.maxBuySol, settings.sizing === 'fixed' ? settings.fixedSol : lamportsToSol(proportional));
    if (spend < 0.000001) return;
    const open = this.repo.getOpenPositions();
    if (open.some((p) => p.mint === trade.mint) || open.length >= settings.maxOpenPositions) return;
    this.repo.createAction(key, 'copy_buy', { wallet, signature, mint: trade.mint, spend, slot: signal.slot, observedAt: signal.observedAt });
    try {
      const infos = await withTimeout(this.rpc.call('copy curve and mint', (c) =>
        c.getMultipleAccountsInfo([bondingCurvePda(new PublicKey(trade.mint)), new PublicKey(trade.mint)], 'confirmed')),
      4_000, 'copy curve and mint');
      const curve = infos[0] && infos[0].owner.equals(PUMP_PROGRAM_ID) ? decodeBondingCurve(infos[0].data) : null;
      const mint = infos[1];
      if (!curve || curve.complete || curve.isMayhemMode || !curve.creator ||
        (curve.quoteMint !== null && curve.quoteMint !== NATIVE_MINT.toBase58()) ||
        !mint || (!mint.owner.equals(TOKEN_PROGRAM_ID) && !mint.owner.equals(TOKEN_2022_PROGRAM_ID)) ||
        mint.data.length < 82 || mint.data[44] !== 6 || mint.data[45] !== 1 ||
        (mint.owner.equals(TOKEN_2022_PROGRAM_ID) && !supportedPaperMint(mint.data))) {
        throw new Error('Unsupported/unverified curve, mint, quote or Token-2022 extensions');
      }
      if (!canEnter()) { this.repo.finishAction(key, 'cancelled'); return; }
      const reserves = { virtualSolReserves: curve.virtualQuoteReserves, virtualTokenReserves: curve.virtualTokenReserves,
        realSolReserves: curve.realQuoteReserves, realTokenReserves: curve.realTokenReserves };
      const trader = new PaperTrader({ ...this.cfg.trading, buyAmountSol: spend });
      const result = await trader.buy({ mint: new PublicKey(trade.mint), creator: new PublicKey(curve.creator),
        tokenProgram: mint.owner, isMayhemMode: false, reserves });
      if (!canEnter()) { this.repo.finishAction(key, 'cancelled'); return; }
      const position = this.repo.atomic(() => {
        const current = this.repo.getOpenPositions();
        if (current.some((p) => p.mint === trade.mint) || current.length >= settings.maxOpenPositions ||
          current.reduce((s, p) => s + p.solSpent, 0) + result.solSpent > settings.maxExposureSol ||
          this.repo.dailyCopySpend() + result.solSpent > settings.maxDailySpendSol) {
          throw new Error('Copy risk limit exceeded');
        }
        const entryPrice = result.solSpent / tokenUnitsToUi(result.tokenAmount);
        const token = this.repo.getToken(trade.mint);
        const opened = this.repo.createPosition({ mint: trade.mint, name: token?.name ?? trade.mint,
          symbol: token?.symbol ?? 'COPY', mode: 'paper', tokenProgram: mint.owner.toBase58(), creator: curve.creator!,
          solSpent: result.solSpent, tokenAmount: result.tokenAmount, entryPrice, buySignature: null, openedAt: Date.now(),
          origin: 'copytrade', sourceWallet: wallet, sourceSignature: signature });
        this.repo.insertTrade({ positionId: opened.id, mint: trade.mint, side: 'buy', mode: 'paper', success: true,
          solAmount: result.solSpent, tokenAmount: result.tokenAmount, price: entryPrice, signature: null,
          error: null, latencyMs: 0, createdAt: Date.now() });
        this.repo.finishAction(key, 'completed', { positionId: opened.id });
        return opened;
      });
      this.positions.add(position, { reserves, creator: curve.creator, isMayhemMode: false, tokenTotalSupply: curve.tokenTotalSupply });
      this.prices.pin(trade.mint, reserves, curve.tokenTotalSupply);
      this.stats.buys++;
      this.repo.logOperation('copy_buy', { mint: trade.mint, wallet, sourceSignature: signature, positionId: position.id, paper: true });
    } catch (e) {
      this.repo.finishAction(key, 'failed', { error: errorMessage(e) });
      throw e;
    }
  }

  private async executeSell(key: string): Promise<void> {
    const action = this.repo.action(key)!;
    if (action.state !== 'pending') return;
    const payload = JSON.parse(action.payload) as { mint: string; wallet: string; positionId: number; numerator: string; denominator: string };
    const position = this.repo.getPosition(payload.positionId);
    if (!position || position.status !== 'open') { this.repo.finishAction(key, 'cancelled'); return; }
    if (position.origin !== 'copytrade' || position.sourceWallet !== payload.wallet || position.mode !== 'paper') {
      this.repo.finishAction(key, 'failed', { error: 'Source origin mismatch' }); return;
    }
    await this.positions.sellFraction(payload.mint, BigInt(payload.numerator), BigInt(payload.denominator), key);
    this.stats.sells++;
    this.repo.logOperation('copy_sell', { mint: payload.mint, wallet: payload.wallet, action: key, paper: true });
  }

  private async recoverSells(): Promise<void> {
    for (const action of this.repo.pendingActions()) {
      if (!this.running) return;
      if (action.kind === 'copy_sell') await this.executeSell(action.key).catch((e) => this.recordError(e));
    }

  }

  private async maintenance(): Promise<void> {
    if (!this.running || this.refreshing || this.maintaining) return;
    this.maintaining = true;
    try {
      await this.recoverSells();
      for (const signal of this.repo.pendingSignals()) {
        if (!this.queue.some((q) => q.wallet === signal.wallet && q.signature === signal.signature)) this.enqueue(signal.wallet, signal.signature, false);
      }
      if (Date.now() - this.lastBackfillAt > 30_000) await this.backfill();
      if (this.running && this.wallets().length && Date.now() - this.lastMessageAt > 60_000 && this.reconnects < 5 && Date.now() >= this.nextReconnectAt) {
        this.reconnects++;
        this.nextReconnectAt = Date.now() + Math.min(30_000, 1_000 * 2 ** this.reconnects);
        this.rpc.rotate('copy stream heartbeat');
        await this.refreshSubscriptions();
      }
    } finally { this.maintaining = false; }
  }

  private recordError(error: unknown): void {
    this.stats.errors++;
    this.repo.logOperation('copy_error', { error: errorMessage(error) });
  }
}

/** Metadata-only Token-2022 extensions do not change simulated transfer amounts. */
export function supportedPaperMint(data: Buffer): boolean {
  if (data.length === 82) return true;
  if (data.length < 166 || data[165] !== 1) return false;
  const seen = new Set<number>();
  let offset = 166;
  while (offset < data.length) {
    if (data.subarray(offset).every((b) => b === 0)) return true;
    if (offset + 4 > data.length) return false;
    const type = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    if (![18, 19].includes(type) || seen.has(type) || offset + 4 + length > data.length) return false;
    seen.add(type);
    offset += 4 + length;
  }
  return true;
}
