import {
  createCipheriv, createDecipheriv, randomBytes, scrypt,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';

export interface WalletStatus {
  kind: 'none' | 'local' | 'readonly' | 'external';
  publicAddress: string | null;
  locked: boolean;
  canSign: boolean;
}

interface Envelope {
  version: 1;
  cipher: 'aes-256-gcm';
  kdf: 'scrypt';
  publicAddress: string;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

const KDF = { N: 65_536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const aad = (address: string): Buffer => Buffer.from(`wallet-v1:aes-256-gcm:scrypt:${address}`);
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, KDF, (error, key) => error ? reject(error) : resolve(key));
  });
}
function wipeGeneratedPair(pair: Keypair): void {
  // web3.js secretKey is a copy; clearing it alone does not clear its backing key.
  const backing = (pair as unknown as { _keypair: { secretKey: Uint8Array } })._keypair;
  backing.secretKey.fill(0);
}

/** Local server signer. Browser wallets are separate, address-only selections here. */
export class WalletVault {
  private readonly directory: string;
  private readonly filename: string;
  private readonly timeoutMs: number;
  private signer: Keypair | null = null;
  private signerBytes: Buffer | null = null;
  private selected: WalletStatus['kind'] = 'none';
  private address: string | null = null;
  private timer?: NodeJS.Timeout;
  private expiresAt = 0;
  private epoch = 0;
  private busy = false;

  constructor(options: { directory?: string; filePath?: string; unlockTimeoutMs?: number }) {
    if (!options.directory && !options.filePath) throw new Error('Wallet storage location is required');
    this.filename = options.filePath
      ? path.resolve(options.filePath)
      : path.join(path.resolve(options.directory!), 'wallet.vault.json');
    this.directory = path.dirname(this.filename);
    if (options.directory && path.resolve(options.directory) !== this.directory) {
      throw new Error('Wallet storage locations do not match');
    }
    this.timeoutMs = options.unlockTimeoutMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 60 * 60_000) {
      throw new Error('Invalid wallet unlock timeout');
    }
    if (fs.existsSync(this.directory)) this.secureDirectory();
    if (fs.existsSync(this.filename)) {
      this.address = this.readEnvelope().publicAddress;
      this.selected = 'local';
    }
  }

  status(): WalletStatus {
    this.checkExpiry();
    return {
      kind: this.selected, publicAddress: this.address,
      locked: this.signer === null, canSign: this.selected === 'local' && this.signer !== null,
    };
  }

  async create(password: string): Promise<WalletStatus> {
    return this.exclusive(async () => {
      this.validatePassword(password);
      const epoch = this.epoch;
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.secureDirectory();
      if (fs.existsSync(this.filename)) throw new Error('A local wallet already exists');
      const pair = Keypair.generate();
      const bytes = pair.secretKey;
      const secret = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let key: Buffer | undefined;
      let temporary: string | undefined;
      try {
        const salt = randomBytes(32);
        const iv = randomBytes(12);
        key = await derive(password, salt);
        if (epoch !== this.epoch) throw new Error('Wallet operation cancelled');
        const publicAddress = pair.publicKey.toBase58();
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aad(publicAddress));
        const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
        const envelope: Envelope = {
          version: 1, cipher: 'aes-256-gcm', kdf: 'scrypt', publicAddress,
          salt: salt.toString('hex'), iv: iv.toString('hex'),
          tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex'),
        };
        temporary = path.join(this.directory, `.wallet-${randomBytes(16).toString('hex')}`);
        const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify(envelope));
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        // Publish atomically without ever overwriting an existing wallet.
        fs.linkSync(temporary, this.filename);
        fs.unlinkSync(temporary);
        temporary = undefined;
        const directoryFd = fs.openSync(this.directory, fs.constants.O_RDONLY);
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
        this.lock();
        this.selected = 'local';
        this.address = publicAddress;
        return this.status();
      } catch (error) {
        if (error instanceof Error && error.message === 'Wallet operation cancelled') throw error;
        throw new Error('Unable to create encrypted wallet');
      } finally {
        key?.fill(0);
        secret.fill(0);
        wipeGeneratedPair(pair);
        if (temporary) fs.unlinkSync(temporary);
      }
    });
  }

  async unlock(password: string): Promise<WalletStatus> {
    return this.exclusive(async () => {
      const epoch = this.epoch;
      const { pair, secret } = await this.decrypt(password);
      if (epoch !== this.epoch) {
        secret.fill(0);
        throw new Error('Wallet operation cancelled');
      }
      this.lock();
      this.signer = pair;
      this.signerBytes = secret;
      this.selected = 'local';
      this.address = pair.publicKey.toBase58();
      this.expiresAt = Date.now() + this.timeoutMs;
      this.timer = setTimeout(() => this.lock(), this.timeoutMs);
      this.timer.unref();
      return this.status();
    });
  }

  lock(): WalletStatus {
    this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.signerBytes?.fill(0);
    this.signerBytes = null;
    this.signer = null;
    this.expiresAt = 0;
    return this.status();
  }

  async export(password: string): Promise<number[]> {
    return this.exclusive(async () => {
      const epoch = this.epoch;
      const { secret } = await this.decrypt(password);
      try {
        if (epoch !== this.epoch) throw new Error('Wallet operation cancelled');
        return Array.from(secret);
      } finally { secret.fill(0); }
    });
  }

  selectAddress(address: string, kind: 'readonly' | 'external' = 'readonly'): WalletStatus {
    const canonical = new PublicKey(address).toBase58();
    if (kind !== 'readonly' && kind !== 'external') throw new Error('Invalid wallet selection');
    this.lock();
    this.selected = kind;
    this.address = canonical;
    return this.status();
  }

  /** Explicit use only; never selects a wallet or initiates a trade. */
  getSigner(): Keypair {
    this.checkExpiry();
    if (this.selected !== 'local' || !this.signer) throw new Error('Local wallet is locked or not selected');
    return this.signer;
  }

  private checkExpiry(): void {
    if (this.signer && Date.now() >= this.expiresAt) this.lock();
  }

  private validatePassword(password: string): void {
    if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
      throw new Error('Wallet password must contain 12 to 1024 characters');
    }
  }

  private secureDirectory(): void {
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe wallet directory');
    fs.chmodSync(this.directory, 0o700);
  }

  private readEnvelope(): Envelope {
    this.secureDirectory();
    const fd = fs.openSync(this.filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o777) !== 0o600 ||
          (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe wallet file');
      const value = JSON.parse(fs.readFileSync(fd, 'utf8')) as Envelope;
      if (value.version !== 1 || value.cipher !== 'aes-256-gcm' || value.kdf !== 'scrypt' ||
          !/^[a-f0-9]{64}$/.test(value.salt) || !/^[a-f0-9]{24}$/.test(value.iv) ||
          !/^[a-f0-9]{32}$/.test(value.tag) || !/^[a-f0-9]{128}$/.test(value.ciphertext) ||
          new PublicKey(value.publicAddress).toBase58() !== value.publicAddress) {
        throw new Error('Invalid wallet file');
      }
      return value;
    } finally { fs.closeSync(fd); }
  }

  private async decrypt(password: string): Promise<{ pair: Keypair; secret: Buffer }> {
    let key: Buffer | undefined;
    let secret: Buffer | undefined;
    let unverified: Buffer | undefined;
    try {
      this.validatePassword(password);
      const envelope = this.readEnvelope();
      key = await derive(password, Buffer.from(envelope.salt, 'hex'));
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'hex'));
      cipher.setAAD(aad(envelope.publicAddress));
      cipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      unverified = cipher.update(Buffer.from(envelope.ciphertext, 'hex'));
      secret = Buffer.concat([unverified, cipher.final()]);
      const pair = Keypair.fromSecretKey(secret);
      if (pair.publicKey.toBase58() !== envelope.publicAddress) {
        throw new Error('Invalid wallet');
      }
      const result = { pair, secret };
      secret = undefined;
      return result;
    } catch {
      throw new Error('Wallet authentication failed');
    } finally {
      key?.fill(0);
      unverified?.fill(0);
      secret?.fill(0);
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Wallet operation already in progress');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
}
