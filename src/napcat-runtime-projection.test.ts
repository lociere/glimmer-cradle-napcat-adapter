import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  BuiltInContributionPoint,
  materializeManifestForActivationProfile,
  validateExtensionManifest,
} from '@glimmer-cradle/extension-sdk/manifest';
import { NapcatAdapterConfigSchema, NapcatAdapterProfileModeSchema } from '../config/schema';
import { resolveAccessToken } from './connection/access-token';
import {
  buildNapcatStartupRecoveryActions,
  isQqProcessConflict,
  redactNapcatProcessOutput,
  resolveNapcatWindowsOneKeyShellLayout,
  type NapcatProcessSnapshot,
} from './process/napcat-process-controller';
import type { OneBotBridgeSessionSnapshot } from './connection/onebot-bridge-session';
import type { NapcatWebUiSnapshot } from './napcat/napcat-webui-client';
import {
  buildRuntimeProjection,
  summarizeExternalProfileState,
  summarizeManagedProfileState,
  toCoreCapabilityNodes,
  toExternalOneBotSourceNode,
  toManagedCapabilityNodes,
  toOneBotNode,
  toProcessNode,
  toWebUiNode,
} from './runtime/runtime-projection';

const now = '2026-07-04T00:00:00.000Z';

it('redacts NapCat management and login credentials from process output', () => {
  const output = redactNapcatProcessOutput(
    'WebUi Token: abc123\nWebUi URL: http://127.0.0.1:6099/webui?token=abc123\n二维码解码URL: https://txz.qq.com/p?k=login-secret&f=1',
  );

  expect(output).not.toContain('abc123');
  expect(output).not.toContain('login-secret');
  expect(output).toContain('WebUi Token: [REDACTED]');
  expect(output).toContain('token=[REDACTED]');
  expect(output).toContain('二维码解码URL: [REDACTED]');
});

function processSnapshot(overrides: Partial<NapcatProcessSnapshot>): NapcatProcessSnapshot {
  return {
    state: 'detached',
    managed: true,
    command: 'NapCatWinBootMain.exe',
    cwd: 'D:/data/packages/managed-resources/lociere.napcat-adapter/napcat',
    workDir: 'D:/data/state/extensions/lociere.napcat-adapter/napcat',
    packageDir: 'D:/data/packages/managed-resources/lociere.napcat-adapter/napcat',
    bootstrap: true,
    ready: false,
    recoveryActions: [],
    ...overrides,
  };
}

function onebotSnapshot(overrides: Partial<OneBotBridgeSessionSnapshot>): OneBotBridgeSessionSnapshot {
  return {
    state: 'disconnected',
    endpoint: 'ws://127.0.0.1:49152/',
    connected: false,
    ready: false,
    ...overrides,
  };
}

function webuiSnapshot(state: 'ready' | 'unavailable', summary: string): NapcatWebUiSnapshot {
  return {
    endpoint: 'http://127.0.0.1:6099',
    health: {
      state,
      endpoint: 'http://127.0.0.1:6099',
      summary,
      checkedAt: now,
    },
    loginStatus: null,
    accountInfo: null,
    quickLoginAccounts: [],
    autoLoginAccount: '',
    qrcode: '',
  };
}

describe('NapCat runtime projection', () => {
  it('materializes a least-privilege external profile for Personal Server', () => {
    const source = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../extension-manifest.yaml'), 'utf8'));
    const parsed = validateExtensionManifest(source);
    expect(parsed.ok).toBe(true);
    const effective = materializeManifestForActivationProfile(parsed.data!, {
      productId: 'personal-server',
      platform: 'linux-x64',
      features: new Set(['extensions']),
    });

    expect(effective.profile.id).toBe('external_onebot');
    expect(effective.manifest.permissions).not.toContain('EXTERNAL_PROCESS');
    expect(effective.manifest.permissions).toContain('EXTERNAL_NETWORK');
    expect(contributionIds(effective.manifest.contributes[BuiltInContributionPoint.managedResource]))
      .toEqual(['external-onebot-source']);
    expect(contributionIds(effective.manifest.contributes[BuiltInContributionPoint.managementSurface]))
      .toEqual(['onebot-status-external']);
  });

  it('adds process authority only for the Desktop Windows managed profile', () => {
    const source = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../extension-manifest.yaml'), 'utf8'));
    const parsed = validateExtensionManifest(source);
    expect(parsed.ok).toBe(true);
    const effective = materializeManifestForActivationProfile(parsed.data!, {
      productId: 'desktop',
      platform: 'windows-x64',
      features: new Set(['extensions']),
    }, 'managed_napcat_windows');

    expect(effective.manifest.permissions).toContain('EXTERNAL_PROCESS');
    expect(contributionIds(effective.manifest.contributes[BuiltInContributionPoint.managedResource]))
      .toEqual(['napcat-managed-process', 'webui-management']);
    expect(contributionIds(effective.manifest.contributes[BuiltInContributionPoint.managementSurface]))
      .toEqual(['onebot-status-managed', 'napcat-management']);
  });

  it('keeps bootstrap exit code 0 in starting until WebUI or OneBot is ready', () => {
    const resource = toProcessNode(processSnapshot({
      state: 'detached',
      lastExitCode: 0,
      lastError: 'NapCat bootstrap 已结束，正在等待 WebUI 或 OneBot readiness 证明注入成功。',
    }), now);

    expect(resource.state).toBe('starting');
    expect(resource.summary).toContain('等待 WebUI 或 OneBot readiness');
  });

  it('reports target QQ conflict without WebUI listener as degraded with recovery', () => {
    const process = toProcessNode(processSnapshot({
      state: 'degraded',
      lastError: '检测到 NapCat 将要注入的 QQ.exe 已在启动前运行，官方 direct 启动可能无法完成注入。',
      preexistingQqProcesses: [{ pid: 1234, startedAt: '2026-07-03T21:00:00.000Z' }],
      recoveryActions: ['关闭 NapCat 受管包内的 QQ.exe 后，从摇篮重新启动 NapCat Adapter，让官方 direct launcher 重新注入。'],
    }), now);
    const webui = toWebUiNode(webuiSnapshot(
      'unavailable',
      'NapCat WebUI 未就绪：NapCat 上游未启动、未注入或管理端口未监听，无法访问 http://127.0.0.1:6099/webui。',
    ), now);

    expect(process.state).toBe('degraded');
    expect((process.metadata.recovery_actions as string[])[0]).toContain('受管包内的 QQ.exe');
    expect(webui.state).toBe('degraded');
    expect(summarizeManagedProfileState(process, toOneBotNode(onebotSnapshot({}), now), webui))
      .toContain('官方 direct 启动可能无法完成注入');
  });

  it('explains system QQ conflict without telling the user to close every QQ process', () => {
    const actions = buildNapcatStartupRecoveryActions(true, 'system');

    expect(actions[0]).toContain('当前使用系统 QQ');
    expect(actions[0]).toContain('内置 QQ');
    expect(actions[0]).not.toContain('关闭所有 QQ');
  });

  it('does not treat a personal QQ process as a conflict for packaged NapCat QQ', () => {
    expect(isQqProcessConflict(
      { pid: 100, executablePath: 'C:/Program Files/Tencent/QQNT/QQ.exe' },
      'D:/glimmer/data/packages/managed-resources/lociere.napcat-adapter/napcat/QQ.exe',
      'packaged',
    )).toBe(false);
  });

  it('keeps system QQ target conservative when process path is unavailable', () => {
    expect(isQqProcessConflict(
      { pid: 100 },
      'C:/Program Files/Tencent/QQNT/QQ.exe',
      'system',
    )).toBe(true);
  });

  it('describes configured dedicated QQ conflicts without mentioning all QQ processes', () => {
    const actions = buildNapcatStartupRecoveryActions(true, 'configured');

    expect(actions[0]).toContain('专用 QQ');
    expect(actions[0]).toContain('managed_napcat_windows.qq_path');
    expect(actions[0]).not.toContain('关闭所有 QQ');
  });

  it('keeps the runtime profile vocabulary aligned with Host activation profiles', () => {
    const transport = NapcatAdapterConfigSchema.parse({}).transport;
    expect(transport.access_token_secret).toBe('onebot_access_token');
    expect(transport.token_from_secrets).toBe(true);
    expect(transport.access_token_env)
      .toBe('NAPCAT_ONEBOT_ACCESS_TOKEN');
    expect(NapcatAdapterProfileModeSchema.parse('external_onebot')).toBe('external_onebot');
    expect(NapcatAdapterProfileModeSchema.parse('managed_napcat_windows')).toBe('managed_napcat_windows');
    expect(() => NapcatAdapterProfileModeSchema.parse('docker')).toThrow();
  });

  it('prefers the Host-scoped Secret and refuses plain config by default', async () => {
    const transport = NapcatAdapterConfigSchema.parse({
      transport: { access_token: 'plain-config-token', access_token_env: '' },
    }).transport;

    await expect(resolveAccessToken(
      transport,
      async (key) => key === 'onebot_access_token' ? 'host-secret-token' : undefined,
    )).resolves.toBe('host-secret-token');
    await expect(resolveAccessToken(transport, async () => undefined)).resolves.toBe('');
  });

  it('resolves NapCat Windows OneKey Shell layout from versions config', () => {
    const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-onekey-'));
    try {
      const version = '9.9.26-44498';
      const appRoot = path.join(packageDir, 'versions', version, 'resources', 'app');
      const napcatAppDir = path.join(appRoot, 'napcat');
      fs.mkdirSync(napcatAppDir, { recursive: true });
      fs.mkdirSync(path.join(packageDir, 'versions'), { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'NapCatWinBootMain.exe'), '');
      fs.writeFileSync(path.join(packageDir, 'QQ.exe'), '');
      fs.writeFileSync(
        path.join(packageDir, 'versions', 'config.json'),
        `${JSON.stringify({ curVersion: version, baseVersion: version })}\n`,
      );
      fs.writeFileSync(path.join(appRoot, 'package.json'), `${JSON.stringify({ main: './napcat/napcat.mjs' })}\n`);
      fs.writeFileSync(path.join(napcatAppDir, 'napcat.mjs'), '');
      fs.writeFileSync(path.join(napcatAppDir, 'qqnt.json'), '');
      fs.writeFileSync(path.join(napcatAppDir, 'NapCatWinBootMain.exe'), '');
      fs.writeFileSync(path.join(napcatAppDir, 'NapCatWinBootHook.dll'), '');

      const layout = resolveNapcatWindowsOneKeyShellLayout(packageDir);

      expect(layout?.bootMainPath).toBe(path.join(packageDir, 'NapCatWinBootMain.exe'));
      expect(layout?.qqPath).toBe(path.join(packageDir, 'QQ.exe'));
      expect(layout?.napcatAppDir).toBe(napcatAppDir);
      expect(layout?.napcatMainPath).toBe(path.join(napcatAppDir, 'napcat.mjs'));
    } finally {
      fs.rmSync(packageDir, { recursive: true, force: true });
    }
  });

  it('enables management capability only when WebUI is ready', () => {
    const onebot = toOneBotNode(onebotSnapshot({
      state: 'ready',
      connected: true,
      ready: true,
    }), now);
    const webui = toWebUiNode(webuiSnapshot('ready', 'NapCat WebUI 已响应。'), now);

    const capabilities = toManagedCapabilityNodes(onebot, webui, true, now);
    expect(capabilities.find((item) => item.id === 'qq-ingress')?.state).toBe('available');
    expect(capabilities.find((item) => item.id === 'napcat-management')?.state).toBe('available');
  });

  it('keeps OneBot capability available when WebUI is degraded', () => {
    const onebot = toOneBotNode(onebotSnapshot({
      state: 'ready',
      connected: true,
      ready: true,
    }), now);
    const webui = toWebUiNode(webuiSnapshot(
      'unavailable',
      'NapCat WebUI 未就绪：NapCat 上游未启动、未注入或管理端口未监听。',
    ), now);

    const capabilities = toManagedCapabilityNodes(onebot, webui, true, now);
    expect(capabilities.find((item) => item.id === 'qq-ingress')?.state).toBe('available');
    expect(capabilities.find((item) => item.id === 'qq-reply')?.state).toBe('available');
    expect(capabilities.find((item) => item.id === 'napcat-management')?.state).toBe('degraded');
  });

  it('keeps external_onebot profile free of NapCat WebUI management capability', () => {
    const onebot = toOneBotNode(onebotSnapshot({
      state: 'ready',
      connected: true,
      ready: true,
      endpoint: 'ws://0.0.0.0:5701/onebot',
    }), now);
    const upstream = toExternalOneBotSourceNode('ws://0.0.0.0:5701/onebot', onebot, now);
    const capabilities = toCoreCapabilityNodes(onebot, true, now);

    expect(upstream.id).toBe('external-onebot-source');
    expect(capabilities.find((item) => item.id === 'napcat-management')).toBeUndefined();
    expect(summarizeExternalProfileState(upstream, onebot)).toContain('外部 OneBot 协议已就绪');
  });

  it('builds external runtime projection without managed NapCat nodes', () => {
    const projection = buildRuntimeProjection({
      profile: {
        mode: 'external_onebot',
        endpoint: 'ws://127.0.0.1:5701/',
      },
      onebot: onebotSnapshot({
        state: 'listening',
        connected: false,
        ready: false,
        endpoint: 'ws://127.0.0.1:5701/',
      }),
      replyEnabled: true,
      updatedAt: now,
    });

    expect(projection.nodes.map((item) => item.id)).toEqual([
      'external-onebot-source',
      'onebot-bridge',
      'qq-ingress',
      'qq-reply',
    ]);
    expect(projection.diagnostics.summary).toContain('等待外部 OneBot');
  });

  it('summarizes managed profile degradation from process and WebUI state', () => {
    const process = toProcessNode(processSnapshot({
      state: 'degraded',
      lastError: 'NapCat 启动超时：bootstrap 或进程启动已完成，但 WebUI/OneBot 未在期限内 ready。',
      recoveryActions: ['确认 NapCat WebUI 与扩展分配的 OneBot 回环端点未被防火墙或其他进程阻断。'],
    }), now);
    const onebot = toOneBotNode(onebotSnapshot({
      state: 'disconnected',
      connected: false,
      ready: false,
    }), now);
    const webui = toWebUiNode(webuiSnapshot(
      'unavailable',
      'NapCat WebUI 未就绪：NapCat 上游未启动、未注入或管理端口未监听。',
    ), now);

    expect(summarizeManagedProfileState(process, onebot, webui)).toContain('启动超时');
  });
});

function contributionIds(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .map((item) => item && typeof item === 'object' ? String((item as { id?: unknown }).id ?? '') : '')
    .filter(Boolean);
}
