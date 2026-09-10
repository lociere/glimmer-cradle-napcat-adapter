import type { NapcatAdapterConfig } from '../../config/schema';

/**
 * token_from_secrets=true 时只接受 Host 注入的当前扩展 Secret 或本地开发环境变量。
 * 普通配置中的 access_token 仅用于本机临时开发，不应提交。
 */
export async function resolveAccessToken(
  transport: NapcatAdapterConfig['transport'],
  getSecret: (key: string) => Promise<string | undefined>,
): Promise<string> {
  const secretKey = String(transport.access_token_secret ?? '').trim();
  if (secretKey) {
    const secretToken = String(await getSecret(secretKey) ?? '').trim();
    if (secretToken) return secretToken;
  }
  const envKey = String(transport.access_token_env ?? '').trim();
  if (envKey) {
    const envToken = String(process.env[envKey] ?? '').trim();
    if (envToken) return envToken;
  }
  if (transport.token_from_secrets) return '';
  return String(transport.access_token ?? '').trim();
}
