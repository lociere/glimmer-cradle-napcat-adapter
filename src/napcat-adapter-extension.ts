import { BaseExtension } from '@glimmer-cradle/extension-sdk';
import type { ChannelReplyPayload } from '@glimmer-cradle/extension-sdk/contracts';
import net from 'node:net';
import {
  NapcatAdapterConfig,
  NapcatAdapterConfigSchema,
  NapcatAdapterProfileModeSchema,
  type NapcatAdapterProfileMode,
} from '../config/schema';
import { resolveAccessToken } from './connection/access-token';
import { OneBotBridgeSession } from './connection/onebot-bridge-session';
import { InboundPipeline } from './inbound/inbound-pipeline';
import { ReplyRouter } from './outbound/reply-router';
import { SenderProfileResolver } from './onebot/profile-resolver';
import { ManagedNapcatWindowsProfile } from './profiles/managed-napcat-windows-profile';
import { ExternalOneBotProfile } from './profiles/external-onebot-profile';
import type { AdapterProfileRuntime, RuntimeProjectionInput } from './profiles/types';
import { ActiveAttentionStore } from './scene/active-attention-store';
import { buildRuntimeProjection, buildStoppedNodes } from './runtime/runtime-projection';
import { registerNapcatSourceContextSkill } from './skills/source-context-skill';

export class NapcatAdapterExtension extends BaseExtension<NapcatAdapterConfig> {
  private profileRuntime: AdapterProfileRuntime | null = null;
  private session: OneBotBridgeSession | null = null;
  private replyRouter: ReplyRouter | null = null;
  private activeAttention: ActiveAttentionStore | null = null;
  private profileMode: NapcatAdapterProfileMode = 'external_onebot';

  constructor() {
    super(NapcatAdapterConfigSchema);
  }

  protected override async activate(): Promise<void> {
    this.profileMode = NapcatAdapterProfileModeSchema.parse(this.ctx.activationProfile);
    const activeAttention = new ActiveAttentionStore(this.ctx.ports.sceneAttention);
    const accessToken = await resolveAccessToken(
      this.config.transport,
      (key) => this.ctx.ports.secrets.get(key),
    );
    const oneBotPort = this.config.transport.port > 0
      ? this.config.transport.port
      : await selectLoopbackPort(this.config.transport.host);
    const endpoint = {
      host: this.config.transport.host,
      port: oneBotPort,
      path: this.config.transport.path,
      accessToken,
    };

    const profileRuntime = this.createProfileRuntime(endpoint);
    let inbound: InboundPipeline | null = null;
    let reportRuntimeProjection = async (): Promise<void> => {};

    const session = new OneBotBridgeSession(this.logger, {
      host: endpoint.host,
      port: endpoint.port,
      path: endpoint.path,
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
        profileRuntime.onOneBotReady(loginInfo);
        void reportRuntimeProjection().catch((error) => this.logger.warn('[napcat] runtime projection report failed', {
          error: error instanceof Error ? error.message : String(error),
        }));
      },
    });

    reportRuntimeProjection = async (): Promise<void> => {
      const projection = await this.buildRuntimeProjection(profileRuntime, session);
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
    this.profileRuntime = profileRuntime;
    this.session = session;
    this.replyRouter = replyRouter;
    this.addDisposable({ dispose: () => profileRuntime.dispose() });
    this.addDisposable({ dispose: () => session.dispose() });
    this.addDisposable(registerNapcatSourceContextSkill(this.ctx, this.profileMode));
    this.registerInterval(() => replyRouter.gc(), 60_000);
    this.registerInterval(() => reportRuntimeProjection(), 5_000);
    this.registerSharedCommands(profileRuntime);

    this.subscribe('action.channel.reply', (payload) =>
      replyRouter.sendReply(payload as ChannelReplyPayload),
    );

    this.ctx.ports.sceneAttention.registerSourcePolicies(
      this.config.ingress.source_focus_policies,
    );

    profileRuntime.start();
    session.start();
    await reportRuntimeProjection();
    this.logger.info('[napcat] adapter started', {
      endpoint: `ws://${endpoint.host}:${endpoint.port}${endpoint.path}`,
      profile_mode: this.profileMode,
    });
  }

  protected override async deactivate(): Promise<void> {
    this.replyRouter?.clear();
    this.activeAttention?.clearFocus();
    await this.session?.dispose();
    await this.profileRuntime?.dispose();
    await this.ctx.ports.runtime.reportCapabilityGraph({
      nodes: buildStoppedNodes(this.ctx.extensionId, this.profileMode),
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
    this.profileRuntime = null;
    this.logger.info('[napcat] adapter stopped', {
      profile_mode: this.profileMode,
    });
  }

  private registerSharedCommands(profileRuntime: AdapterProfileRuntime): void {
    this.registerCommand(
      'lociere.napcat-adapter.getStatus',
      async () => {
        if (!this.profileRuntime || !this.session) {
          throw new Error('NapCat Adapter 尚未启动');
        }
        return this.buildRuntimeProjection(this.profileRuntime, this.session);
      },
      { title: 'Get NapCat status', category: 'NapCat' },
    );
    profileRuntime.registerManagementCommands((commandId, handler, metadata) => {
      this.registerCommand(commandId, handler, metadata);
    });
  }

  private createProfileRuntime(
    endpoint: {
      host: string;
      port: number;
      path: string;
      accessToken: string;
    },
  ): AdapterProfileRuntime {
    if (this.profileMode === 'managed_napcat_windows') {
      return new ManagedNapcatWindowsProfile(this.logger, {
        config: this.config.managed_napcat_windows,
        endpoint,
      });
    }
    return new ExternalOneBotProfile(endpoint);
  }

  private async buildRuntimeProjection(
    profileRuntime: AdapterProfileRuntime,
    session: OneBotBridgeSession,
  ): Promise<ReturnType<typeof buildRuntimeProjection>> {
    const updatedAt = new Date().toISOString();
    const input: RuntimeProjectionInput = {
      profile: await profileRuntime.getSnapshot(),
      onebot: session.getSnapshot(),
      replyEnabled: this.config.reply.enabled,
      updatedAt,
    };
    return buildRuntimeProjection(input);
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
