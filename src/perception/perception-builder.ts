/**
 * Perception Builder —— perception-builder.ts
 *
 * Cortex 层：将解析后的 OB11 消息数据转换为标准化的 PerceptionRequest，
 * 让 Cognition 完全不需要感知任何 OB11 知识。
 *
 * 此模块是 Adapter → Cognition 边界的最后一道闸。
 */

import type { NapcatAdapterConfig } from '../../config/schema';
import type { OB11MessageEvent } from '../onebot/ob11-types';
import type { ParsedMessage } from '../onebot/message-parser';

// ─────────────────────────────────────────────────────────────────────
// Inbound helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * 剥离机器人 @ 提及和开头的唤醒词，让 Cognition 只看到语义内容。
 */
export function cleanInboundText(
  text: string,
  event: OB11MessageEvent,
  config: NapcatAdapterConfig,
  botSelfId: string,
): string {
  let value = String(text).replace(/\r/g, '').trim();
  if (!value) return value;

  if (event.message_type === 'group' && config.ingress.strip_self_mention) {
    const selfId = String(event.self_id ?? botSelfId ?? '');
    if (selfId) {
      value = value.replace(new RegExp(`@${selfId}\\s*`, 'g'), '').trim();
    }
  }

  if (config.ingress.strip_leading_wake_words) {
    for (const wakeWord of config.ingress.wake_words) {
      if (!wakeWord) continue;
      if (value.startsWith(wakeWord)) {
        value = value.slice(wakeWord.length).trim();
        break;
      }
    }
  }

  return value;
}

// ─────────────────────────────────────────────────────────────────────
// PerceptionRequest builder
// ─────────────────────────────────────────────────────────────────────

interface PerceptionInputItem {
  modality: string;
  text?: string;
  uri?: string;
  mime_type?: string;
  semantic?: {
    text: string;
    source?: string;
    resolved?: boolean;
    confidence?: number;
  };
  metadata: Record<string, unknown>;
}

/** Cortex 输出：经清洗的文本和媒体项列表，不含任何适配器私有路由字段 */
export interface CortexOutput {
  /** 主文本（格式化后供 Cognition 阅读） */
  formattedText: string;
  inputItems: PerceptionInputItem[];
}

function buildTextPayload(parsed: ParsedMessage, nickname: string, cleanText: string): string {
  const labels: string[] = [];
  if (parsed.messageTraits.isAtMessage) labels.push('@消息');
  if (parsed.messageTraits.isReplyMessage) labels.push('回复消息');
  if (parsed.messageTraits.isReplyToSelf) labels.push('回复当前角色');
  if (parsed.messageTraits.hasSticker) labels.push('表情包');
  if (parsed.messageTraits.hasFace) labels.push('QQ表情');
  if (parsed.messageTraits.hasImage) labels.push('图片');
  if (parsed.messageTraits.hasVideo) labels.push('视频');
  if (parsed.messageTraits.hasRecord) labels.push('语音消息');

  const traits = labels.length > 0 ? labels.join('/') : '普通消息';
  const senderTag =
    parsed.sourceType === 'group'
      ? `[群成员:${nickname}]`
      : `[私聊用户:${nickname}]`;
  // replyTargetTag 仅使用昵称（语义层），不传递任何平台内部 ID
  const replyTargetTag = parsed.replyContext.senderNickname
    ? `[回复对象:${parsed.replyContext.senderNickname}]`
    : '';
  const replyPreviewTag = parsed.replyContext.previewText
    ? `[回复内容预览:${parsed.replyContext.previewText}]`
    : '';

  return [senderTag, `[消息类型:${traits}]`, replyTargetTag, replyPreviewTag, cleanText]
    .filter(Boolean)
    .join(' ')
    .trim();
}

/**
 * Cortex 核心函数：将解析后的消息构建为 Adapter → Cognition 边界处的输出。
 * 返回格式化文本和媒体项列表；不含任何适配器私有路由字段（adapter_id、actor.id 等）。
 * 返回 null 表示消息无可处理内容（静默丢弃）。
 */
export function buildPerceptionRequest(
  parsed: ParsedMessage,
  sceneId: string,
  nickname: string,
  cleanText: string,
  config: NapcatAdapterConfig,
  isMainUser: boolean,
  sessionPolicy = 'by_source',
): CortexOutput | null {
  const inputItems: PerceptionInputItem[] = [];

  const textPayload = buildTextPayload(parsed, nickname, cleanText);
  if (textPayload) {
    inputItems.push({
      modality: 'text',
      text: textPayload,
      metadata: {
        sender_nickname: nickname,
        is_main_user: isMainUser,
        // 以下为语义标记，均为布尔值，无任何平台私有字段
        is_at_message: parsed.messageTraits.isAtMessage,
        is_reply: parsed.messageTraits.isReplyMessage,
        is_reply_to_self: parsed.messageTraits.isReplyToSelf,
        has_sticker: parsed.messageTraits.hasSticker,
        has_image: parsed.messageTraits.hasImage,
        has_video: parsed.messageTraits.hasVideo,
        has_record: parsed.messageTraits.hasRecord,
        session_policy: sessionPolicy,
      },
    });
  }

  for (const item of parsed.mediaItems) {
    // 只传递语义字段，不展开 item.metadata（避免 NapCat 平台字段渗透入 Cognition）
    inputItems.push({
      modality: item.modality,
      uri: item.uri,
      mime_type: item.mime_type,
      semantic: item.semantic,
      metadata: {
        visual_kind: item.metadata['visual_kind'] ?? item.modality,
        sender_nickname: nickname,
        is_main_user: isMainUser,
      },
    });
  }

  if (inputItems.length === 0) return null;

  const formattedText = inputItems.find((i) => i.modality === 'text')?.text ?? cleanText;
  return { formattedText, inputItems };
}

// ─────────────────────────────────────────────────────────────────────
// Outbound helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * 当前默认角色 persona 的全量情绪标签（与 persona_injector.py 同步维护）。
 * 须包含 persona prompt 中声明的所有标签词，以及 LLM 可能自行输出的扩展同义词。
 */
const CHARACTER_EMOTION_LABELS =
  // persona_injector.py 定义的核心情绪标签
  '平静|开心|疑惑|撒娇|严谨|害羞|生气|委屈|思考' +
  // 扩展同义词
  '|高兴|愉快|愤怒|难过|傲娇|好奇|冷静|激动|无奈|担心|兴奋' +
  // 英文别名
  '|calm|happy|curious|coy|tsundere|shy|angry|aggrieved|thinking' +
  '|joyful|pleased|furious|sad|peaceful|worried|excited|sulky';

/**
 * 全局匹配情绪标签（任意位置）：[开心]、[emotion:happy]、(emotion:shy)、《思考》等格式。
 * 使用全局 gi 标志，一次替换消除所有出现位置。
 */
const GLOBAL_EMOTION_TAG_RE = new RegExp(
  `[\\[\\(（【]\\s*(?:emotion|情绪)?\\s*[:：]?\\s*(?:${CHARACTER_EMOTION_LABELS})\\s*[\\]\\)）】]`,
  'gi',
);

/** 无括号前缀格式：仅匹配行首的 "emotion: happy" 或 "情绪：开心" 声明。 */
const NAKED_EMOTION_PREFIX_RE = new RegExp(
  `^(?:emotion|情绪)\\s*[:：]\\s*(?:${CHARACTER_EMOTION_LABELS})\\s*`,
  'i',
);

/**
 * 从出站回复文本中清除全部情绪标签。
 *
 * 处理范围：
 *   - [开心]、[emotion:happy]、(shy) 等所有位置（前缀、中间、末尾）
 *   - 无括号前缀：emotion: happy
 */
export function cleanOutboundReply(text: string): string {
  let value = String(text).replace(/\r/g, '').trim();
  if (!value) return '';

  // 全局去除所有括号形式情绪标签（不限位置）
  value = value.replace(GLOBAL_EMOTION_TAG_RE, '').trim();
  // 去除无括号前缀形式
  value = value.replace(NAKED_EMOTION_PREFIX_RE, '').trim();
  // 清理多余连续空白
  value = value.replace(/\s{2,}/g, ' ').trim();

  return value;
}
