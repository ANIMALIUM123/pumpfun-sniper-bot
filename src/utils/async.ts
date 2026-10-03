export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Rejects with a {@link TimeoutError} if `promise` does not settle within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RetryOptions {
  retries: number;
  delayMs: number;
  /** Multiplier applied to the delay after every failed attempt. */
  factor?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number) => void;
}

/** Runs `fn` until it succeeds or `retries` additional attempts have failed. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  let delay = opts.delayMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= opts.retries || (opts.shouldRetry && !opts.shouldRetry(error))) throw error;
      opts.onRetry?.(error, attempt + 1);
      await sleep(delay);
      delay = Math.round(delay * (opts.factor ?? 2));
    }
  }
}

export function errorMessage(error: unknown): string {
  let message: string;
  if (error instanceof Error) message = error.message;
  else if (typeof error === 'string') message = error;
  else {
    try {
      message = JSON.stringify(error) ?? 'Unknown error';
    } catch {
      message = 'Unknown error';
    }
  }
  return redactMessage(message);
}

/** Provider errors can contain authenticated URLs or echo configured credentials. */
export function redactMessage(message: string): string {
  let safe = message.replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[endpoint redacted]');
  for (const name of ['WALLET_PRIVATE_KEY', 'JUPITER_API_KEY', 'API_KEY', 'HELIUS_API_KEY', 'TELEGRAM_BOT_TOKEN', 'DISCORD_WEBHOOK_URL']) {
    const secret = process.env[name];
    if (secret) safe = safe.split(secret).join('[redacted]');
  }
  return safe;
}

/** Small insertion-ordered set with a maximum size (oldest entries are evicted). */
export class BoundedSet<T> {
  private readonly items = new Set<T>();
  constructor(private readonly maxSize: number) {}

  has(value: T): boolean {
    return this.items.has(value);
  }

  /** Adds `value`; returns `false` if it was already present. */
  add(value: T): boolean {
    if (this.items.has(value)) return false;
    this.items.add(value);
    if (this.items.size > this.maxSize) {
      const oldest = this.items.values().next().value as T;
      this.items.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.items.size;
  }
}
