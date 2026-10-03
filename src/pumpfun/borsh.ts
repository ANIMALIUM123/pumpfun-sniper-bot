import { PublicKey } from '@solana/web3.js';

/** Thrown when a buffer is too short for the value being read. */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

/** Minimal Borsh reader for the primitive types used by the Pump.fun IDL. */
export class BorshReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  private ensure(n: number): void {
    if (this.remaining < n) {
      throw new DecodeError(`buffer underflow: need ${n} bytes at offset ${this.offset}, have ${this.remaining}`);
    }
  }

  skip(n: number): void {
    this.ensure(n);
    this.offset += n;
  }

  u8(): number {
    this.ensure(1);
    return this.buf.readUInt8(this.offset++);
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    this.ensure(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  u32(): number {
    this.ensure(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    this.ensure(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  i64(): bigint {
    this.ensure(8);
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  pubkey(): PublicKey {
    this.ensure(32);
    const v = new PublicKey(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return v;
  }

  string(maxLength = 10_000): string {
    const len = this.u32();
    if (len > maxLength) throw new DecodeError(`string length ${len} exceeds limit ${maxLength}`);
    this.ensure(len);
    const v = this.buf.toString('utf8', this.offset, this.offset + len);
    this.offset += len;
    return v;
  }

  /** Reads an optional trailing field: returns `fallback` when the buffer is exhausted (older layouts). */
  optional<T>(read: () => T, fallback: T): T {
    return this.remaining > 0 ? read() : fallback;
  }
}

/** Borsh writer used to build instruction data. */
export class BorshWriter {
  private readonly chunks: Buffer[] = [];

  raw(bytes: Buffer): this {
    this.chunks.push(Buffer.from(bytes));
    return this;
  }

  u64(value: bigint): this {
    if (value < 0n || value > 0xffffffffffffffffn) throw new RangeError(`u64 out of range: ${value}`);
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(value);
    this.chunks.push(b);
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

const DEFAULT_PUBKEY = PublicKey.default.toBase58();

/** Returns `null` for the all-zero default pubkey, else its base58 string. */
export function pubkeyOrNull(key: PublicKey): string | null {
  const s = key.toBase58();
  return s === DEFAULT_PUBKEY ? null : s;
}
