/**
 * ReplyRouter —— 出站消息路由器
 *
 * 职责：
 *   - 维护 target_channel → 回复目标 的映射表（含 TTL 过期）
 *   - 按 Kernel 下发的 target_channel 转换为 OB11 动作帧并发送
 *
 * 生命周期：
 *   - register()  在 InboundPipeline 注入 PerceptionEvent 前调用，登记频道上下文
 *   - sendReply() 监听 action.channel.reply 事件后调用
 *   - gc()        定期清理过期路由（由主扩展每 60 秒触发）
 *   - clear()     扩展停止时调用
 */

import type { ExtensionLogger } from '@glimmer-cradle/extension-sdk';
import type { ChannelReplyMessage, ChannelReplyPayload } from '@glimmer-cradle/extension-sdk/contracts';
import type { NapcatAdapterConfig } from '../../config/schema';
import { cleanOutboundReply } from '../perception/perception-builder';
import type { OneBotActionCaller } from '../connection/onebot-action-client';
import type { ActiveAttentionStore } from '../scene/active-attention-store';

// ── 内部类型 ──────────────────────────────────────────────────────────

interface ReplyTarget {
  target_type: 'group' | 'private';
  /** 群号或对方 QQ */
  target_id: string;
  /** 原始发送者 QQ（用于 @ 提及） */
  sender_id: string;
  /** 用于回复后续期的注意力窗口键；不一定等同于回复目标场景。 */
  attention_channel_id: string;
  /** 过期时间戳（毫秒） */
  expiresAt: number;
}

type OB11Segment = { type: string; data: Record<string, unknown> };

const REPLY_TARGET_TTL_MS = 5 * 60 * 1_000; // 5 分钟

// ── 路由器 ────────────────────────────────────────────────────────────

export class ReplyRouter {
  private readonly _targetsByChannel = new Map<string, ReplyTarget>();
  private readonly _targetsByTrace = new Map<string, ReplyTarget>();

  constructor(
    private readonly config: NapcatAdapterConfig,
    private readonly logger: ExtensionLogger,
    private readonly callAction: OneBotActionCaller,
    /**
     * 回复发送成功后用于续期焦点计时器。
     * 确保用户在收到回复后仍有完整的焦点窗口继续对话。
     */
    private readonly activeAttention: ActiveAttentionStore,
  ) {}

  /**
   * 登记一条入站事件的回复路由。
   * 应在 ctx.ports.perception.inject() 之前调用，确保 Cognition 回复时路由仍存活。
   */
  register(
    eventId: string,
    target: Omit<ReplyTarget, 'expiresAt'>,
  ): void {
    const routing = {
      ...target,
      expiresAt: Date.now() + REPLY_TARGET_TTL_MS,
    };
    this._targetsByChannel.set(this.toChannelId(routing), routing);
    this._targetsByTrace.set(eventId, routing);
  }

  /**
   * 处理 Cognition 回复事件，发送 OB11 动作帧并写入出站记忆。
   */
  async sendReply(payload: ChannelReplyPayload): Promise<void> {
    if (!this.config.reply.enabled) return;

    if (!payload.target_channel?.startsWith('napcat')) {
      this.logger.debug(
        `[napcat] ignore reply for channel=${payload.target_channel ?? '(none)'}`,
      );
      return;
    }

    const routing = this.resolveReplyTarget(payload);
    if (!routing) {
      this.logger.warn('[napcat] reply route not found', {
        target_channel: payload.target_channel,
      });
      return;
    }

    const replyMessages: ChannelReplyMessage[] = payload.messages?.length
      ? payload.messages
      : [{ sequence: 0, content_type: 'text' as const, text: payload.text }];
    const cleanedMessages = replyMessages
      .map((message) => ({
        ...message,
        text: cleanOutboundReply(message.text),
      }))
      .filter((message) => message.text.length > 0)
      .sort((left, right) => left.sequence - right.sequence);
    if (cleanedMessages.length === 0) return;

    const mentionSender =
      this.config.reply.mention_sender_in_group &&
      routing.target_type === 'group' &&
      routing.sender_id.length > 0;

    let sentCount = 0;
    for (const [index, replyMessage] of cleanedMessages.entries()) {
      const message: OB11Segment[] = mentionSender && index === 0
        ? [
            { type: 'at', data: { qq: routing.sender_id } },
            { type: 'text', data: { text: ' ' + replyMessage.text } },
          ]
        : [{ type: 'text', data: { text: replyMessage.text } }];

      const actionRequest =
        routing.target_type === 'group'
          ? {
              action: 'send_group_msg',
              params: { group_id: parseInt(routing.target_id, 10), message },
            }
          : {
              action: 'send_private_msg',
              params: { user_id: parseInt(routing.target_id, 10), message },
            };

      try {
        await this.callAction(actionRequest.action, actionRequest.params);
        sentCount += 1;
      } catch (err) {
        this.logger.warn('[napcat] reply send action failed', {
          target_type: routing.target_type,
          target_id: routing.target_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (sentCount > 0) {
      this.logger.info(
        `[napcat] reply sent -> ${routing.target_type}:${routing.target_id}, messages=${sentCount}`,
      );
    }

    const sceneId =
      routing.target_type === 'group'
        ? `napcat:group:${routing.target_id}`
        : `napcat:private:${routing.target_id}`;
    // 回复发出后续期焦点：给用户一个完整的新超时窗口继续对话，
    // 避免因 AI 思考耗时导致有效窗口大幅缩水。
    this.activeAttention.focus({
      sceneId,
      channelId: routing.attention_channel_id,
      strength: 'focused',
      reason: 'active_dialogue',
      durationMs: this.config.ingress.focus_duration_ms,
    });
  }

  /** 清理所有已过期的路由记录（定期调用）。 */
  gc(): void {
    const now = Date.now();
    for (const [key, val] of this._targetsByChannel) {
      if (val.expiresAt <= now) this._targetsByChannel.delete(key);
    }
    for (const [key, val] of this._targetsByTrace) {
      if (val.expiresAt <= now) this._targetsByTrace.delete(key);
    }
  }

  /** 清空全部路由（扩展停止时调用）。 */
  clear(): void {
    this._targetsByChannel.clear();
    this._targetsByTrace.clear();
  }

  private resolveReplyTarget(payload: ChannelReplyPayload): ReplyTarget | null {
    const targetChannel = payload.target_channel;
    if (typeof targetChannel !== 'string') return null;

    const traceId = payload.trace_id;
    if (typeof traceId === 'string' && traceId) {
      const byTrace = this._targetsByTrace.get(traceId);
      if (byTrace) return byTrace;
    }

    const byChannel = this._targetsByChannel.get(targetChannel);
    if (byChannel) return byChannel;

    const match = /^napcat:(group|private):(\d+)$/u.exec(targetChannel);
    if (!match) return null;

    return {
      target_type: match[1] as 'group' | 'private',
      target_id: match[2],
      sender_id: match[1] === 'private' ? match[2] : '',
      attention_channel_id: targetChannel,
      expiresAt: Date.now() + REPLY_TARGET_TTL_MS,
    };
  }

  private toChannelId(target: Pick<ReplyTarget, 'target_type' | 'target_id'>): string {
    return `napcat:${target.target_type}:${target.target_id}`;
  }
}
