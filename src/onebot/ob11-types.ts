/**
 * OB11 (OneBot 11) Protocol Types
 *
 * Raw type definitions for the OneBot 11 message format received from NapCat.
 * These types MUST NOT leak beyond the adapter boundary (napcat-adapter).
 * The AI core only ever sees normalized PerceptionEvent.
 */

/** OB11 消息段类型 */
export type OB11SegmentType =
  | 'text'
  | 'at'
  | 'reply'
  | 'face'
  | 'record'
  | 'image'
  | 'video'
  | 'file'
  | string;

/** OB11 消息段 */
export interface OB11MessageSegment {
  type: OB11SegmentType;
  data: Record<string, unknown>;
}

/** OB11 发送者信息 */
export interface OB11Sender {
  user_id?: number | string;
  nickname?: string;
  card?: string;
  role?: string;
}

/** OB11 引用回复嵌套数据 */
export interface OB11ReplyData {
  message_id?: number | string;
  user_id?: number | string;
  sender?: OB11Sender;
  message?: OB11MessageSegment[];
  raw_message?: string;
}

/** OB11 归一化后的消息事件（供插件内部流水线使用） */
export interface OB11MessageEvent {
  post_type: 'message';
  message_type: 'private' | 'group';
  user_id: number | string;
  group_id?: number | string;
  self_id?: number | string;
  time?: number;
  message: OB11MessageSegment[];
  raw_message?: string;
  sender: OB11Sender;
  reply?: OB11ReplyData;
  /** 允许其他字段透传 */
  [key: string]: unknown;
}

/** OB11 状态响应帧（echo） */
export interface OB11EchoFrame {
  echo: string;
  status: string;
  retcode?: number;
  data?: unknown;
}

/** OB11 非消息事件（meta_event / notice 等） */
export interface OB11NonMessageEvent {
  post_type: Exclude<string, 'message'>;
  [key: string]: unknown;
}

export type OB11Event = OB11MessageEvent | OB11EchoFrame | OB11NonMessageEvent;
