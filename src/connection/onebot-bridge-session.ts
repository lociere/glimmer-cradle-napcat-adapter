import type { ExtensionLogger, WebSocket } from '@glimmer-cradle/extension-sdk';
import { WebSocketBridge } from '@glimmer-cradle/extension-sdk/utilities/websocket';
import { normalizeOB11Frames } from '../onebot/ob11-normalizer';
import type { OB11MessageEvent } from '../onebot/ob11-types';
import { OneBotActionClient, type OneBotActionCaller } from './onebot-action-client';

export interface OneBotBridgeSessionOptions {
  host: string;
  port: number;
  path: string;
  accessToken: string;
  actionTimeoutMs: number;
  readinessProbeEnabled: boolean;
  onMessageEvent(event: OB11MessageEvent): Promise<void> | void;
  onDisconnected(): void;
  onReady?(loginInfo: unknown): void;
}

export interface OneBotBridgeSessionSnapshot {
  state: 'listening' | 'connected' | 'ready' | 'disconnected' | 'error';
  endpoint: string;
  connected: boolean;
  ready: boolean;
  lastConnectedAt?: string;
  lastReadyAt?: string;
  lastDisconnectedAt?: string;
  lastError?: string;
  loginInfo?: unknown;
}

export class OneBotBridgeSession {
  private readonly actionClient: OneBotActionClient;
  private readonly bridge: WebSocketBridge;
  private state: OneBotBridgeSessionSnapshot['state'] = 'disconnected';
  private lastConnectedAt = '';
  private lastReadyAt = '';
  private lastDisconnectedAt = '';
  private lastError = '';
  private loginInfo: unknown;

  constructor(
    private readonly logger: ExtensionLogger,
    private readonly options: OneBotBridgeSessionOptions,
  ) {
    this.bridge = new WebSocketBridge(this.logger, {
      onJsonMessage: (data) => this.handleJsonMessage(data),
      onClientConnected: (socket) => this.handleClientConnected(socket),
      onClientDisconnected: () => this.handleClientDisconnected(),
    });
    this.actionClient = new OneBotActionClient(
      this.logger,
      (data) => this.bridge.sendRaw(data),
      this.options.actionTimeoutMs,
    );
  }

  start(): void {
    this.bridge.start({
      host: this.options.host,
      port: this.options.port,
      path: this.options.path,
      accessToken: this.options.accessToken,
    });
    this.state = 'listening';
  }

  async dispose(): Promise<void> {
    this.actionClient.logPendingOnStop();
    this.actionClient.rejectAll('OneBot bridge session disposed');
    this.bridge.dispose();
  }

  get callAction(): OneBotActionCaller {
    return (action, params) => this.actionClient.request(action, params);
  }

  get isConnected(): boolean {
    return this.bridge.isConnected;
  }

  getSnapshot(): OneBotBridgeSessionSnapshot {
    return {
      state: this.state,
      endpoint: `ws://${this.options.host}:${this.options.port}${this.options.path}`,
      connected: this.bridge.isConnected,
      ready: this.state === 'ready',
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.lastReadyAt ? { lastReadyAt: this.lastReadyAt } : {}),
      ...(this.lastDisconnectedAt ? { lastDisconnectedAt: this.lastDisconnectedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.loginInfo !== undefined ? { loginInfo: this.loginInfo } : {}),
    };
  }

  private handleClientConnected(socket: WebSocket): void {
    this.state = 'connected';
    this.lastConnectedAt = new Date().toISOString();
    this.lastError = '';
    this.logger.info('[napcat] OneBot client connected', {
      ready_state: socket.readyState,
    });
    if (this.options.readinessProbeEnabled) {
      void this.probeReadiness();
    }
  }

  private handleClientDisconnected(): void {
    this.actionClient.rejectAll('OneBot bridge client disconnected');
    this.state = 'disconnected';
    this.lastDisconnectedAt = new Date().toISOString();
    this.options.onDisconnected();
    this.logger.warn('[napcat] OneBot client disconnected');
  }

  private async handleJsonMessage(data: unknown): Promise<void> {
    if (this.actionClient.consumeResponse(data)) return;

    try {
      const normalizedEvents = normalizeOB11Frames(data);
      for (const event of normalizedEvents) {
        if ((event as Record<string, unknown>)['post_type'] === 'message') {
          await Promise.resolve(this.options.onMessageEvent(event as OB11MessageEvent));
        }
      }
    } catch (err) {
      this.logger.error(
        '[napcat] OneBot frame processing failed: ' +
          (err instanceof Error ? err.message : String(err)),
        { stack: err instanceof Error ? err.stack : undefined },
      );
    }
  }

  private async probeReadiness(): Promise<void> {
    try {
      const loginInfo = await this.actionClient.request('get_login_info', {});
      this.state = 'ready';
      this.lastReadyAt = new Date().toISOString();
      this.lastError = '';
      this.loginInfo = loginInfo;
      this.logger.info('[napcat] OneBot readiness confirmed', {
        has_login_info: !!loginInfo,
      });
      this.options.onReady?.(loginInfo);
    } catch (err) {
      this.state = this.bridge.isConnected ? 'connected' : 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger.warn('[napcat] OneBot readiness probe failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
