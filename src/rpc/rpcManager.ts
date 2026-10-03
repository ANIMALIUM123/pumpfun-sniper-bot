import { Connection, type Commitment } from '@solana/web3.js';
import type { RpcEndpoint } from '../config';
import { redactUrl } from '../config';
import { errorMessage } from '../utils/async';
import { getLogger } from '../utils/logger';

/**
 * Holds one `Connection` per configured endpoint (primary first, then fallbacks)
 * and transparently fails over when an endpoint misbehaves.
 */
export class RpcManager {
  private readonly log = getLogger('rpc');
  private readonly connections: Connection[];
  private index = 0;
  private switchedAt = 0;

  constructor(
    private readonly endpoints: RpcEndpoint[],
    commitment: Commitment = 'confirmed',
    /** After failing over, try the primary endpoint again once this much time has passed. */
    private readonly primaryRetryMs = 60_000,
  ) {
    if (endpoints.length === 0) throw new Error('RpcManager requires at least one endpoint');
    this.connections = endpoints.map(
      (e) =>
        new Connection(e.http, {
          commitment,
          wsEndpoint: e.ws,
          disableRetryOnRateLimit: true,
          confirmTransactionInitialTimeout: 60_000,
        }),
    );
  }

  /** Connection for the currently active endpoint. */
  get connection(): Connection {
    if (this.index !== 0 && Date.now() - this.switchedAt > this.primaryRetryMs) {
      this.index = 0;
      this.log.info({ endpoint: this.currentEndpoint }, 'Retrying primary RPC endpoint');
    }
    return this.connections[this.index];
  }

  get currentEndpoint(): string {
    return redactUrl(this.endpoints[this.index].http);
  }

  get endpointCount(): number {
    return this.connections.length;
  }

  /** Switches to the next endpoint (round-robin) and returns its connection. */
  rotate(reason: string): Connection {
    if (this.connections.length > 1) {
      const from = this.currentEndpoint;
      this.index = (this.index + 1) % this.connections.length;
      this.switchedAt = Date.now();
      this.log.warn({ from, to: this.currentEndpoint, reason }, 'Switching RPC endpoint');
    }
    return this.connection;
  }

  /**
   * Runs `fn` against the active endpoint; on failure tries the remaining endpoints
   * once each before giving up. Successful fallbacks become the new active endpoint.
   */
  async call<T>(label: string, fn: (connection: Connection) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.connections.length; attempt++) {
      try {
        // First attempt may switch back to the primary; retries walk the endpoints by index.
        return await fn(attempt === 0 ? this.connection : this.connections[this.index]);
      } catch (error) {
        lastError = error;
        this.log.debug({ label, endpoint: this.currentEndpoint, err: errorMessage(error) }, 'RPC call failed');
        if (attempt < this.connections.length - 1) this.rotate(`${label} failed: ${errorMessage(error)}`);
      }
    }
    throw lastError;
  }
}
