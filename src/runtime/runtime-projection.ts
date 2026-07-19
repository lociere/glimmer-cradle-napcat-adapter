import {
  type CapabilityGraphNode,
  type CapabilityNodeState,
  type DiagnosticsSnapshot,
  type ReadinessGateSnapshot,
} from '@glimmer-cradle/extension-sdk/contracts';
import { BuiltInContributionPoint } from '@glimmer-cradle/extension-sdk';
import type { OneBotBridgeSessionSnapshot } from '../connection/onebot-bridge-session';
import type { AdapterProfileMode, RuntimeProjectionInput } from '../profiles/types';
import type { NapcatProcessSnapshot } from '../process/napcat-process-controller';
import type { NapcatWebUiSnapshot } from '../napcat/napcat-webui-client';

export function buildRuntimeProjection(
  input: RuntimeProjectionInput,
): {
  nodes: CapabilityGraphNode[];
  diagnostics: DiagnosticsSnapshot;
} {
  const onebotNode = toOneBotNode(input.onebot, input.updatedAt);
  if (input.profile.mode === 'external_onebot') {
    const upstreamNode = toExternalOneBotSourceNode(input.profile.endpoint, onebotNode, input.updatedAt);
    const capabilityNodes = toCoreCapabilityNodes(onebotNode, input.replyEnabled, input.updatedAt);
    return {
      nodes: [upstreamNode, onebotNode, ...capabilityNodes],
      diagnostics: {
        summary: summarizeExternalProfileState(upstreamNode, onebotNode),
        last_error: input.onebot.lastError,
        entries: [],
        log_locations: [],
        recovery_actions: recoveryActions(upstreamNode, onebotNode),
      },
    };
  }

  const processNode = toProcessNode(input.profile.process, input.updatedAt);
  const webuiNode = toWebUiNode(input.profile.webui, input.updatedAt);
  const capabilityNodes = toManagedCapabilityNodes(onebotNode, webuiNode, input.replyEnabled, input.updatedAt);
  return {
    nodes: [processNode, onebotNode, webuiNode, ...capabilityNodes],
    diagnostics: {
      summary: summarizeManagedProfileState(processNode, onebotNode, webuiNode),
      last_error: input.profile.process.lastError
        || input.onebot.lastError
        || (input.profile.webui.health.state === 'unavailable' ? input.profile.webui.health.summary : undefined),
      entries: [],
      log_locations: [input.profile.process.workDir].filter(Boolean),
      recovery_actions: recoveryActions(processNode, onebotNode, webuiNode),
    },
  };
}

export function buildStoppedNodes(
  extensionId: string,
  profileMode: AdapterProfileMode,
): CapabilityGraphNode[] {
  const now = new Date().toISOString();
  const base = {
    state: 'stopped' as const,
    owner: 'extension' as const,
    owner_id: extensionId,
    updated_at: now,
    readiness_gates: [] as ReadinessGateSnapshot[],
    diagnostic_refs: [] as string[],
    permissions: [] as string[],
    metadata: {},
  };
  if (profileMode === 'external_onebot') {
    return [
      {
        ...base,
        id: 'external-onebot-source',
        contribution_point: BuiltInContributionPoint.managedResource,
        title: 'External OneBot source',
        kind: 'localService',
        audience: 'host',
        required: true,
        summary: '外部 OneBot 上游已停止或尚未连接。',
      },
      {
        ...base,
        id: 'onebot-bridge',
        contribution_point: BuiltInContributionPoint.protocolBridge,
        title: 'OneBot bridge',
        kind: 'protocolBridge',
        audience: 'adapter',
        required: true,
        summary: 'OneBot bridge 已停止。',
      },
    ];
  }

  return [
    {
      ...base,
      id: 'napcat-managed-process',
      contribution_point: BuiltInContributionPoint.managedResource,
      title: 'NapCat managed process',
      kind: 'managedProcess',
      audience: 'host',
      required: true,
      summary: `${extensionId} 已停止 NapCat 受管进程。`,
    },
    {
      ...base,
      id: 'onebot-bridge',
      contribution_point: BuiltInContributionPoint.protocolBridge,
      title: 'OneBot bridge',
      kind: 'protocolBridge',
      audience: 'adapter',
      required: true,
      summary: 'OneBot bridge 已停止。',
    },
    {
      ...base,
      id: 'webui-management',
      contribution_point: BuiltInContributionPoint.managedResource,
      title: 'NapCat WebUI management',
      kind: 'managementEndpoint',
      audience: 'user',
      required: false,
      summary: 'WebUI management 已停止。',
    },
  ];
}

export function toProcessNode(
  process: NapcatProcessSnapshot,
  updatedAt: string,
): CapabilityGraphNode {
  const state: CapabilityNodeState =
    process.state === 'error' ? 'failed'
      : process.state === 'degraded' ? 'degraded'
      : process.state === 'starting' ? 'starting'
        : process.state === 'detached' ? 'starting'
          : process.state === 'running' ? process.ready ? 'ready' : 'live'
            : process.state === 'disabled' || process.state === 'stopped' ? 'stopped'
              : 'declared';
  const summary = process.lastError
    || (process.state === 'detached'
      ? 'NapCat bootstrap 已结束，正在等待 WebUI 或 OneBot readiness 证明注入成功。'
      : `NapCat process state: ${process.state}`);
  return {
    id: 'napcat-managed-process',
    contribution_point: BuiltInContributionPoint.managedResource,
    kind: 'managedProcess',
    title: 'NapCat managed process',
    state,
    owner: 'extension',
    owner_id: 'lociere.napcat-adapter',
    audience: 'host',
    required: true,
    summary,
    permissions: ['EXTERNAL_PROCESS'],
    readiness_gates: [],
    diagnostic_refs: [],
    metadata: {
      profile_mode: 'managed_napcat_windows',
      package_dir: process.packageDir,
      work_dir: process.workDir,
      pid: process.pid,
      started_at: process.startedAt,
      last_error: process.lastError,
      recovery_actions: process.recoveryActions.length > 0
        ? process.recoveryActions
        : state === 'failed'
          ? ['检查 NapCat 启动器、QQ 安装和工作目录。']
          : [],
    },
    updated_at: updatedAt,
  };
}

export function toExternalOneBotSourceNode(
  endpoint: string,
  onebot: CapabilityGraphNode,
  updatedAt: string,
): CapabilityGraphNode {
  const ready = onebot.state === 'ready';
  const live = onebot.state === 'live';
  return {
    id: 'external-onebot-source',
    contribution_point: BuiltInContributionPoint.managedResource,
    kind: 'localService',
    title: 'External OneBot source',
    state: ready ? 'ready' : live ? 'live' : 'declared',
    owner: 'extension',
    owner_id: 'lociere.napcat-adapter',
    audience: 'host',
    required: true,
    summary: ready
      ? '外部 OneBot 上游已连接并完成登录探活。'
      : live
        ? '已监听反向 WebSocket，等待外部 OneBot 登录探活完成。'
        : '等待用户自管的 OneBot/NapCat 上游反向连接。',
    permissions: [],
    readiness_gates: [],
    diagnostic_refs: [],
    metadata: {
      profile_mode: 'external_onebot',
      endpoint,
      recovery_actions: [
        '在外部 OneBot/NapCat 中把反向 WebSocket 指向当前扩展监听地址。',
        '确认 access token、端口与路径与扩展配置一致。',
      ],
    },
    updated_at: updatedAt,
  };
}

export function toOneBotNode(
  onebot: OneBotBridgeSessionSnapshot,
  updatedAt: string,
): CapabilityGraphNode {
  const state: CapabilityNodeState =
    onebot.state === 'ready' ? 'ready'
      : onebot.state === 'connected' || onebot.state === 'listening' ? 'live'
        : onebot.state === 'error' ? 'failed'
          : 'stopped';
  return {
    id: 'onebot-bridge',
    contribution_point: BuiltInContributionPoint.protocolBridge,
    kind: 'protocolBridge',
    title: 'OneBot bridge',
    state,
    owner: 'extension',
    owner_id: 'lociere.napcat-adapter',
    audience: 'adapter',
    required: true,
    summary: onebot.lastError || `OneBot bridge state: ${onebot.state}`,
    permissions: ['EXTERNAL_NETWORK'],
    readiness_gates: [{
      id: 'onebot-bridge:readiness',
      kind: 'readiness',
      state,
      summary: onebot.ready ? 'get_login_info 已确认。' : '等待 OneBot 反向连接并完成登录探活。',
      endpoint: onebot.endpoint,
      checked_at: updatedAt,
      error_message: onebot.lastError,
    }],
    diagnostic_refs: [],
    metadata: {
      endpoint: onebot.endpoint,
      last_error: onebot.lastError,
      recovery_actions: state === 'failed' ? ['检查 OneBot token、反向 WebSocket 地址和上游登录态。'] : [],
    },
    updated_at: updatedAt,
  };
}

export function toWebUiNode(
  webui: NapcatWebUiSnapshot,
  updatedAt: string,
): CapabilityGraphNode {
  const state: CapabilityNodeState = webui.health.state === 'ready' ? 'ready' : 'degraded';
  return {
    id: 'webui-management',
    contribution_point: BuiltInContributionPoint.managedResource,
    kind: 'managementEndpoint',
    title: 'NapCat WebUI management',
    state,
    owner: 'extension',
    owner_id: 'lociere.napcat-adapter',
    audience: 'user',
    required: false,
    summary: webui.health.summary,
    permissions: ['EXTERNAL_NETWORK'],
    readiness_gates: [{
      id: 'webui-management:management',
      kind: 'management',
      state,
      summary: webui.health.summary,
      endpoint: webui.endpoint,
      checked_at: webui.health.checkedAt,
    }],
    diagnostic_refs: [],
    metadata: {
      endpoint: webui.endpoint,
      last_error: webui.health.state === 'unavailable' ? webui.health.summary : undefined,
      recovery_actions: webui.health.state === 'unavailable'
        ? ['确认 NapCat 上游已启动并完成注入；WebUI 管理端口监听后再打开面板。']
        : [],
    },
    updated_at: updatedAt,
  };
}

export function toCoreCapabilityNodes(
  onebot: CapabilityGraphNode,
  replyEnabled: boolean,
  updatedAt: string,
): CapabilityGraphNode[] {
  const onebotReady = onebot.state === 'ready';
  return [
    {
      id: 'qq-ingress',
      contribution_point: BuiltInContributionPoint.capability,
      kind: 'capability',
      title: 'QQ 入站感知',
      state: onebotReady ? 'available' : 'unavailable',
      owner: 'extension',
      owner_id: 'lociere.napcat-adapter',
      audience: 'adapter',
      required: true,
      summary: onebotReady ? 'OneBot 已就绪，可接收入站消息。' : 'OneBot 尚未就绪。',
      permissions: ['PERCEPTION_WRITE'],
      readiness_gates: [],
      diagnostic_refs: [],
      metadata: {
        resource_ids: ['onebot-bridge'],
        disabled_reason: onebotReady ? undefined : 'OneBot bridge 未 ready。',
      },
      updated_at: updatedAt,
    },
    {
      id: 'qq-reply',
      contribution_point: BuiltInContributionPoint.capability,
      kind: 'capability',
      title: 'QQ 受控回复',
      state: onebotReady && replyEnabled ? 'available' : 'disabled',
      owner: 'extension',
      owner_id: 'lociere.napcat-adapter',
      audience: 'adapter',
      required: false,
      summary: onebotReady && replyEnabled ? 'QQ 回复已可用。' : 'QQ 回复不可用。',
      permissions: ['CHAT_SEND'],
      readiness_gates: [],
      diagnostic_refs: [],
      metadata: {
        resource_ids: ['onebot-bridge'],
        disabled_reason: onebotReady ? 'reply.enabled 已关闭。' : 'OneBot bridge 未 ready。',
      },
      updated_at: updatedAt,
    },
  ];
}

export function toManagedCapabilityNodes(
  onebot: CapabilityGraphNode,
  webui: CapabilityGraphNode,
  replyEnabled: boolean,
  updatedAt: string,
): CapabilityGraphNode[] {
  const nodes = toCoreCapabilityNodes(onebot, replyEnabled, updatedAt);
  const webuiReady = webui.state === 'ready';
  nodes.push({
    id: 'napcat-management',
    contribution_point: BuiltInContributionPoint.capability,
    kind: 'capability',
    title: 'NapCat 管理面板',
    state: webuiReady ? 'available' : 'degraded',
    owner: 'extension',
    owner_id: 'lociere.napcat-adapter',
    audience: 'user',
    required: false,
    summary: webuiReady ? 'WebUI 管理面板已可用。' : 'WebUI 管理面板不可用，不代表 OneBot 核心能力不可用。',
    permissions: ['EXTERNAL_NETWORK'],
    readiness_gates: [],
    diagnostic_refs: [],
    metadata: {
      resource_ids: ['webui-management'],
      disabled_reason: webuiReady ? undefined : 'WebUI endpoint 未 ready。',
    },
    updated_at: updatedAt,
  });
  return nodes;
}

export function summarizeManagedProfileState(
  process: CapabilityGraphNode,
  onebot: CapabilityGraphNode,
  webui: CapabilityGraphNode,
): string {
  if (onebot.state === 'ready' && webui.state === 'ready') return 'NapCat 协议与管理面板均已就绪。';
  if (onebot.state === 'ready') return 'OneBot 协议已就绪，WebUI 管理面板降级。';
  if (process.state === 'live' || onebot.state === 'live') return 'Adapter 已启动，正在等待 NapCat 登录和 OneBot readiness。';
  if (process.state === 'starting') return 'NapCat bootstrap 已发出，正在等待 WebUI 或 OneBot readiness 证明上游启动/注入成功。';
  if (process.state === 'failed' || onebot.state === 'failed') return 'NapCat Adapter 运行链路出现错误。';
  if (process.state === 'degraded') return process.summary;
  if (webui.state === 'degraded') return 'NapCat 上游未启动、未注入或 WebUI 管理端口未监听。';
  return 'NapCat Adapter 等待上游进程和协议连接。';
}

export function summarizeExternalProfileState(
  upstream: CapabilityGraphNode,
  onebot: CapabilityGraphNode,
): string {
  if (onebot.state === 'ready') return '外部 OneBot 协议已就绪。';
  if (onebot.state === 'live') return '已监听反向 WebSocket，等待外部 OneBot 登录和 readiness。';
  if (onebot.state === 'failed') return onebot.summary;
  return upstream.summary;
}

function recoveryActions(...nodes: CapabilityGraphNode[]): string[] {
  return nodes.flatMap((node) => nodeRecoveryActions(node));
}

function nodeRecoveryActions(node: CapabilityGraphNode): string[] {
  const actions = node.metadata.recovery_actions;
  return Array.isArray(actions)
    ? actions.filter((item): item is string => typeof item === 'string')
    : [];
}
