import type { Disposable, ExtensionContext } from '@glimmer-cradle/extension-sdk';
import type { NapcatAdapterConfig, NapcatAdapterProfileMode } from '../../config/schema';

export function registerNapcatSourceContextSkill(
  ctx: ExtensionContext<NapcatAdapterConfig>,
  profileMode: NapcatAdapterProfileMode,
): Disposable {
  return ctx.ports.agents.registerSubAgent({
    id: 'qq-source-context',
    name: 'QQ source context',
    description: '仅在 NapCat / OneBot 来源会话中可见的上下文能力说明。',
    audience: 'character',
    scope: { kind: 'source_provider', ids: [ctx.extensionId] },
    requirements: {
      products: ['desktop', 'personal-server'],
      platforms: ['windows-x64', 'linux-x64'],
      features: ['extensions'],
      profiles: [],
    },
    tools: [{
      name: 'lociere.napcat-adapter.describe_source_context',
      description: '返回当前 QQ / OneBot 来源下可用的回复与上下文约束。',
      audience: 'character',
      scope: { kind: 'source_provider', ids: [ctx.extensionId] },
      requirements: {
        products: ['desktop', 'personal-server'],
        platforms: ['windows-x64', 'linux-x64'],
        features: ['extensions'],
        profiles: [],
      },
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      handler: async () => ({
        source_provider_id: ctx.extensionId,
        profile_mode: profileMode,
        private_ingress_enabled: ctx.config.ingress.private_enabled,
        group_ingress_enabled: ctx.config.ingress.group_enabled,
        reply_enabled: ctx.config.reply.enabled,
        mention_sender_in_group: ctx.config.reply.mention_sender_in_group,
        quote_source_message: ctx.config.reply.quote_source_message,
        multimodal_enabled: ctx.config.ingress.multimodal.enabled,
        management_surface_kind: profileMode === 'managed_napcat_windows'
          ? 'user_management_available'
          : 'external_upstream_only',
        note: '此工具只描述当前 NapCat / OneBot 场景边界，不执行管理动作，也不会暴露平台私有 ID。',
      }),
    }],
  });
}
