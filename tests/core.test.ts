import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, publicConfig, redactUrl, toWsUrl } from '../src/config';
import {
  applyPercentDown,
  bondingCurveProgress,
  estimateSellProceeds,
  marketCapSol,
  netOfBuyFees,
  priceSolPerToken,
  solOutForTokensIn,
  solToLamports,
  tokensOutForSolIn,
} from '../src/pumpfun';
import { evaluateExit, type StrategyConfig } from '../src/trading/strategy';
import { quoteBuy, quoteSell } from '../src/trading/trader';
import { loadKeypair } from '../src/trading/wallet';
import { errorMessage } from '../src/utils/async';

const LAUNCH = {
  virtualSolReserves: 30_000_000_000n,
  virtualTokenReserves: 1_073_000_000_000_000n,
  realSolReserves: 0n,
  realTokenReserves: 793_100_000_000_000n,
};

describe('bonding curve math', () => {
  it('computes the launch price and market cap', () => {
    const price = priceSolPerToken(LAUNCH.virtualSolReserves, LAUNCH.virtualTokenReserves);
    expect(price).toBeCloseTo(2.7959e-8, 11);
    expect(marketCapSol(price, 1_000_000_000_000_000n)).toBeCloseTo(27.96, 2);
  });

  it('computes curve progress', () => {
    expect(bondingCurveProgress(793_100_000_000_000n)).toBe(0);
    expect(bondingCurveProgress(396_550_000_000_000n)).toBe(50);
    expect(bondingCurveProgress(0n)).toBe(100);
  });

  it('buy and sell are consistent with the constant product', () => {
    const solIn = solToLamports(1);
    const tokens = tokensOutForSolIn(LAUNCH, solIn);
    expect(tokens).toBe(34_612_903_225_806n);
    const after = {
      ...LAUNCH,
      virtualSolReserves: LAUNCH.virtualSolReserves + solIn,
      virtualTokenReserves: LAUNCH.virtualTokenReserves - tokens,
    };
    // selling right back returns (almost) exactly what went in, before fees
    expect(Number(solOutForTokensIn(after, tokens))).toBeCloseTo(Number(solIn), -2);
    expect(tokensOutForSolIn({ ...LAUNCH, realTokenReserves: 5n }, solIn)).toBe(5n);
  });

  it('applies fees and slippage', () => {
    expect(netOfBuyFees(10_100n, 100n)).toBe(10_000n);
    expect(applyPercentDown(1_000n, 15)).toBe(850n);
    expect(applyPercentDown(1_000n, 100)).toBe(0n);
    expect(estimateSellProceeds(LAUNCH, 0n, 1)).toBe(0n);
  });

  it('quotes buys and sells with slippage protection', () => {
    const cfg = { buyAmountSol: 0.1, estimatedFeePercent: 1.5, slippagePercent: 10 };
    const q = quoteBuy(cfg, LAUNCH);
    expect(q.spend).toBe(100_000_000n);
    expect(q.minTokensOut).toBeLessThan(q.expectedTokens);
    expect(q.minTokensOut).toBe(applyPercentDown(q.expectedTokens, 10));
    const s = quoteSell(cfg, LAUNCH, q.expectedTokens);
    expect(s.minSolOutput).toBeLessThan(s.expectedLamports);
  });
});

describe('exit strategy', () => {
  const s: StrategyConfig = {
    takeProfitPercent: 50,
    stopLossPercent: 10,
    trailingStopPercent: 0,
    minGainPercent: 5,
    noGainExitSeconds: 20,
    maxHoldSeconds: 120,
  };
  const at = (seconds: number, valueSol: number, highestValueSol = valueSol) =>
    evaluateExit({ costSol: 1, valueSol, highestValueSol, openedAt: 0, now: seconds * 1000 }, s);

  it('holds while young and flat', () => {
    expect(at(5, 1.01)).toMatchObject({ exit: false });
  });
  it('takes profit', () => {
    expect(at(1, 1.5)).toMatchObject({ exit: true, reason: 'take_profit' });
  });
  it('stops losses', () => {
    expect(at(1, 0.9)).toMatchObject({ exit: true, reason: 'stop_loss' });
  });
  it('exits quickly when the token does not appreciate', () => {
    expect(at(20, 1.04)).toMatchObject({ exit: true, reason: 'no_gain_timeout' });
    expect(at(20, 1.06)).toMatchObject({ exit: false });
  });
  it('exits after the max hold time', () => {
    expect(at(120, 1.2)).toMatchObject({ exit: true, reason: 'max_hold_time' });
  });
  it('applies a trailing stop once the minimum gain was reached', () => {
    const trailing = { ...s, trailingStopPercent: 10 };
    const ev = (value: number, peak: number) =>
      evaluateExit({ costSol: 1, valueSol: value, highestValueSol: peak, openedAt: 0, now: 1000 }, trailing);
    expect(ev(1.3, 1.4)).toMatchObject({ exit: false });
    expect(ev(1.25, 1.4)).toMatchObject({ exit: true, reason: 'trailing_stop' });
    expect(ev(1.0, 1.04)).toMatchObject({ exit: false }); // peak below MIN_GAIN – trailing inactive
  });
});

describe('config', () => {
  it('uses safe defaults (paper trading, public RPC)', () => {
    const cfg = loadConfig({});
    expect(cfg.trading.dryRun).toBe(true);
    expect(cfg.rpc.endpoints.map((e) => e.http)).toEqual(['https://api.mainnet-beta.solana.com']);
    expect(cfg.rpc.endpoints[0].ws).toBe('wss://api.mainnet-beta.solana.com');
    expect(cfg.strategy).toMatchObject({ takeProfitPercent: 50, stopLossPercent: 10, noGainExitSeconds: 20 });
    expect(cfg.api.host).toBe('127.0.0.1');
  });

  it('builds a Helius endpoint with public fallback', () => {
    const cfg = loadConfig({ HELIUS_API_KEY: 'abc', FALLBACK_RPC_URLS: 'https://a.example, https://b.example' });
    expect(cfg.rpc.endpoints.map((e) => e.http)).toEqual([
      'https://mainnet.helius-rpc.com/?api-key=abc',
      'https://a.example',
      'https://b.example',
    ]);
    expect(cfg.rpc.endpoints[0].ws).toBe('wss://mainnet.helius-rpc.com/?api-key=abc');
    expect(publicConfig(cfg).rpc.endpoints[0]).toBe('https://mainnet.helius-rpc.com?***');
  });

  it('parses numbers and booleans', () => {
    const cfg = loadConfig({ DRY_RUN: 'false', LIVE_TRADING_ACK: 'EU_ENTENDO_O_RISCO', WALLET_PRIVATE_KEY: 'x', BUY_AMOUNT_SOL: '0.05', AUTO_BUY: 'no' });
    expect(cfg.trading).toMatchObject({ dryRun: false, buyAmountSol: 0.05, autoBuy: false });
  });

  it('rejects invalid configuration', () => {
    expect(() => loadConfig({ DRY_RUN: 'false' })).toThrow(ConfigError);
    expect(() => loadConfig({ BUY_AMOUNT_SOL: 'abc' })).toThrow(/BUY_AMOUNT_SOL/);
    expect(() => loadConfig({ DRY_RUN: 'maybe' })).toThrow(ConfigError);
    expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: 't' })).toThrow(/TELEGRAM_CHAT_ID/);
    expect(() => loadConfig({ FALLBACK_RPC_URLS: 'ftp://x' })).toThrow(ConfigError);
  });

  it('helpers', () => {
    expect(toWsUrl('http://localhost:8899')).toBe('ws://localhost:8899');
    const authenticatedUrl = new URL('https://rpc.example/private-key');
    authenticatedUrl.username = 'test-user';
    authenticatedUrl.password = 'test-password';
    expect(redactUrl(authenticatedUrl.href)).toBe('https://rpc.example?***');
    expect(redactUrl('https://rpc.example/path?key=secret')).toBe('https://rpc.example?***');
  });

  it('never exposes the private key', () => {
    const cfg = loadConfig({ DRY_RUN: 'false', LIVE_TRADING_ACK: 'EU_ENTENDO_O_RISCO', WALLET_PRIVATE_KEY: 'super-secret', API_KEY: 'k', JUPITER_API_KEY: 'jupiter-secret' });
    expect(JSON.stringify(publicConfig(cfg))).not.toContain('super-secret');
    expect(JSON.stringify(publicConfig(cfg))).not.toContain('"k"');
    expect(JSON.stringify(publicConfig(cfg))).not.toContain('jupiter-secret');
  });

  it('redacts authenticated provider error URLs', () => {
    const message = errorMessage(new Error('RPC error at https://rpc.example/path/provider-secret?key=another-secret'));
    expect(message).not.toContain('provider-secret');
    expect(message).not.toContain('another-secret');
    expect(message).toContain('[endpoint redacted]');
  });

  it('requires explicit live acknowledgement and auth for non-local binding', () => {
    expect(() => loadConfig({ DRY_RUN: 'false', WALLET_PRIVATE_KEY: 'x' })).toThrow(/LIVE_TRADING_ACK/);
    expect(() => loadConfig({ API_HOST: '0.0.0.0' })).toThrow(/API_KEY/);
    expect(() => loadConfig({ WS_URL: 'https://rpc.example' })).toThrow(/WS_URL/);
    expect(() => loadConfig({ FALLBACK_RPC_URLS: 'https://' })).toThrow(/FALLBACK_RPC_URLS/);
    expect(() => loadConfig({ API_ALLOWED_HOSTS: '*' })).toThrow(/API_ALLOWED_HOSTS/);
    expect(() => loadConfig({ API_ALLOWED_ORIGINS: 'http://external.example' })).toThrow(/API_ALLOWED_ORIGINS/);
    expect(loadConfig({
      API_ALLOWED_HOSTS: 'bot.example', API_ALLOWED_ORIGINS: 'https://bot.example',
    }).api.allowedOrigins).toEqual(['https://bot.example']);
    expect(loadConfig({ API_HOST: '0.0.0.0', API_KEY: 'local-test-only' }).api.host).toBe('0.0.0.0');
  });
});

describe('wallet loading', () => {
  const kp = Keypair.generate();

  it('accepts base58, JSON array and file paths', () => {
    expect(loadKeypair(bs58.encode(kp.secretKey)).publicKey).toEqual(kp.publicKey);
    expect(loadKeypair(JSON.stringify(Array.from(kp.secretKey))).publicKey).toEqual(kp.publicKey);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-')), 'id.json');
    fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
    expect(loadKeypair(file).publicKey).toEqual(kp.publicKey);
  });

  it('rejects garbage without leaking it', () => {
    expect(() => loadKeypair('not-a-key-0OIl')).toThrow();
    try {
      loadKeypair('not-a-key-0OIl');
    } catch (error) {
      expect(String(error)).not.toContain('not-a-key-0OIl');
    }
  });
});

describe('rpc failover', () => {
  it('tries every endpoint once and sticks to the one that works', async () => {
    const { RpcManager } = await import('../src/rpc/rpcManager');
    const rpc = new RpcManager([
      { http: 'http://a.invalid', ws: 'ws://a.invalid', label: 'a' },
      { http: 'http://b.invalid', ws: 'ws://b.invalid', label: 'b' },
      { http: 'http://c.invalid', ws: 'ws://c.invalid', label: 'c' },
    ]);
    const seen: string[] = [];
    const result = await rpc.call('test', async (c) => {
      seen.push(c.rpcEndpoint);
      if (!c.rpcEndpoint.includes('c.invalid')) throw new Error('down');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen).toEqual(['http://a.invalid', 'http://b.invalid', 'http://c.invalid']);
    expect(rpc.currentEndpoint).toBe('http://c.invalid');
    await expect(rpc.call('test', async () => Promise.reject(new Error('all down')))).rejects.toThrow('all down');
  });
});
