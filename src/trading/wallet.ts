import fs from 'node:fs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Loads a keypair from either:
 *  - a base58 encoded 64-byte secret key (Phantom / Solflare "export private key"), or
 *  - a JSON array of 64 numbers (solana-keygen format), or
 *  - a path to a solana-keygen JSON file.
 */
export function loadKeypair(secret: string): Keypair {
  const value = secret.trim();
  let bytes: Uint8Array;

  try {
    if (value.startsWith('[')) {
      bytes = Uint8Array.from(JSON.parse(value) as number[]);
    } else if (value.endsWith('.json') && fs.existsSync(value)) {
      bytes = Uint8Array.from(JSON.parse(fs.readFileSync(value, 'utf8')) as number[]);
    } else {
      bytes = bs58.decode(value);
    }
  } catch {
    // Never include the secret itself in error messages.
    throw new Error('WALLET_PRIVATE_KEY could not be parsed (expected base58 string, JSON array or keypair file path)');
  }

  if (bytes.length !== 64) {
    throw new Error(`WALLET_PRIVATE_KEY must decode to 64 bytes, got ${bytes.length}`);
  }
  return Keypair.fromSecretKey(bytes);
}
