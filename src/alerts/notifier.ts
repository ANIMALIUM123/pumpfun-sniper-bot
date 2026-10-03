import type { AppConfig } from '../config';
import { errorMessage, withTimeout } from '../utils/async';
import { getLogger } from '../utils/logger';
import type { DetectedToken, Position } from '../types';

export interface AlertChannel {
  readonly name: string;
  send(text: string): Promise<void>;
}

type FetchFn = typeof fetch;

export class DiscordChannel implements AlertChannel {
  readonly name = 'discord';
  constructor(
    private readonly webhookUrl: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async send(text: string): Promise<void> {
    const res = await this.fetchFn(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Discord limits message content to 2000 characters; disable all mentions.
      body: JSON.stringify({ content: text.slice(0, 2000), allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) throw new Error(`Discord webhook responded ${res.status}`);
  }
}

export class TelegramChannel implements AlertChannel {
  readonly name = 'telegram';
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async send(text: string): Promise<void> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, 4096), disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`Telegram API responded ${res.status}`);
  }
}

const fmtSol = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${v.toFixed(4)} SOL`);
const fmtPct = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
/** Token names/symbols are attacker controlled – strip characters that could break formatting or ping people. */
const clean = (s: string) => s.replace(/[\r\n`*_~|<>@]/g, '').slice(0, 40);

/** Fan-out notifier. Alerts are fire-and-forget: failures are logged but never break trading. */
export class Notifier {
  private readonly log = getLogger('alerts');

  constructor(
    private readonly channels: AlertChannel[],
    private readonly alertOnDetection = false,
    private readonly modeLabel = '',
  ) {}

  static fromConfig(cfg: AppConfig): Notifier {
    const channels: AlertChannel[] = [];
    if (cfg.alerts.discordWebhookUrl) channels.push(new DiscordChannel(cfg.alerts.discordWebhookUrl));
    if (cfg.alerts.telegramBotToken && cfg.alerts.telegramChatId) {
      channels.push(new TelegramChannel(cfg.alerts.telegramBotToken, cfg.alerts.telegramChatId));
    }
    return new Notifier(channels, cfg.alerts.alertOnDetection, cfg.trading.dryRun ? '[PAPER] ' : '');
  }

  get enabled(): boolean {
    return this.channels.length > 0;
  }

  /** Sends to every channel; resolves once all attempts have settled. */
  async send(text: string): Promise<void> {
    if (!this.enabled) return;
    const message = `${this.modeLabel}${text}`;
    await Promise.allSettled(
      this.channels.map(async (c) => {
        try {
          await withTimeout(c.send(message), 10_000, `${c.name} alert`);
        } catch (error) {
          this.log.warn({ channel: c.name, err: errorMessage(error) }, 'Failed to deliver alert');
        }
      }),
    );
  }

  tokenDetected(t: DetectedToken): void {
    if (!this.alertOnDetection) return;
    void this.send(`🆕 New token ${clean(t.symbol)} (${clean(t.name)})\nMint: ${t.mint}\nMC: ${t.marketCapSol.toFixed(2)} SOL`);
  }

  bought(p: Position, latencyMs: number): void {
    void this.send(
      `🟢 BUY ${clean(p.symbol)}\nSpent: ${fmtSol(p.solSpent)}\nMint: ${p.mint}\nLatency: ${latencyMs}ms` +
        (p.buySignature ? `\nhttps://solscan.io/tx/${p.buySignature}` : ''),
    );
  }

  sold(p: Position): void {
    const icon = (p.pnlSol ?? 0) >= 0 ? '💰' : '🔻';
    void this.send(
      `${icon} SELL ${clean(p.symbol)} (${p.exitReason ?? 'exit'})\nPnL: ${fmtSol(p.pnlSol)} (${fmtPct(p.pnlPercent)})\nReceived: ${fmtSol(p.solReceived)}` +
        (p.sellSignature ? `\nhttps://solscan.io/tx/${p.sellSignature}` : ''),
    );
  }

  error(context: string, error: unknown): void {
    void this.send(`⚠️ ${context}: ${errorMessage(error).slice(0, 300)}`);
  }

  info(text: string): void {
    void this.send(`ℹ️ ${text}`);
  }
}
