/**
 * OB11 Frame Normalizer — ob11-normalizer.ts
 *
 * Normalizes raw WebSocket frames from NapCat into canonical OB11 event objects.
 * NapCat sometimes wraps events in `{ arrayMsg, stringMsg }` or `{ payload: { ... } }`
 * envelopes; this module unwraps and flattens them.
 */

import type { OB11Event, OB11MessageSegment } from './ob11-types';

function normalizeMessageSegments(
  message: unknown,
  rawMessage: unknown,
): OB11MessageSegment[] {
  if (Array.isArray(message)) {
    return (message as unknown[])
      .filter(
        (seg): seg is Record<string, unknown> =>
          !!seg && typeof seg === 'object' && typeof (seg as Record<string, unknown>).type === 'string',
      )
      .map((seg) => ({
        type: String(seg['type']),
        data:
          seg['data'] && typeof seg['data'] === 'object'
            ? (seg['data'] as Record<string, unknown>)
            : {},
      }));
  }

  if (typeof message === 'string') {
    const text = message.trim();
    return text ? [{ type: 'text', data: { text } }] : [];
  }

  if (typeof rawMessage === 'string') {
    const text = rawMessage.trim();
    return text ? [{ type: 'text', data: { text } }] : [];
  }

  return [];
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeOneEvent(candidate: Record<string, unknown>): OB11Event | null {
  // OB11 echo response frame
  if (candidate['echo'] && Object.prototype.hasOwnProperty.call(candidate, 'status')) {
    return candidate as OB11Event;
  }

  if (!candidate['post_type']) return null;

  // Non-message events pass through unchanged
  if (candidate['post_type'] !== 'message') return candidate as OB11Event;

  const normalizedSegments = normalizeMessageSegments(
    candidate['message'],
    candidate['raw_message'],
  );
  return {
    ...candidate,
    message: normalizedSegments,
    message_format: 'array',
  } as unknown as OB11Event;
}

function extractCandidates(frame: unknown): Record<string, unknown>[] {
  const base = toObject(frame);
  if (!base) return [];

  // NapCat envelope: { arrayMsg, stringMsg }
  if (base['arrayMsg'] || base['stringMsg']) {
    const list: Record<string, unknown>[] = [];
    const arrayMsg = toObject(base['arrayMsg']);
    const stringMsg = toObject(base['stringMsg']);
    if (arrayMsg) list.push(arrayMsg);
    if (stringMsg) list.push(stringMsg);
    return list;
  }

  // Nested payload envelope
  const payload = toObject(base['payload']);
  if (payload && (payload['arrayMsg'] || payload['stringMsg'] || payload['post_type'])) {
    const list: Record<string, unknown>[] = [];
    const arrayMsg = toObject(payload['arrayMsg']);
    const stringMsg = toObject(payload['stringMsg']);
    if (arrayMsg) list.push(arrayMsg);
    if (stringMsg) list.push(stringMsg);
    if (list.length > 0) return list;
    if (payload['post_type']) return [payload];
  }

  // data envelope
  const data = toObject(base['data']);
  if (data && (data['arrayMsg'] || data['stringMsg'] || data['post_type'])) {
    const list: Record<string, unknown>[] = [];
    const arrayMsg = toObject(data['arrayMsg']);
    const stringMsg = toObject(data['stringMsg']);
    if (arrayMsg) list.push(arrayMsg);
    if (stringMsg) list.push(stringMsg);
    if (list.length > 0) return list;
    if (data['post_type']) return [data];
  }

  // event envelope
  const event = toObject(base['event']);
  if (event && event['post_type']) return [event];

  // Flat OB11 event
  if (base['post_type'] || (base['echo'] && Object.prototype.hasOwnProperty.call(base, 'status'))) {
    return [base];
  }

  // Stringified message field
  if (typeof base['message'] === 'string') {
    const maybe = toObject(base['message']);
    if (maybe && (maybe['post_type'] || maybe['arrayMsg'] || maybe['stringMsg'])) {
      return extractCandidates(maybe);
    }
  }

  return [];
}

/**
 * Normalize a raw WebSocket payload (possibly wrapped) into an array of OB11 events.
 * May return an empty array if the frame carries no recognizable OB11 data.
 */
export function normalizeOB11Frames(rawPayload: unknown): OB11Event[] {
  const frames: unknown[] = Array.isArray(rawPayload) ? rawPayload : [rawPayload];
  const normalized: OB11Event[] = [];

  for (const frame of frames) {
    const candidates = extractCandidates(frame);
    for (const candidate of candidates) {
      const event = normalizeOneEvent(candidate);
      if (!event) continue;
      normalized.push(event);
      // 优先使用 arrayMsg，避免 stringMsg 重复入站
      if ((event as Record<string, unknown>)['post_type'] === 'message') break;
    }
  }

  return normalized;
}
