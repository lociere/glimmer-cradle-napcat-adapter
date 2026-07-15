import type { NapcatAdapterConfig } from '../../config/schema';

/**
 * token_from_secrets=true 时只接受环境变量或 secrets 注入后的环境值。
 * 普通配置中的 access_token 仅用于本机临时开发，不应提交。
 */
export function resolveAccessToken(transport: NapcatAdapterConfig['transport']): string {
  const envKey = String(transport.access_token_env ?? '').trim();
  if (envKey) {
    const envToken = String(process.env[envKey] ?? '').trim();
    if (envToken) return envToken;
  }
  if (transport.token_from_secrets) return '';
  return String(transport.access_token ?? '').trim();
}
