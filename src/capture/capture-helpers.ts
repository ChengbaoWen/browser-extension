import type { CaptureBase, MessageBody, MessageHeaders } from './capture';
import { bytesToBase64 } from './bytes';

export interface CaptureContext {
  matchedRuleId: string;
  configRevision: string;
}

export function createCaptureId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function createCaptureBase(context: CaptureContext): CaptureBase {
  return {
    id: createCaptureId(),
    capturedAt: Date.now(),
    pageUrl: location.href,
    matchedRuleId: context.matchedRuleId,
    configRevision: context.configRevision,
  };
}

export function capturedHeaders(headers: Headers): MessageHeaders {
  return {
    state: 'captured',
    visibility: 'script-visible',
    entries: Array.from(headers.entries()),
  };
}

export function capturedBody(bytes: Uint8Array, maxBytes: number): MessageBody {
  if (bytes.byteLength > maxBytes) {
    return { state: 'unavailable', reason: 'size-limit', partialByteLength: bytes.byteLength };
  }
  return {
    state: 'captured',
    encoding: 'base64',
    byteLength: bytes.byteLength,
    data: bytesToBase64(bytes),
  };
}

export async function requestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  maxBytes: number,
): Promise<MessageBody> {
  const body = init?.body;
  if (body !== undefined && body !== null) return readableBody(body, maxBytes);
  if (!(input instanceof Request) || input.body === null) return { state: 'absent' };
  try {
    const bytes = new Uint8Array(await input.clone().arrayBuffer());
    return capturedBody(bytes, maxBytes);
  } catch {
    return { state: 'unavailable', reason: 'unsupported-body' };
  }
}

export async function readableBody(value: unknown, maxBytes: number): Promise<MessageBody> {
  try {
    if (typeof value === 'string') return capturedBody(new TextEncoder().encode(value), maxBytes);
    if (value instanceof URLSearchParams) return capturedBody(new TextEncoder().encode(value.toString()), maxBytes);
    if (value instanceof ArrayBuffer) return capturedBody(new Uint8Array(value.slice(0)), maxBytes);
    if (ArrayBuffer.isView(value)) {
      return capturedBody(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)), maxBytes);
    }
    if (value instanceof Blob) {
      if (value.size > maxBytes) return { state: 'unavailable', reason: 'size-limit', partialByteLength: value.size };
      return capturedBody(new Uint8Array(await value.arrayBuffer()), maxBytes);
    }
    return { state: 'unavailable', reason: 'unsupported-body' };
  } catch {
    return { state: 'unavailable', reason: 'read-error' };
  }
}

export function normalizeUrl(value: string): string {
  try {
    return new URL(value, location.href).href;
  } catch {
    return value;
  }
}