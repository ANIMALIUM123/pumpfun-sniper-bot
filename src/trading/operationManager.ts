import type { Repository } from '../database/repository';
import type { OperationMode } from '../types';

export interface OperationHooks {
  disableEntries(): void;
  enableEntries(mode: OperationMode): void;
  configureCopy(settings: unknown): Promise<unknown>;
  validateCopy(): void;
}

/** Strategy transitions never stop the independent position/exit manager. */
export class OperationManager {
  private mode: OperationMode = 'idle';
  private paused: boolean;
  private chain: Promise<unknown> = Promise.resolve();
  private requested = 0;
  private transitions = 0;

  constructor(private readonly repo: Repository, private readonly hooks: OperationHooks) {
    this.paused = repo.setting('emergency_pause') === true;
    hooks.disableEntries();
    repo.saveSetting('operation_mode', 'idle');
  }

  status() { return { mode: this.mode, paused: this.paused, transitioning: this.transitions > 0 }; }

  set(mode: OperationMode, settings?: unknown): Promise<unknown> {
    if (!['idle', 'sniper', 'copytrade'].includes(mode)) return Promise.reject(new Error('Invalid operation mode'));
    const ticket = ++this.requested;
    this.transitions++;
    this.hooks.disableEntries();
    const next = this.chain.catch(() => {}).then(async () => {
      this.mode = 'idle';
      this.repo.saveSetting('operation_mode', 'idle');
      if (settings !== undefined) await this.hooks.configureCopy(settings);
      if (mode === 'copytrade') this.hooks.validateCopy();
      if (ticket !== this.requested) return this.status();
      this.mode = mode;
      this.repo.saveSetting('operation_mode', mode);
      if (!this.paused) this.hooks.enableEntries(mode);
      this.repo.logOperation('operation_mode', { mode, paused: this.paused });
      return this.status();
    }).finally(() => { this.transitions--; });
    this.chain = next;
    return next;
  }

  configure(settings: unknown): Promise<unknown> {
    const mode = this.mode;
    return this.set(mode, settings);
  }

  pause(): void {
    this.paused = true;
    this.hooks.disableEntries();
    this.repo.saveSetting('emergency_pause', true);
    this.repo.logOperation('emergency_pause', {});
  }

  resume(): void {
    this.paused = false;
    this.repo.saveSetting('emergency_pause', false);
    if (this.transitions === 0) this.hooks.enableEntries(this.mode);
    this.repo.logOperation('emergency_resume', { mode: this.mode });
  }
}
