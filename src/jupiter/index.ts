import { PublicKey } from '@solana/web3.js';
export { JupiterPaperTrader, type JupiterPaperOptions } from './paperTrader';

// Official source: jup-ag/docs, swap/quote-and-swap.mdx (Swap V2).
export const JUPITER_QUOTE_ENDPOINT = 'https://api.jup.ag/swap/v2/quote';
const U64_MAX = (1n << 64n) - 1n;
export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps?: number;
}
export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  swapMode: 'ExactIn';
  contextSlot: number;
  priceImpactPct: string;
  receivedAt: number;
  expiresAt: number;
}
export class JupiterError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'JupiterError';
  }
}
export interface JupiterOptions {
  apiKey?: string;
  slippageBps?: number;
  maxSlippageBps?: number;
  timeoutMs?: number;
  quoteTtlMs?: number;
  minIntervalMs?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
}

function positiveAmount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) throw new Error('Invalid amount');
  const amount = BigInt(value);
  if (amount > U64_MAX) throw new Error('Invalid amount');
  return amount;
}
function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new JupiterError('INVALID_CONFIG', 'Invalid Jupiter limits');
  }
  return value;
}

/** Quote-only: no transaction assembly, arbitrary signing, or generic DEX fallback. */
export class JupiterClient {
  private readonly apiKey?: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly slippageBps: number;
  private readonly maxSlippageBps: number;
  private readonly timeoutMs: number;
  private readonly quoteTtlMs: number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private nextRequestAt = 0;
  private busy = false;
  private readonly issued = new WeakMap<JupiterQuote, number>();

  constructor(options: JupiterOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    if (this.apiKey && /[\r\n]/.test(this.apiKey)) throw new JupiterError('INVALID_CONFIG', 'Invalid Jupiter configuration');
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.maxSlippageBps = boundedInteger(options.maxSlippageBps ?? 500, 0, 1000);
    this.slippageBps = boundedInteger(options.slippageBps ?? 50, 0, this.maxSlippageBps);
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 8_000, 100, 30_000);
    this.quoteTtlMs = boundedInteger(options.quoteTtlMs ?? 15_000, 100, 60_000);
    this.minIntervalMs = boundedInteger(options.minIntervalMs ?? 1_100, 100, 60_000);
    this.maxRetries = boundedInteger(options.maxRetries ?? 2, 0, 3);
  }

  status(): {
    configured: boolean; quoteOnly: true; liveExecutionSupported: false; endpoint: string;
    slippageBps: number; maxSlippageBps: number; timeoutMs: number; quoteTtlMs: number;
  } {
    return {
      configured: Boolean(this.apiKey), quoteOnly: true, liveExecutionSupported: false,
      endpoint: JUPITER_QUOTE_ENDPOINT, slippageBps: this.slippageBps,
      maxSlippageBps: this.maxSlippageBps, timeoutMs: this.timeoutMs, quoteTtlMs: this.quoteTtlMs,
    };
  }

  async quote(request: QuoteRequest): Promise<JupiterQuote> {
    if (!this.apiKey) throw new JupiterError('NOT_CONFIGURED', 'Jupiter API key is required');
    if (this.busy || Date.now() < this.nextRequestAt) {
      throw new JupiterError('RATE_LIMITED', 'Jupiter quote rate limit; retry later');
    }
    let inputMint: string;
    let outputMint: string;
    const slippageBps = boundedInteger(request.slippageBps ?? this.slippageBps, 0, this.maxSlippageBps);
    try {
      inputMint = new PublicKey(request.inputMint).toBase58();
      outputMint = new PublicKey(request.outputMint).toBase58();
      if (inputMint === outputMint || typeof request.amount !== 'bigint' ||
          request.amount <= 0n || request.amount > U64_MAX) throw new Error('Invalid quote');
    } catch {
      throw new JupiterError('INVALID_REQUEST', 'Invalid quote mints or amount');
    }
    const url = new URL(JUPITER_QUOTE_ENDPOINT);
    url.search = new URLSearchParams({
      inputMint, outputMint, amount: request.amount.toString(), slippageBps: String(slippageBps),
    }).toString();
    const startedAt = Date.now();
    const deadline = startedAt + this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    this.busy = true;
    try {
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        this.nextRequestAt = Date.now() + this.minIntervalMs;
        const response = await this.fetcher(url, {
          headers: { 'x-api-key': this.apiKey, Accept: 'application/json' },
          signal: controller.signal, redirect: 'error',
        });
        if (response.status === 429) {
          const retryAfter = this.retryDelay(response.headers.get('retry-after'), attempt);
          this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + retryAfter);
          await response.body?.cancel();
          const delay = this.nextRequestAt - Date.now();
          if (attempt === this.maxRetries || Date.now() + delay >= deadline) {
            throw new JupiterError('RATE_LIMITED', 'Jupiter rate limited; retry later');
          }
          await this.wait(delay, controller.signal);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 400 || response.status === 404) {
            throw new JupiterError('NO_ROUTE', 'Jupiter quote unavailable for this pair or amount');
          }
          throw new JupiterError('UPSTREAM_ERROR', 'Jupiter quote service unavailable');
        }
        const raw = await this.readResponse(response);
        if (controller.signal.aborted || Date.now() >= deadline) throw new Error('Timeout');
        if (Date.now() - startedAt >= this.quoteTtlMs) {
          throw new JupiterError('STALE_QUOTE', 'Jupiter quote expired; request a new quote');
        }
        const quote = this.validateQuote(raw, inputMint, outputMint, request.amount, slippageBps);
        quote.expiresAt = startedAt + this.quoteTtlMs;
        this.issued.set(quote, quote.expiresAt);
        return Object.freeze(quote);
      }
      throw new JupiterError('RATE_LIMITED', 'Jupiter rate limited; retry later');
    } catch (error) {
      if (error instanceof JupiterError) throw error;
      throw new JupiterError(controller.signal.aborted ? 'TIMEOUT' : 'UPSTREAM_ERROR',
        controller.signal.aborted ? 'Jupiter quote request timed out' : 'Jupiter quote service unavailable');
    } finally {
      clearTimeout(timer);
      this.busy = false;
    }
  }

  assertFresh(quote: JupiterQuote): void {
    const expiry = this.issued.get(quote);
    if (expiry === undefined || Date.now() >= expiry) {
      throw new JupiterError('STALE_QUOTE', 'Jupiter quote expired or unrecognized; request a new quote');
    }
  }

  async execute(): Promise<never> {
    throw new JupiterError('LIVE_EXECUTION_DISABLED',
      'Jupiter is quote-only: transaction payer, signers, spend, destinations and programs are not yet validated');
  }

  private validateQuote(
    raw: unknown, inputMint: string, outputMint: string, amount: bigint, slippageBps: number,
  ): JupiterQuote {
    if (!raw || typeof raw !== 'object') throw new JupiterError('INVALID_RESPONSE', 'Invalid Jupiter quote response');
    const value = raw as Record<string, unknown>;
    if (Array.isArray(value.routePlan) && value.routePlan.length === 0) {
      throw new JupiterError('NO_ROUTE', 'No Jupiter route available');
    }
    try {
      const out = positiveAmount(value.outAmount);
      const minimum = positiveAmount(value.otherAmountThreshold);
      if (value.inputMint !== inputMint || value.outputMint !== outputMint ||
          positiveAmount(value.inAmount) !== amount || value.swapMode !== 'ExactIn' ||
          value.slippageBps !== slippageBps || minimum > out ||
          minimum < out * BigInt(10_000 - slippageBps) / 10_000n ||
          !Array.isArray(value.routePlan) || value.routePlan.length === 0 ||
          !Number.isSafeInteger(value.contextSlot) || Number(value.contextSlot) <= 0 ||
          typeof value.priceImpactPct !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.priceImpactPct)) {
        throw new Error('Invalid quote');
      }
      const receivedAt = Date.now();
      return {
        inputMint, outputMint, inAmount: amount.toString(), outAmount: out.toString(),
        otherAmountThreshold: minimum.toString(), slippageBps, swapMode: 'ExactIn',
        contextSlot: Number(value.contextSlot), priceImpactPct: value.priceImpactPct,
        receivedAt, expiresAt: receivedAt + this.quoteTtlMs,
      };
    } catch {
      throw new JupiterError('INVALID_RESPONSE', 'Invalid Jupiter quote response');
    }
  }

  private retryDelay(header: string | null, attempt: number): number {
    let delay = Math.max(this.minIntervalMs, 500 * 2 ** attempt);
    if (header) {
      const seconds = Number(header);
      const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
      if (Number.isFinite(requested)) delay = Math.max(delay, requested);
    }
    return Math.min(60_000, Math.max(100, delay));
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Aborted')); return; }
      const abort = (): void => { clearTimeout(timer); reject(new Error('Aborted')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private async readResponse(response: Response): Promise<unknown> {
    if (!response.body) throw new Error('Empty response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 256 * 1024) throw new Error('Response too large');
        chunks.push(item.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally { await reader.cancel(); }
  }
}
