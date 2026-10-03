import type { BuyResult, SellResult, Trader, TradeTarget } from '../trading/trader';
import { lamportsToSol, solToLamports } from '../pumpfun';
import type { JupiterClient, JupiterQuote } from './index';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface JupiterPaperOptions {
  buyAmountSol: number;
  /** Conservative modeled network cost, not an on-chain fee measurement. */
  estimatedNetworkFeeLamports?: bigint;
}

/** Simulates fills from fresh official Jupiter routes; never signs or submits. */
export class JupiterPaperTrader implements Trader {
  readonly mode = 'paper' as const;
  readonly walletAddress = null;
  private active = false;
  private entryGuard: () => boolean = () => true;
  private readonly spend: bigint;
  private readonly networkFee: bigint;

  constructor(private readonly client: JupiterClient, options: JupiterPaperOptions) {
    if (!Number.isFinite(options.buyAmountSol) || options.buyAmountSol <= 0) {
      throw new Error('Invalid Jupiter paper buy budget');
    }
    this.spend = solToLamports(options.buyAmountSol);
    this.networkFee = options.estimatedNetworkFeeLamports ?? 5000n;
    if (this.networkFee < 0n || this.networkFee >= this.spend) {
      throw new Error('Invalid Jupiter paper network fee');
    }
  }

  async init(): Promise<void> {
    if (!this.client.status().configured) throw new Error('Jupiter API key is required for quoted paper trades');
    this.active = true;
  }

  stop(): void { this.active = false; }
  cachedBalanceSol(): null { return null; }
  setEntryGuard(guard: () => boolean): void { this.entryGuard = guard; }

  buy(target: TradeTarget): Promise<BuyResult> {
    return this.buyMint(target.mint.toBase58());
  }

  sell(target: TradeTarget, tokenAmount: bigint): Promise<SellResult> {
    return this.sellMint(target.mint.toBase58(), tokenAmount);
  }

  async buyMint(mint: string, spendLamports = this.spend): Promise<BuyResult> {
    this.assertActive();
    if (!this.entryGuard()) throw new Error('Jupiter paper entry is disabled');
    if (typeof spendLamports !== 'bigint' || spendLamports <= this.networkFee) {
      throw new Error('Invalid Jupiter paper buy budget');
    }
    const startedAt = Date.now();
    const quote = await this.client.quote({
      inputMint: SOL_MINT, outputMint: mint, amount: spendLamports - this.networkFee,
    });
    this.assertActive();
    if (!this.entryGuard()) throw new Error('Jupiter paper entry is disabled');
    this.client.assertFresh(quote);
    return {
      signature: null, solSpent: lamportsToSol(spendLamports),
      tokenAmount: BigInt(quote.otherAmountThreshold), latencyMs: Date.now() - startedAt,
    };
  }

  async quoteExit(mint: string, tokenAmount: bigint): Promise<{ quote: JupiterQuote; valueSol: number }> {
    this.assertActive();
    const quote = await this.client.quote({ inputMint: mint, outputMint: SOL_MINT, amount: tokenAmount });
    this.assertActive();
    this.client.assertFresh(quote);
    const net = BigInt(quote.otherAmountThreshold) - this.networkFee;
    if (net <= 0n) throw new Error('Jupiter paper proceeds do not cover modeled network fees');
    return { quote, valueSol: lamportsToSol(net) };
  }

  async sellMint(mint: string, tokenAmount: bigint): Promise<SellResult> {
    const startedAt = Date.now();
    const { valueSol } = await this.quoteExit(mint, tokenAmount);
    return {
      signature: null, solReceived: valueSol,
      tokenAmountSold: tokenAmount, latencyMs: Date.now() - startedAt,
    };
  }

  private assertActive(): void {
    if (!this.active) throw new Error('Jupiter paper trader is not active');
  }
}
