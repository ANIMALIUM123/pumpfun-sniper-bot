import type { RpcManager } from '../src/rpc/rpcManager';
import { PumpFunIndexer } from '../src/indexer/pumpfunIndexer';
import { describe, expect, it, vi } from 'vitest';
import { PUMP_PROGRAM_ID } from '../src/pumpfun';

const logs = (signature: string) => ({
  signature, err: null,
  logs: [`Program ${PUMP_PROGRAM_ID.toBase58()} invoke [1]`, 'Program log: Instruction: CreateV2'],
});

describe('bounded creation recovery', () => {
  it('deduplicates pending signatures and limits concurrent RPC recovery', async () => {
    const call = vi.fn(() => new Promise(() => {}));
    const indexer = new PumpFunIndexer({ call } as unknown as RpcManager, {
      commitment: 'confirmed', heartbeatTimeoutMs: 30_000,
    });
    indexer.onLogs(logs('same'), { slot: 1 });
    indexer.onLogs(logs('same'), { slot: 1 });
    for (let i = 0; i < 10; i++) indexer.onLogs(logs(`unique-${i}`), { slot: 1 });
    expect(call).toHaveBeenCalledTimes(4);
    await indexer.stop();
  });

  it('ignores failed recovered transactions before accessing their instructions', async () => {
    const transaction = { meta: { err: { InstructionError: [0, 'Custom'] } } };
    const call = vi.fn().mockResolvedValue(transaction);
    const indexer = new PumpFunIndexer({ call } as unknown as RpcManager, {
      commitment: 'confirmed', heartbeatTimeoutMs: 30_000,
    });
    const token = vi.fn();
    indexer.on('token', token);
    indexer.onLogs(logs('failed'), { slot: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(1);
    expect(token).not.toHaveBeenCalled();
  });
});
