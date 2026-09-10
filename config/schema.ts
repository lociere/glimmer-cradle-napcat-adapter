import { z } from 'zod';

export const NapcatAdapterProfileModeSchema = z
  .enum(['external_onebot', 'managed_napcat_windows']);

export const NapcatAdapterConfigSchema = z
  .object({
    transport: z
      .object({
        host: z.string().default('127.0.0.1'),
        port: z.coerce.number().int().nonnegative().max(65535).default(0),
        path: z.string().default('/'),
        access_token: z.string().default(''),
        access_token_secret: z.string().default('onebot_access_token'),
        access_token_env: z.string().default('NAPCAT_ONEBOT_ACCESS_TOKEN'),
        token_from_secrets: z.boolean().default(true),
      })
      .default({}),

    managed_napcat_windows: z
      .object({
        package_dir: z.string().default('data/packages/managed-resources/lociere.napcat-adapter/napcat'),
        work_dir: z.string().default('data/state/extensions/lociere.napcat-adapter/napcat'),
        launch_mode: z.enum(['official_direct', 'official_shell', 'custom']).default('official_direct'),
        qq_path: z.string().default(''),
        command: z.string().default(''),
        args: z.array(z.string()).default([]),
        cwd: z.string().default(''),
        elevation_mode: z.enum(['admin', 'user']).default('user'),
        window_policy: z.enum(['webui_managed', 'always_visible']).default('webui_managed'),
        preferred_account: z.string().default(''),
        startup_timeout_ms: z.number().int().positive().default(60000),
        allow_preexisting_qq: z.boolean().default(false),
      })
      .default({}),
    main_user: z
      .object({
        qq: z.string().default(''),
      })
      .default({}),
    ingress: z
      .object({
        ignore_self: z.boolean().default(true),
        private_enabled: z.boolean().default(true),
        group_enabled: z.boolean().default(true),
        wake_words: z.array(z.string()).default([]),
        strip_self_mention: z.boolean().default(true),
        strip_leading_wake_words: z.boolean().default(true),
        blocked_user_ids: z.array(z.string()).default([]),
        blocked_group_ids: z.array(z.string()).default([]),
        familiarity: z
          .object({
            private: z.number().default(10),
            group: z.number().default(6),
          })
          .default({}),
        focus_duration_ms: z.number().int().positive().optional(),
        group_focus_scope: z.enum(['sender', 'group']).default('sender'),
        source_focus_policies: z
          .record(z.string(), z.string())
          .default({
            private: 'always_focused',
            group: 'wake_word_focus_with_timeout',
          }),
        multimodal: z
          .object({
            enabled: z.boolean().default(false),
          })
          .default({}),
      })
      .default({}),
    reply: z
      .object({
        enabled: z.boolean().default(true),
        mention_sender_in_group: z.boolean().default(false),
        quote_source_message: z.boolean().default(false),
        auto_escape: z.boolean().default(false),
      })
      .default({}),
    routing: z
      .object({
        session_partition: z
          .object({
            private: z.string().default('by_source'),
            group: z.string().default('by_source'),
          })
          .default({}),
      })
      .default({}),
    onebot: z
      .object({
        action_timeout_ms: z.number().int().positive().default(15000),
        readiness_probe_enabled: z.boolean().default(true),
      })
      .default({}),

    profile_cache: z
      .object({
        nickname_cache_ttl_ms: z.number().int().positive().default(300000),
      })
      .default({}),

    memory: z
      .object({
        enabled: z.boolean().default(false),
        group_context_size: z.number().int().min(1).max(50).default(20),
      })
      .default({}),
  })
  .passthrough();


export type NapcatAdapterConfig = z.infer<typeof NapcatAdapterConfigSchema>;
export type NapcatAdapterProfileMode = z.infer<typeof NapcatAdapterProfileModeSchema>;
export type ManagedNapcatWindowsConfig = NapcatAdapterConfig['managed_napcat_windows'];
