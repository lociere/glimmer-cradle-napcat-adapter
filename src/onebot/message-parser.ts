/**
 * OB11 Message Parser —— message-parser.ts
 *
 * 把原始 OB11 消息段解析为结构化、有类型的 ParsedMessage 对象。
 * 这是 Adapter 层内部的归一化步骤。
 * 该模块输出由 perception-builder 消费，最终产出 PerceptionEvent。
 */

import type { NapcatAdapterConfig } from '../../config/schema';
import type { OB11MessageEvent, OB11MessageSegment } from './ob11-types';

export interface MediaItem {
  modality: 'image' | 'video';
  uri: string;
  mime_type: string;
  semantic?: {
    text: string;
    source?: string;
    resolved?: boolean;
    confidence?: number;
  };
  metadata: Record<string, unknown>;
}

export interface ReplyContext {
  senderId: string;
  senderNickname: string;
  previewText: string;
}

export interface MessageTraits {
  isAtMessage: boolean;
  isReplyMessage: boolean;
  isReplyToSelf: boolean;
  hasFace: boolean;
  hasSticker: boolean;
  hasImage: boolean;
  hasVideo: boolean;
  hasRecord: boolean;
}

export interface ParsedMessage {
  sourceType: 'group' | 'private';
  sourceId: string;
  senderId: string;
  displayText: string;
  text: string;
  recordSource: string;
  mediaItems: MediaItem[];
  replyMessageId: string;
  replyContext: ReplyContext;
  hasMention: boolean;
  messageTraits: MessageTraits;
}

function guessMimeType(type: 'image' | 'video', uri: string): string {
  const lower = String(uri).toLowerCase();
  if (type === 'image') {
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    return 'image/jpeg';
  }
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  return 'video/mp4';
}

/**
 * 提取 OB11 图片段 summary 字段中的语义标签。
 * summary 格式固定为 "[文字]"（如 "[早安]"），去掉方括号取纯文字。
 * 泛型占位词（图片/动图等）视为无语义，返回 null。
 */
const _GENERIC_SUMMARY_LABELS = new Set([
  '图片',
  '动图',
  '图',
  '动画',
  '表情',
  'gif',
  'GIF',
  'image',
  'photo',
]);

function decodeOb11Summary(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&')
    .trim();
}

function extractSummaryLabel(data: Record<string, unknown>): string | null {
  const summary = decodeOb11Summary(data['summary']);
  const match = /^\[(.+)\]$/.exec(summary);
  if (!match) return null;
  const label = match[1].trim();
  if (!label || _GENERIC_SUMMARY_LABELS.has(label)) return null;
  return label;
}

function classifySpecialImage(data: Record<string, unknown>): 'sticker' | 'image' {
  // sub_type=1: 自定义表情包；sub_type=7: QQ 输入推荐表情（输入栏弹出）
  const subType = Number(data['sub_type'] ?? data['subtype'] ?? -1);
  if (subType === 1 || subType === 7) return 'sticker';
  const hint = `${String(data['summary'] ?? '')} ${String(data['file'] ?? '')}`;
  if (/动画表情|标准表情|表情|sticker|mface|emoji/i.test(hint)) return 'sticker';
  return 'image';
}

function parseReplyContext(event: OB11MessageEvent, botSelfId: string, replyMessageId: string) {
  let parsedReplyMessageId = replyMessageId;
  let repliedSenderId = '';
  let repliedSenderNickname = '';
  let repliedPreviewText = '';

  if (event.reply && typeof event.reply === 'object') {
    const replyData = event.reply;
    const sender = replyData.sender ?? {};
    if (!parsedReplyMessageId) {
      parsedReplyMessageId = String(replyData.message_id ?? '');
    }
    repliedSenderId = String(replyData.user_id ?? sender.user_id ?? '');
    repliedSenderNickname = String(sender.card ?? sender.nickname ?? '').trim();

    if (Array.isArray(replyData.message)) {
      const previewParts: string[] = [];
      for (const seg of replyData.message as OB11MessageSegment[]) {
        if (!seg || typeof seg !== 'object') continue;
        if (seg.type === 'text') previewParts.push(String(seg.data['text'] ?? ''));
        else if (seg.type === 'at') previewParts.push(`@${String(seg.data['qq'] ?? '')}`);
      }
      repliedPreviewText = previewParts.join('').trim().slice(0, 80);
    } else if (typeof replyData.raw_message === 'string') {
      repliedPreviewText = replyData.raw_message.trim().slice(0, 80);
    }
  }

  const isReplyToSelf =
    !!repliedSenderId &&
    !!replyMessageId &&
    repliedSenderId === String(botSelfId);

  return { parsedReplyMessageId, repliedSenderId, repliedSenderNickname, repliedPreviewText, isReplyToSelf };
}

export function parseMessageSegments(
  event: OB11MessageEvent,
  botSelfId: string,
  config: NapcatAdapterConfig,
): ParsedMessage {
  const segments: OB11MessageSegment[] = Array.isArray(event.message) ? event.message : [];
  const textParts: string[] = [];
  const mediaItems: MediaItem[] = [];

  let hasMention = false;
  let hasReply = false;
  let hasFace = false;
  let hasSticker = false;
  let hasImage = false;
  let hasVideo = false;
  let hasRecord = false;
  let replyMessageId = '';
  let recordSource = '';

  const multimodalEnabled = config.ingress.multimodal?.enabled ?? false;

  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue;
    const { type, data } = segment;

    if (type === 'text') {
      // 跳过纯空白段（常见于 @mention 后自动追加的 " " 分隔符）
      const textVal = String(data['text'] ?? '');
      if (textVal.trim()) textParts.push(textVal);
      continue;
    }
    if (type === 'at') {
      const qq = String(data['qq'] ?? '');
      textParts.push(`@${qq}`);
      if (qq && qq === String(botSelfId)) hasMention = true;
      continue;
    }
    if (type === 'reply') {
      hasReply = true;
      replyMessageId = String(data['id'] ?? '');
      continue;
    }
    if (type === 'face') {
      hasFace = true;
      textParts.push('[QQ表情]');
      continue;
    }
    if (type === 'record') {
      recordSource = String(data['file'] ?? data['path'] ?? data['url'] ?? '');
      hasRecord = true;
      textParts.push('[语音消息]');
      continue;
    }
    if (type === 'image') {
      const uri = String(data['url'] ?? data['file'] ?? data['path'] ?? '');
      const imageKind = classifySpecialImage(data);
      const summaryLabel = extractSummaryLabel(data);
      if (imageKind === 'sticker') {
        hasSticker = true;
        // 如果有语义标签（如 "早安"），直接呈现给 AI；否则使用泛称
        textParts.push(summaryLabel ? `[${summaryLabel}]` : '[表情包]');
      } else {
        hasImage = true;
        textParts.push('[图片]');
      }
      if (uri && multimodalEnabled) {
        mediaItems.push({
          modality: 'image',
          uri,
          mime_type: guessMimeType('image', uri),
          semantic:
            (imageKind === 'sticker' && summaryLabel)
              ? {
                  text: summaryLabel,
                  source: 'platform_summary',
                  resolved: true,
                  confidence: 0.95,
                }
              : undefined,
          metadata: {
            file_size: data['file_size'],
            visual_kind: imageKind,
          },
        });
      }
      continue;
    }
    if (type === 'video') {
      const uri = String(data['url'] ?? data['file'] ?? data['path'] ?? '');
      hasVideo = true;
      textParts.push('[视频]');
      if (uri && multimodalEnabled) {
        mediaItems.push({
          modality: 'video',
          uri,
          mime_type: guessMimeType('video', uri),
          semantic: undefined,
          metadata: { file_size: data['file_size'] },
        });
      }
      continue;
    }
    // QQ 商城大表情 / 市场表情（mface）
    if (type === 'mface') {
      hasSticker = true;
      const mfaceLabel = extractSummaryLabel(data);
      textParts.push(mfaceLabel ? `[${mfaceLabel}]` : '[表情包]');
      const mfaceUrl = String(data['url'] ?? '');
      if (mfaceUrl && multimodalEnabled) {
        mediaItems.push({
          modality: 'image',
          uri: mfaceUrl,
          mime_type: 'image/gif',
          semantic: mfaceLabel
            ? {
                text: mfaceLabel,
                source: 'platform_summary',
                resolved: true,
                confidence: 0.95,
              }
            : undefined,
          metadata: {
            visual_kind: 'sticker',
          },
        });
      }
      continue;
    }
    // JSON / XML 卡片消息（小程序、分享链接等）
    if (type === 'json' || type === 'xml') {
      textParts.push('[卡片消息]');
      continue;
    }
    if (type === 'file') {
      textParts.push(`[文件:${String(data['name'] ?? data['file'] ?? '未知文件')}]`);
    }
  }

  const replyCtx = parseReplyContext(event, botSelfId, replyMessageId);

  const sourceType = event.message_type === 'group' ? 'group' : 'private';
  const sourceId =
    sourceType === 'group' ? String(event.group_id ?? '') : String(event.user_id);
  const senderId = String(event.user_id);

  return {
    sourceType,
    sourceId,
    senderId,
    displayText: String(event.raw_message ?? textParts.join('')).trim(),
    text: textParts.join('').trim(),
    recordSource,
    mediaItems,
    replyMessageId: replyCtx.parsedReplyMessageId,
    replyContext: {
      senderId: replyCtx.repliedSenderId,
      senderNickname: replyCtx.repliedSenderNickname,
      previewText: replyCtx.repliedPreviewText,
    },
    hasMention,
    messageTraits: {
      isAtMessage: hasMention,
      isReplyMessage: hasReply,
      isReplyToSelf: replyCtx.isReplyToSelf,
      hasFace,
      hasSticker,
      hasImage,
      hasVideo,
      hasRecord,
    },
  };
}
