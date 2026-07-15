import type { Disposable, ExtensionAttentionLeaseRequest, SceneAttentionPort } from '@glimmer-cradle/extension-sdk';

export class ActiveAttentionStore {
  private readonly leasesByChannel = new Map<string, Disposable>();

  constructor(private readonly sceneAttention: SceneAttentionPort) {}

  focus(request: ExtensionAttentionLeaseRequest): void {
    const lease = this.sceneAttention.requestAttentionLease(request);
    this.leasesByChannel.set(request.channelId, lease);
  }

  clearFocus(): void {
    for (const lease of this.leasesByChannel.values()) {
      lease.dispose();
    }
    this.leasesByChannel.clear();
  }
}
