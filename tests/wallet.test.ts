import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WalletVault } from '../src/wallet';

const password = 'ephemeral-test-password';
const directories: string[] = [];
const vaults: WalletVault[] = [];
function vault(timeout = 1000): { vault: WalletVault; directory: string; filename: string } {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.wallet-test-'));
  directories.push(directory);
  const instance = new WalletVault({ directory, unlockTimeoutMs: timeout });
  vaults.push(instance);
  return { vault: instance, directory, filename: path.join(directory, 'wallet.vault.json') };
}
afterEach(() => {
  for (const instance of vaults.splice(0)) instance.lock();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('encrypted local wallet', () => {
  it('supports an explicit configured encrypted-vault path', async () => {
    const { directory } = vault();
    const filePath = path.join(directory, 'wallet.enc.json');
    const instance = new WalletVault({ filePath });
    vaults.push(instance);
    const status = await instance.create(password);
    expect(fs.existsSync(filePath)).toBe(true);
    const restarted = new WalletVault({ filePath });
    vaults.push(restarted);
    expect(restarted.status()).toEqual(status);
    expect(() => new WalletVault({ filePath, directory: path.join(directory, 'other') })).toThrow('do not match');
  });

  it('creates a locked wallet with authenticated ciphertext and private atomic files', async () => {
    const { vault: instance, directory, filename } = vault();
    const status = await instance.create(password);
    expect(status).toMatchObject({ kind: 'local', locked: true, canSign: false });
    expect(status.publicAddress).toBeTruthy();
    expect(() => instance.getSigner()).toThrow('locked');
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(['wallet.vault.json']);
    const saved = fs.readFileSync(filename, 'utf8');
    expect(saved).not.toContain(password);
    expect(JSON.parse(saved)).toMatchObject({ version: 1, cipher: 'aes-256-gcm', kdf: 'scrypt' });
    expect(JSON.parse(saved)).not.toHaveProperty('secretKey');
    await expect(instance.create(password)).rejects.toThrow('already exists');
    const restarted = new WalletVault({ directory });
    vaults.push(restarted);
    expect(restarted.status()).toEqual(status);
  });

  it('reauthenticates exports even while unlocked; clears retained signing bytes on lock', async () => {
    const { vault: instance } = vault();
    await instance.create(password);
    await expect(instance.unlock('incorrect-long-password')).rejects.toThrow('authentication failed');
    await instance.unlock(password);
    const signer = instance.getSigner();
    expect(signer.secretKey.some(byte => byte !== 0)).toBe(true);
    const exported = await instance.export(password);
    expect(Keypair.fromSecretKey(Uint8Array.from(exported)).publicKey.toBase58()).toBe(instance.status().publicAddress);
    await expect(instance.export('incorrect-long-password')).rejects.toThrow('authentication failed');
    expect(instance.status().canSign).toBe(true);
    instance.lock();
    expect(signer.secretKey.every(byte => byte === 0)).toBe(true);
    expect(instance.status().canSign).toBe(false);
    expect(() => instance.getSigner()).toThrow('locked');
    exported.fill(0);
  });

  it('times out the memory signer and never gives server signing to external/read-only addresses', async () => {
    const { vault: instance } = vault();
    await instance.create(password);
    vi.useFakeTimers();
    await instance.unlock(password);
    const publicAddress = instance.status().publicAddress!;
    vi.advanceTimersByTime(1001);
    expect(instance.status()).toMatchObject({ locked: true, canSign: false });
    expect(instance.selectAddress(publicAddress, 'external')).toMatchObject({
      kind: 'external', publicAddress, locked: true, canSign: false,
    });
    expect(() => instance.getSigner()).toThrow();
    expect(instance.selectAddress(publicAddress)).toMatchObject({ kind: 'readonly', canSign: false });
  });

  it('authenticates ciphertext and public-address metadata', async () => {
    const { vault: instance, filename } = vault();
    await instance.create(password);
    const original = JSON.parse(fs.readFileSync(filename, 'utf8')) as Record<string, string>;
    fs.writeFileSync(filename, JSON.stringify({ ...original, tag: '0'.repeat(32) }), { mode: 0o600 });
    await expect(instance.unlock(password)).rejects.toThrow('authentication failed');
    fs.writeFileSync(filename, JSON.stringify({ ...original, publicAddress: '11111111111111111111111111111111' }));
    await expect(instance.export(password)).rejects.toThrow('authentication failed');
    expect(instance.status().canSign).toBe(false);
  });

  it('rejects insecure file permissions and symlinked directories', async () => {
    const { vault: instance, directory, filename } = vault();
    await instance.create(password);
    fs.chmodSync(filename, 0o644);
    await expect(instance.unlock(password)).rejects.toThrow('authentication failed');
    const link = path.join(directory, 'link');
    fs.symlinkSync(directory, link);
    expect(() => new WalletVault({ directory: link })).toThrow('Unsafe wallet directory');
  });

  it('rejects weak passwords and invalidates an in-flight unlock on lock', async () => {
    const { vault: instance } = vault();
    await expect(instance.create('short')).rejects.toThrow('12 to 1024');
    await instance.create(password);
    const pending = instance.unlock(password);
    instance.lock();
    await expect(pending).rejects.toThrow('cancelled');
    expect(instance.status().canSign).toBe(false);
  });
});
