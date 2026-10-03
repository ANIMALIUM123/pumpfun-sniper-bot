import { PublicKey } from '@solana/web3.js';

/**
 * Pump.fun on-chain constants.
 * Source: official IDL & docs — https://github.com/pump-fun/pump-public-docs
 */

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
/** Wrapped SOL mint – passed as `quote_mint` for SOL-paired coins. */
export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/** Pump.fun coins always have 6 decimals. */
export const TOKEN_DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000;
/** Real token reserves at launch (793.1M tokens) – used to compute bonding-curve progress. */
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;

const d = (bytes: number[]) => Buffer.from(bytes);

/** Anchor discriminators (first 8 bytes of sha256 of the namespaced name). */
export const DISCRIMINATORS = {
  // instructions
  buyExactQuoteInV2: d([194, 171, 28, 70, 104, 77, 91, 47]),
  sellV2: d([93, 246, 130, 60, 231, 233, 64, 178]),
  // events
  createEvent: d([27, 114, 169, 77, 222, 235, 99, 118]),
  tradeEvent: d([189, 219, 127, 211, 78, 230, 97, 238]),
  // accounts
  bondingCurve: d([23, 183, 248, 55, 96, 216, 172, 96]),
  global: d([167, 232, 232, 177, 200, 108, 114, 127]),
  /** Prefix of self-CPI event instructions emitted with `emit_cpi!` (Anchor `EVENT_IX_TAG` 0x1d9acb512ea545e4, little-endian). */
  eventCpiTag: d([228, 69, 165, 46, 81, 203, 154, 29]),
} as const;

const keys = (list: string[]) => list.map((k) => new PublicKey(k));

/**
 * Fee recipients accepted by the program (see docs/FEE_RECIPIENTS.md).
 * The trader refreshes these from the on-chain `Global` account at startup and only
 * uses this list as a fallback.
 */
export const DEFAULT_FEE_RECIPIENTS = keys([
  '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
  '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ',
  '7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX',
  '9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz',
  'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY',
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
  'FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz',
  'G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP',
]);

/** Fee recipients for mayhem-mode coins. */
export const DEFAULT_RESERVED_FEE_RECIPIENTS = keys([
  'GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS',
  '4budycTjhs9fD6xw62VBducVTNgMgJJ5BgtKq7mAZwn6',
  '8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR',
  '4UQeTP1T39KZ9Sfxzo3WR5skgsaP6NZa87BAkuazLEKH',
  '8sNeir4QsLsJdYpc9RZacohhK1Y5FLU3nC5LXgYB4aa6',
  'Fh9HmeLNUMVCvejxCtCL2DbYaRyBFVJ5xrWkLnMH6fdk',
  '463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq',
  '6AUH3WEHucYZyC61hqpqYUWVto5qA5hjHuNQ32GNnNxA',
]);

export const DEFAULT_BUYBACK_FEE_RECIPIENTS = keys([
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
  '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
  '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6',
  'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD',
  'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW',
]);
