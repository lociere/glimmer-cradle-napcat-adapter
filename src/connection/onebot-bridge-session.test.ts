import { describe, expect, it, vi } from 'vitest';
import type { ExtensionLogger } from '@glimmer-cradle/extension-sdk';
import { OneBotBridgeSession } from './onebot-bridge-session';

const logger: ExtensionLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('OneBotBridgeSession lifecycle', () => {
  it('does not publish disconnect callbacks after disposal starts', async () => {
    const onDisconnected = vi.fn();
    const session = new OneBotBridgeSession(logger, {
      host: '127.0.0.1',
      port: 0,
      path: '/',
      accessToken: '',
      actionTimeoutMs: 100,
      readinessProbeEnabled: false,
      onMessageEvent: vi.fn(),
      onDisconnected,
    });

    await session.dispose();
    const lifecycle = session as unknown as { handleClientDisconnected(): void };
    lifecycle.handleClientDisconnected();

    expect(onDisconnected).not.toHaveBeenCalled();
    await expect(session.dispose()).resolves.toBeUndefined();
  });
});
