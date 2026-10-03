import { afterEach, describe, expect, it, vi } from 'vitest';
import { JupiterClient, JupiterPaperTrader, JUPITER_QUOTE_ENDPOINT } from '../src/jupiter';

const inputMint = 'So11111111111111111111111111111111111111112';
const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const request = { inputMint, outputMint, amount: 100_000_000n };
const response = {
  inputMint, outputMint, inAmount: '100000000', outAmount: '1000000',
  otherAmountThreshold: '995000', slippageBps: 50, swapMode: 'ExactIn',
  contextSlot: 123, priceImpactPct: '0.001', routePlan: [{}],
};
afterEach(() => vi.useRealTimers());

describe('Jupiter V2 quote-only integration', () => {
  it('uses the current official endpoint and API header with exact bigint amounts', async () => {
    const amount = 9_007_199_254_740_993n;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...response, inAmount: amount.toString() }));
    const client = new JupiterClient({ apiKey: 'test-api-header-only', fetch: fetcher });
    const quote = await client.quote({ ...request, amount });
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toContain(`${JUPITER_QUOTE_ENDPOINT}?`);
    expect(new URL(String(url)).searchParams.get('amount')).toBe(amount.toString());
    expect(options?.headers).toMatchObject({ 'x-api-key': 'test-api-header-only' });
    expect(options?.redirect).toBe('error');
    expect(quote.inAmount).toBe(amount.toString());
    expect(quote).not.toHaveProperty('routePlan');
    expect(Object.isFrozen(quote)).toBe(true);
    expect(JSON.stringify(client.status())).not.toContain('test-api-header-only');
    expect(client.status()).toMatchObject({ configured: true, quoteOnly: true, liveExecutionSupported: false });
  });

  describe('Jupiter quoted paper execution', () => {
    it('executes modeled buys and exits against fresh supported Jupiter routes without signing', async () => {
      vi.useFakeTimers();
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ ...response, inAmount: '99995000' }))
        .mockResolvedValueOnce(Response.json({
          ...response, inputMint: outputMint, outputMint: inputMint, inAmount: '995000',
          outAmount: '200000000', otherAmountThreshold: '199000000',
        }));
      const client = new JupiterClient({ apiKey: 'test-only', fetch: fetcher, minIntervalMs: 100 });
      const trader = new JupiterPaperTrader(client, { buyAmountSol: 0.1 });
      await trader.init();
      const buy = await trader.buyMint(outputMint);
      expect(buy).toMatchObject({ signature: null, solSpent: 0.1, tokenAmount: 995000n });
      await vi.advanceTimersByTimeAsync(101);
      const sell = await trader.sellMint(outputMint, buy.tokenAmount);
      expect(sell).toMatchObject({ signature: null, solReceived: 0.198995, tokenAmountSold: 995000n });
      expect(trader.mode).toBe('paper');
      expect(trader.walletAddress).toBeNull();
      expect(trader.cachedBalanceSol()).toBeNull();
      expect(fetcher.mock.calls).toHaveLength(2);
      for (const [url, options] of fetcher.mock.calls) {
        expect(String(url)).toContain(JUPITER_QUOTE_ENDPOINT);
        expect(options?.body).toBeUndefined();
        expect(options?.method).toBeUndefined();
      }
    });

    it('fails closed on unavailable routes, stopped state and changed entry guards', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...response, inAmount: '99995000' }));
      const client = new JupiterClient({ apiKey: 'test-only', fetch: fetcher });
      const trader = new JupiterPaperTrader(client, { buyAmountSol: 0.1 });
      await expect(trader.buyMint(outputMint)).rejects.toThrow('not active');
      await trader.init();
      trader.setEntryGuard(() => false);
      await expect(trader.buyMint(outputMint)).rejects.toThrow('disabled');
      expect(fetcher).not.toHaveBeenCalled();
      let enabled = true;
      trader.setEntryGuard(() => enabled);
      fetcher.mockImplementation(async () => {
        enabled = false;
        return Response.json({ ...response, inAmount: '99995000' });
      });
      await expect(trader.buyMint(outputMint)).rejects.toThrow('disabled');
      trader.stop();
      await expect(trader.sellMint(outputMint, 100n)).rejects.toThrow('not active');
      const unavailable = new JupiterPaperTrader(new JupiterClient({
        apiKey: 'test-only', fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...response, routePlan: [] })),
      }), { buyAmountSol: 0.1 });
      await unavailable.init();
      await expect(unavailable.buyMint(outputMint)).rejects.toMatchObject({ code: 'NO_ROUTE' });
      await expect(new JupiterPaperTrader(new JupiterClient(), { buyAmountSol: 0.1 }).init()).rejects.toThrow('API key');
    });
  });

  it('does not accept absent keys, invalid amounts, same mints or uncapped slippage', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new JupiterClient().quote(request)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    const client = new JupiterClient({ apiKey: 'test-only', fetch: fetcher });
    await expect(client.quote({ ...request, amount: 0n })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.quote({ ...request, amount: 1n << 64n })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.quote({ ...request, outputMint: inputMint })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.quote({ ...request, slippageBps: 501 })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects no-route and malformed/mismatched quotes without upstream body disclosure', async () => {
    const cases = [
      [{ ...response, routePlan: [] }, 'NO_ROUTE'],
      [{ ...response, inAmount: '1' }, 'INVALID_RESPONSE'],
      [{ ...response, otherAmountThreshold: '1' }, 'INVALID_RESPONSE'],
      [{ ...response, swapMode: 'ExactOut' }, 'INVALID_RESPONSE'],
      [{ ...response, slippageBps: 1000 }, 'INVALID_RESPONSE'],
    ] as const;
    for (const [body, code] of cases) {
      const client = new JupiterClient({ apiKey: 'test-only', fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)) });
      await expect(client.quote(request)).rejects.toMatchObject({ code });
    }
    const unavailable = new JupiterClient({
      apiKey: 'test-only', fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('credential-in-error', { status: 400 })),
    });
    await expect(unavailable.quote(request)).rejects.toThrow('quote unavailable');
  });

  it('enforces freshness and rejects every live execution without fetching/signing', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
    const client = new JupiterClient({ apiKey: 'test-only', fetch: fetcher, quoteTtlMs: 100 });
    vi.useFakeTimers();
    const quote = await client.quote(request);
    expect(() => client.assertFresh(quote)).not.toThrow();
    expect(() => client.assertFresh({ ...quote })).toThrow('unrecognized');
    vi.advanceTimersByTime(101);
    expect(() => client.assertFresh(quote)).toThrow('expired');
    await expect(client.execute()).rejects.toMatchObject({ code: 'LIVE_EXECUTION_DISABLED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('backs off 429 and respects both rate limits and the bounded retry count', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0.1' } }))
      .mockResolvedValueOnce(Response.json(response));
    const client = new JupiterClient({ apiKey: 'test-only', fetch: fetcher, minIntervalMs: 100 });
    const pending = client.quote(request);
    await vi.advanceTimersByTimeAsync(501);
    await expect(pending).resolves.toMatchObject({ inAmount: request.amount.toString() });
    await expect(client.quote(request)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const limited = new JupiterClient({
      apiKey: 'test-only', maxRetries: 0,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 })),
    });
    await expect(limited.quote(request)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('aborts timeouts and sanitizes network errors and oversize bodies', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('secret-rpc-key')), { once: true });
    }));
    const timed = new JupiterClient({ apiKey: 'test-only', fetch: fetcher, timeoutMs: 100 });
    const pending = expect(timed.quote(request)).rejects.toMatchObject({ code: 'TIMEOUT', message: 'Jupiter quote request timed out' });
    await vi.advanceTimersByTimeAsync(101);
    await pending;
    vi.useRealTimers();
    const network = new JupiterClient({
      apiKey: 'test-only', fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('https://rpc/?api-key=secret')),
    });
    await expect(network.quote(request)).rejects.toThrow('service unavailable');
    const oversized = new JupiterClient({
      apiKey: 'test-only', fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(256 * 1024 + 1))),
    });
    await expect(oversized.quote(request)).rejects.toThrow('service unavailable');
  });

  it('rejects quotes already stale on arrival and overlapping requests', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
      return Response.json(response);
    });
    const client = new JupiterClient({ apiKey: 'test-only', fetch: fetcher, quoteTtlMs: 100 });
    const pending = expect(client.quote(request)).rejects.toMatchObject({ code: 'STALE_QUOTE' });
    await expect(client.quote(request)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await vi.advanceTimersByTimeAsync(151);
    await pending;
  });
});
