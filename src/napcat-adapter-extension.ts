import { BaseExtension, BuiltInContributionPoint } from '@glimmer-cradle/extension-sdk';
import net from 'node:net';
import type {
  CapabilityGraphNode,
  CapabilityNodeState,
  ChannelReplyPayload,
  DiagnosticsSnapshot,
  ReadinessGateSnapshot,
} from '@glimmer-cradle/extension-sdk/contracts';
import { NapcatAdapterConfig, NapcatAdapterConfigSchema } from '../config/schema';
import { SenderProfileResolver } from './onebot/profile-resolver';
import { resolveAccessToken } from './connection/access-token';
import { OneBotBridgeSession } from './connection/onebot-bridge-session';
import { InboundPipeline } from './inbound/inbound-pipeline';
import { ReplyRouter } from './outbound/reply-router';
import { NapcatProcessController } from './process/napcat-process-controller';
import { ActiveAttentionStore } from './scene/active-attention-store';
import { NapcatWebUiClient } from './napcat/napcat-webui-client';

export class NapcatAdapterExtension extends BaseExtension<NapcatAdapterConfig> {
  private processController: NapcatProcessController | null = null;
  private session: OneBotBridgeSession | null = null;
  private replyRouter: ReplyRouter | null = null;
  private activeAttention: ActiveAttentionStore | null = null;

  constructor() {
    super(NapcatAdapterConfigSchema);
  }

  protected override async activate(): Promise<void> {
    const activeAttention = new ActiveAttentionStore(this.ctx.ports.sceneAttention);
    const accessToken = resolveAccessToken(this.config.transport);
    const oneBotPort = this.config.transport.port > 0
      ? this.config.transport.port
      : await selectLoopbackPort(this.config.transport.host);
    const processController = new NapcatProcessController(
      this.logger,
      this.config.external_dependency,
      {
        host: this.config.transport.host,
        port: oneBotPort,
        path: this.config.transport.path,
        accessToken,
      },
    );
    const webUiClient = new NapcatWebUiClient(this.logger, processController.getWorkDir());
    let inbound: InboundPipeline | null = null;
    let reportRuntimeProjection = async (): Promise<void> => {};

    const session = new OneBotBridgeSession(this.logger, {
      host: this.config.transport.host,
      port: oneBotPort,
      path: this.config.transport.path,
      accessToken,
      actionTimeoutMs: this.config.onebot.action_timeout_ms,
      readinessProbeEnabled: this.config.onebot.readiness_probe_enabled,
      onMessageEvent: (event) => inbound?.process(event),
      onDisconnected: () => {
        activeAttention.clearFocus();
        void reportRuntimeProjection().catch((error) => this.logger.warn('[napcat] runtime projection report failed', {
          error: error instanceof Error ? error.message : String(error),
        }));
      },
      onReady: (loginInfo) => {
        processController.markLoginReady(loginInfo);
        void reportRuntimeProjection().catch((error) => this.logger.warn('[napcat] runtime projection report failed', {
          error: error instanceof Error ? error.message : String(error),
        }));
      },
    });
    reportRuntimeProjection = async (): Promise<void> => {
      const projection = await this.buildRuntimeProjection(processController, session, webUiClient);
      await this.ctx.ports.runtime.reportCapabilityGraph({
        nodes: projection.nodes,
        diagnostics: projection.diagnostics,
      });
    };

    const profileResolver = new SenderProfileResolver(
      this.logger,
      session.callAction,
      this.config.profile_cache.nickname_cache_ttl_ms,
    );
    const replyRouter = new ReplyRouter(
      this.config,
      this.logger,
      session.callAction,
      activeAttention,
    );
    inbound = new InboundPipeline(
      this.config,
      this.logger,
      this.ctx.ports.perception,
      this.ctx.ports.sceneAttention,
      activeAttention,
      replyRouter,
      profileResolver,
      session.callAction,
    );

    this.activeAttention = activeAttention;
    this.processController = processController;
    this.session = session;
    this.replyRouter = replyRouter;
    this.addDisposable({ dispose: () => processController.dispose() });
    this.addDisposable({ dispose: () => session.dispose() });
    this.registerInterval(() => replyRouter.gc(), 60_000);
    this.registerInterval(() => reportRuntimeProjection(), 5_000);
    this.registerManagementCommands(webUiClient);

    this.subscribe('action.channel.reply', (payload) =>
      replyRouter.sendReply(payload as ChannelReplyPayload),
    );

    this.ctx.ports.sceneAttention.registerSourcePolicies(
      this.config.ingress.source_focus_policies,
    );

    processController.start();
    session.start();
    await reportRuntimeProjection();
    this.logger.info('[napcat] adapter started', {
      endpoint: `ws://${this.config.transport.host}:${oneBotPort}${this.config.transport.path}`,
    });
  }

  protected override async deactivate(): Promise<void> {
    this.replyRouter?.clear();
    this.activeAttention?.clearFocus();
    await this.session?.dispose();
    await this.processController?.dispose();
    await this.ctx.ports.runtime.reportCapabilityGraph({
      nodes: buildStoppedNodes(this.ctx.extensionId),
      diagnostics: {
        summary: 'NapCat Adapter 已停止。',
        entries: [],
        log_locations: [],
        recovery_actions: [],
      },
    });
    await this.ctx.ports.runtime.reportDiagnostics({
      summary: 'NapCat Adapter 已停止。',
      entries: [],
      log_locations: [],
      recovery_actions: [],
    });
    this.replyRouter = null;
    this.activeAttention = null;
    this.session = null;
    this.processController = null;
    this.logger.info('[napcat] adapter stopped');
  }

  private registerManagementCommands(
    webUiClient: NapcatWebUiClient,
  ): void {
    this.registerCommand(
      'lociere.napcat-adapter.getStatus',
      async () => {
        if (!this.processController || !this.session) {
          throw new Error('NapCat Adapter 尚未启动');
        }
        return this.buildRuntimeProjection(this.processController, this.session, webUiClient);
      },
      { title: 'Get NapCat status', category: 'NapCat' },
    );
    this.registerCommand(
      'lociere.napcat-adapter.refreshQrcode',
      () => webUiClient.refreshQrcode(),
      { title: 'Refresh NapCat login QR code', category: 'NapCat' },
    );
    this.registerCommand(
      'lociere.napcat-adapter.quickLogin',
      (uin) => webUiClient.quickLogin(String(uin ?? '').trim()),
      { title: 'Quick login NapCat account', category: 'NapCat' },
    );
    this.registerCommand(
      'lociere.napcat-adapter.setAutoLoginAccount',
      (uin) => webUiClient.setAutoLoginAccount(String(uin ?? '').trim()),
      { title: 'Set NapCat auto login account', category: 'NapCat' },
    );
    this.registerCommand(
      'lociere.napcat-adapter.openWebUi',
      () => webUiClient.openWebUi(),
      { title: 'Open NapCat WebUI', category: 'NapCat' },
    );
  }

  private async buildRuntimeProjection(
    processController: NapcatProcessController,
    session: OneBotBridgeSession,
    webUiClient: NapcatWebUiClient,
  ): Promise<{
    nodes: CapabilityGraphNode[];
    diagnostics: DiagnosticsSnapshot;
  }> {
    const process = processController.getSnapshot();
    const onebot = session.getSnapshot();
    const webui = await webUiClient.getSnapshot();
    const now = new Date().toISOString();
    const processNode = toProcessNode(process, now);
    const onebotNode = toOneBotNode(onebot, now);
    const webuiNode = toWebUiNode(webui, now);
    const capabilityNodes = toCapabilityNodes(onebotNode, webuiNode, this.config.reply.enabled, now);
    return {
      nodes: [processNode, onebotNode, webuiNode, ...capabilityNodes],
      diagnostics: {
        summary: summarizeAdapterState(processNode, onebotNode, webuiNode),
        last_error: process.lastError || onebot.lastError || (webui.health.state === 'unavailable' ? webui.health.summary : undefined),
        entries: [],
        log_locations: [process.workDir].filter(Boolean),
        recovery_actions: recoveryActions(processNode, onebotNode, webuiNode),
      },
    };
  }
}

async function selectLoopbackPort(host: string): Promise<number> {
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('NapCat 自动端口只允许用于回环地址；远程端点必须显式配置端口');
  }
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export function toProcessNode(
  process: ReturnType<NapcatProcessController['getSnapshot']>,
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
    id: 'napcat',
    contribution_point: BuiltInContributionPoint.managedResource,
    kind: 'managedProcess',
    title: 'NapCat package/process',
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

export function toOneBotNode(
  onebot: ReturnType<OneBotBridgeSession['getSnapshot']>,
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
      summary: onebot.ready ? 'get_login_info 已确认。' : '等待 NapCat 反向连接并完成登录探活。',
      endpoint: onebot.endpoint,
      checked_at: updatedAt,
      error_message: onebot.lastError,
    }],
    diagnostic_refs: [],
    metadata: {
      endpoint: onebot.endpoint,
      last_error: onebot.lastError,
      recovery_actions: state === 'failed' ? ['检查 OneBot token、反向 WebSocket 地址和 NapCat 登录态。'] : [],
    },
    updated_at: updatedAt,
  };
}

export function toWebUiNode(
  webui: Awaited<ReturnType<NapcatWebUiClient['getSnapshot']>>,
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

export function toCapabilityNodes(
  onebot: CapabilityGraphNode,
  webui: CapabilityGraphNode,
  replyEnabled: boolean,
  updatedAt: string,
): CapabilityGraphNode[] {
  const onebotReady = onebot.state === 'ready';
  const webuiReady = webui.state === 'ready';
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
    {
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
    },
  ];
}

export function summarizeAdapterState(
  process: CapabilityGraphNode,
  onebot: CapabilityGraphNode,
  webui: CapabilityGraphNode,
): string {
  if (onebot.state === 'ready' && webui.state === 'ready') return 'NapCat 协议与管理面板均已就绪。';
  if (onebot.state === 'ready') return 'OneBot 协议已就绪，WebUI 管理面板降级。';
  if (process.state === 'live' || onebot.state === 'live') return 'Adapter 已启动，正在等待 NapCat 登录和 OneBot readiness。';
  if (process.state === 'starting') return 'NapCat bootstrap 已发出，正在等待 WebUI 或 OneBot readiness 证明上游启动/注入成功。';
  if (webui.state === 'degraded') return 'NapCat 上游未启动、未注入或 WebUI 管理端口未监听。';
  if (process.state === 'failed' || onebot.state === 'failed') return 'NapCat Adapter 运行链路出现错误。';
  if (process.state === 'degraded') return process.summary;
  return 'NapCat Adapter 等待上游进程和协议连接。';
}

function recoveryActions(
  process: CapabilityGraphNode,
  onebot: CapabilityGraphNode,
  webui: CapabilityGraphNode,
): string[] {
  return [
    ...nodeRecoveryActions(process),
    ...nodeRecoveryActions(onebot),
    ...nodeRecoveryActions(webui),
  ];
}

function buildStoppedNodes(extensionId: string): CapabilityGraphNode[] {
  const now = new Date().toISOString();
  const base = {
    state: 'stopped' as const,
    owner: 'extension' as const,
    owner_id: extensionId,
    audience: 'host' as const,
    updated_at: now,
    readiness_gates: [] as ReadinessGateSnapshot[],
    diagnostic_refs: [] as string[],
    permissions: [] as string[],
    metadata: {},
  };
  return [
    {
      ...base,
      id: 'napcat',
      contribution_point: BuiltInContributionPoint.managedResource,
      title: 'NapCat package/process',
      kind: 'managedProcess',
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

function nodeRecoveryActions(node: CapabilityGraphNode): string[] {
  const actions = node.metadata.recovery_actions;
  return Array.isArray(actions)
    ? actions.filter((item): item is string => typeof item === 'string')
    : [];
}
