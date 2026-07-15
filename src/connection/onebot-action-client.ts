import type { ExtensionLogger } from '@glimmer-cradle/extension-sdk';

export type OneBotActionCaller = (
  action: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

interface PendingAction {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class OneBotActionClient {
  private readonly pending = new Map<string, PendingAction>();

  constructor(
    private readonly logger: ExtensionLogger,
    private readonly sendRaw: (data: string | Buffer) => boolean,
    private readonly timeoutMs: number,
  ) {}

  request(action: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const echo = `${action}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot action timeout: ${action}`));
      }, this.timeoutMs);

      this.pending.set(echo, { resolve, reject, timer });
      const sent = this.sendRaw(JSON.stringify({ action, params, echo }));
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(new Error('OneBot bridge is not connected'));
      }
    });
  }

  consumeResponse(frame: unknown): boolean {
    if (!frame || typeof frame !== 'object' || !('echo' in frame)) return false;

    const payload = frame as Record<string, unknown>;
    const echo = String(payload['echo'] ?? '');
    const pending = this.pending.get(echo);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pending.delete(echo);

    const retcode = Number(payload['retcode'] ?? payload['ret_code'] ?? 0);
    const status = String(payload['status'] ?? '').toLowerCase();
    if (retcode !== 0 || status === 'failed') {
      pending.reject(new Error(`OneBot action failed: retcode=${retcode || 'unknown'}`));
      return true;
    }

    pending.resolve(payload['data'] ?? null);
    return true;
  }

  rejectAll(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  logPendingOnStop(): void {
    if (this.pending.size > 0) {
      this.logger.warn('[napcat] rejecting pending OneBot actions', {
        pending_count: this.pending.size,
      });
    }
  }
}
