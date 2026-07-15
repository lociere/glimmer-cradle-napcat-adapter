import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import type { ExtensionLogger } from '@glimmer-cradle/extension-sdk';

interface NapcatWebUiConfig {
  host?: string;
  port?: number;
  token?: string;
}

interface NapcatApiEnvelope<T> {
  code: number;
  data?: T;
  message?: string;
}

export interface NapcatLoginStatus {
  isLogin: boolean;
  isOffline: boolean;
  qrcodeurl: string;
  loginError: string;
}

export interface NapcatAccountInfo {
  uin?: number | string;
  nickname?: string;
  online?: boolean;
  avatarUrl?: string;
  [key: string]: unknown;
}

export interface NapcatWebUiSnapshot {
  endpoint: string;
  health: NapcatWebUiHealthSnapshot;
  loginStatus: NapcatLoginStatus | null;
  accountInfo: NapcatAccountInfo | null;
  quickLoginAccounts: string[];
  autoLoginAccount: string;
  qrcode: string;
}

export interface NapcatWebUiHealthSnapshot {
  state: 'ready' | 'unavailable';
  endpoint: string;
  summary: string;
  checkedAt: string;
}

export class NapcatWebUiClient {
  private credential: string | null = null;

  constructor(
    private readonly logger: ExtensionLogger,
    private readonly workDir: string,
  ) {}

  async getSnapshot(): Promise<NapcatWebUiSnapshot> {
    const health = await this.getHealth();
    if (health.state !== 'ready') {
      return {
        endpoint: health.endpoint,
        health,
        loginStatus: null,
        accountInfo: null,
        quickLoginAccounts: [],
        autoLoginAccount: '',
        qrcode: '',
      };
    }

    const [loginStatus, accountInfo, quickLoginAccounts, autoLoginAccount, qrcode] =
      await Promise.all([
        this.post<NapcatLoginStatus>('/QQLogin/CheckLoginStatus', {}).catch(() => null),
        this.post<NapcatAccountInfo>('/QQLogin/GetQQLoginInfo', {}).catch(() => null),
        this.post<string[]>('/QQLogin/GetQuickLoginList', {}).catch(() => []),
        this.post<string>('/QQLogin/GetQuickLoginQQ', {}).catch(() => ''),
        this.post<{ qrcode?: string }>('/QQLogin/GetQQLoginQrcode', {})
          .then((value) => value.qrcode ?? '')
          .catch(() => ''),
      ]);

    return {
      endpoint: health.endpoint,
      health,
      loginStatus,
      accountInfo,
      quickLoginAccounts,
      autoLoginAccount,
      qrcode,
    };
  }

  async getHealth(): Promise<NapcatWebUiHealthSnapshot> {
    const endpoint = await this.resolveEndpoint();
    try {
      await this.probeWebUi(endpoint);
      return {
        state: 'ready',
        endpoint,
        summary: 'NapCat WebUI 已响应。',
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        state: 'unavailable',
        endpoint,
        summary: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async refreshQrcode(): Promise<{ qrcode: string }> {
    await this.post<null>('/QQLogin/RefreshQRcode', {});
    const result = await this.post<{ qrcode?: string }>('/QQLogin/GetQQLoginQrcode', {});
    return { qrcode: result.qrcode ?? '' };
  }

  async setAutoLoginAccount(uin: string): Promise<void> {
    await this.post<null>('/QQLogin/SetQuickLoginQQ', { uin });
  }

  async quickLogin(uin: string): Promise<void> {
    await this.post<null>('/QQLogin/SetQuickLogin', { uin });
  }

  async openWebUi(): Promise<{ url: string }> {
    const endpoint = await this.resolveEndpoint();
    await this.probeWebUi(endpoint);
    return { url: `${endpoint}/webui` };
  }

  private async probeWebUi(endpoint: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(`${endpoint}/webui`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`NapCat WebUI 未就绪：NapCat 上游未启动、未注入或管理端口未监听，无法访问 ${endpoint}/webui。${message ? ` (${message})` : ''}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(route: string, body: Record<string, unknown>): Promise<T> {
    const endpoint = await this.resolveEndpoint();
    const credential = await this.getCredential();
    const response = await fetch(`${endpoint}/api${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify(body),
    });
    const envelope = await response.json() as NapcatApiEnvelope<T>;
    if (envelope.code !== 0) {
      throw new Error(envelope.message || `NapCat WebUI request failed: ${route}`);
    }
    return envelope.data as T;
  }

  private async getCredential(): Promise<string> {
    if (this.credential) return this.credential;
    const config = await this.readConfig();
    const token = String(config.token ?? '').trim();
    if (!token) {
      throw new Error('NapCat WebUI token is empty');
    }

    const endpoint = await this.resolveEndpoint(config);
    const hash = crypto.createHash('sha256').update(`${token}.napcat`).digest('hex');
    const response = await fetch(`${endpoint}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash }),
    });
    const envelope = await response.json() as NapcatApiEnvelope<{ Credential?: string }>;
    if (envelope.code !== 0 || !envelope.data?.Credential) {
      throw new Error(envelope.message || 'NapCat WebUI authentication failed');
    }
    this.credential = envelope.data.Credential;
    return this.credential;
  }

  private async resolveEndpoint(config?: NapcatWebUiConfig): Promise<string> {
    const webui = config ?? await this.readConfig();
    const host = normalizeHost(webui.host ?? '127.0.0.1');
    const port = Number(webui.port ?? 6099);
    return `http://${host}:${port}`;
  }

  private async readConfig(): Promise<NapcatWebUiConfig> {
    const configPath = path.join(this.workDir, 'config', 'webui.json');
    try {
      return JSON.parse(await fs.readFile(configPath, 'utf8')) as NapcatWebUiConfig;
    } catch (err) {
      this.logger.warn('[napcat] WebUI config read failed', {
        file: configPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }
}

function normalizeHost(host: string): string {
  const value = host.trim();
  if (!value || value === '::' || value === '0.0.0.0') return '127.0.0.1';
  return value;
}
