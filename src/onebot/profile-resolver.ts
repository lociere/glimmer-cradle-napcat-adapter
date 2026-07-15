/**
 * Sender Profile Resolver —— profile-resolver.ts
 *
 * 解析消息发送者的显示昵称。
 * 使用 TTL 缓存减少冗余 API 调用。
 * 无法解析时回退到"用户-{shortId}"格式（不直接暴露 QQ 号）。
 */

import type { ExtensionLogger } from '@glimmer-cradle/extension-sdk';
import type { OB11MessageEvent } from './ob11-types';
import type { ParsedMessage } from './message-parser';

type CallActionFn = (action: string, params: Record<string, unknown>) => Promise<unknown>;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export class SenderProfileResolver {
  private readonly _logger: ExtensionLogger;
  private readonly _callAction: CallActionFn;
  private readonly _cacheTtlMs: number;
  private readonly _cache = new Map<string, CacheEntry>();

  constructor(logger: ExtensionLogger, callAction: CallActionFn, cacheTtlMs: number) {
    this._logger = logger;
    this._callAction = callAction;
    this._cacheTtlMs = Number(cacheTtlMs) || 300_000;
  }

  async resolve(event: OB11MessageEvent, parsed: ParsedMessage): Promise<string> {
    const cacheKey = `${parsed.sourceType}:${parsed.sourceId}:${parsed.senderId}`;
    const now = Date.now();
    const cached = this._cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;

    const sender = event.sender ?? {};
    // card 可能为空字符串（群员未设置群昵称），此时应回退到 nickname
    // 使用 || 而非 ??：空字符串视为无效值
    const card = String(sender.card ?? '').trim();
    const fallbackNick = String(sender.nickname ?? '').trim();
    let nickname = card || fallbackNick;

    if (!nickname) {
      nickname = await this._fetchNickname(parsed);
    }

    if (!nickname) {
      // 取 senderId 末 4 位作为匿名短码，避免将平台私有 ID（QQ 号）写入 Cognition 记忆
      const shortId = String(parsed.senderId || '').slice(-4) || '0000';
      nickname = `用户-${shortId}`;
    }

    this._cache.set(cacheKey, { value: nickname, expiresAt: now + this._cacheTtlMs });
    return nickname;
  }

  private async _fetchNickname(parsed: ParsedMessage): Promise<string> {
    try {
      if (parsed.sourceType === 'group') {
        const res = await this._callAction('get_group_member_info', {
          group_id: parsed.sourceId,
          user_id: parsed.senderId,
          no_cache: false,
        }) as Record<string, unknown> | null;
        // NapCat 返回 data 字段含 card/nickname，card 可能为空字符串
        const resCard = String(res?.['card'] ?? '').trim();
        const resNick = String(res?.['nickname'] ?? '').trim();
        return resCard || resNick;
      }

      const res = await this._callAction('get_stranger_info', {
        user_id: parsed.senderId,
        no_cache: false,
      }) as Record<string, unknown> | null;
      return String(res?.['nickname'] ?? '').trim();
    } catch (err) {
      this._logger.warn('获取发送者昵称失败，使用回退值', {
        source_type: parsed.sourceType,
        source_id: parsed.sourceId,
        sender_id: parsed.senderId,
        error: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }
}
