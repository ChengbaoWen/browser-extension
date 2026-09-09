import type {
  Capture,
  HttpRequestCapture,
  HttpResponseCapture,
  MessageBody,
  SseEventCapture,
  UnavailableBodyReason,
  WebSocketMessageCapture,
} from './capture';
import { base64ToBytes, bytesToBase64 } from './bytes';

type BodyCapture =
  | HttpRequestCapture
  | HttpResponseCapture
  | SseEventCapture
  | WebSocketMessageCapture;

export type BodyCaptureDescriptor =
  | Omit<HttpRequestCapture, 'body'>
  | Omit<HttpResponseCapture, 'body'>
  | Omit<SseEventCapture, 'body'>
  | Omit<WebSocketMessageCapture, 'body'>;

export type BodylessCapture = Exclude<Capture, BodyCapture>;

export type CaptureStartDescriptor =
  | { body: 'framed'; capture: BodyCaptureDescriptor }
  | { body: 'not-applicable'; capture: BodylessCapture };

export type CaptureCompletion =
  | { body: 'not-applicable' }
  | { body: Extract<MessageBody, { state: 'absent' }> }
  | { body: Omit<Extract<MessageBody, { state: 'captured' }>, 'data'> }
  | { body: Extract<MessageBody, { state: 'unavailable' }> };

interface CaptureFrameBase {
  protocolVersion: 1;
  captureId: string;
  frameSequence: number;
  configRevision: string;
}

export interface CaptureStartFrame extends CaptureFrameBase {
  type: 'start';
  frameSequence: 0;
  descriptor: CaptureStartDescriptor;
}

export interface CaptureChunkFrame extends CaptureFrameBase {
  type: 'chunk';
  bodyField: 'body';
  chunkSequence: number;
  encoding: 'base64';
  byteLength: number;
  data: string;
}

export interface CaptureBodyUnavailableFrame extends CaptureFrameBase {
  type: 'body-unavailable';
  bodyField: 'body';
  reason: UnavailableBodyReason;
  partialByteLength?: number;
}

export interface CaptureEndFrame extends CaptureFrameBase {
  type: 'end';
  completion: CaptureCompletion;
}

export interface CaptureErrorFrame extends CaptureFrameBase {
  type: 'error';
  reason: 'capture-cancelled' | 'invalid-state' | 'channel-overflow';
}

export type CaptureFrame =
  | CaptureStartFrame
  | CaptureChunkFrame
  | CaptureBodyUnavailableFrame
  | CaptureEndFrame
  | CaptureErrorFrame;

const BODY_KINDS = new Set<Capture['kind']>([
  'http-request',
  'http-response',
  'sse-event',
  'websocket-message',
]);
const CAPTURE_KINDS = new Set<Capture['kind']>([
  'http-request',
  'http-response',
  'http-error',
  'sse-stream-open',
  'sse-event',
  'sse-stream-close',
  'websocket-open',
  'websocket-message',
  'websocket-close',
  'websocket-error',
]);

export function captureToFrames(capture: Capture, maxChunkBytes: number): CaptureFrame[] {
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes <= 0) {
    throw new Error('maxChunkBytes must be a positive integer');
  }
  const configRevision = capture.configRevision;
  let frameSequence = 0;
  if (!BODY_KINDS.has(capture.kind)) {
    return [
      {
        protocolVersion: 1,
        type: 'start',
        captureId: capture.id,
        frameSequence: 0,
        configRevision,
        descriptor: { body: 'not-applicable', capture: capture as BodylessCapture },
      },
      {
        protocolVersion: 1,
        type: 'end',
        captureId: capture.id,
        frameSequence: 1,
        configRevision,
        completion: { body: 'not-applicable' },
      },
    ];
  }

  const bodyCapture = capture as BodyCapture;
  const { body, ...descriptor } = bodyCapture;
  frameSequence = 1;
  const frames: CaptureFrame[] = [
    {
      protocolVersion: 1,
      type: 'start',
      captureId: capture.id,
      frameSequence: 0,
      configRevision,
      descriptor: { body: 'framed', capture: descriptor as BodyCaptureDescriptor },
    },
  ];
  if (body.state === 'captured') {
    const bytes = base64ToBytes(body.data);
    if (bytes.byteLength !== body.byteLength) throw new Error('Body byteLength mismatch');
    let chunkSequence = 0;
    for (let offset = 0; offset < bytes.length; offset += maxChunkBytes) {
      const chunk = bytes.subarray(offset, offset + maxChunkBytes);
      frames.push({
        protocolVersion: 1,
        type: 'chunk',
        captureId: capture.id,
        frameSequence: frameSequence++,
        configRevision,
        bodyField: 'body',
        chunkSequence: chunkSequence++,
        encoding: 'base64',
        byteLength: chunk.byteLength,
        data: bytesToBase64(chunk),
      });
    }
    frames.push({
      protocolVersion: 1,
      type: 'end',
      captureId: capture.id,
      frameSequence,
      configRevision,
      completion: {
        body: {
          state: 'captured', encoding: 'base64', byteLength: body.byteLength,
          ...(body.fidelity === undefined ? {} : { fidelity: body.fidelity }),
        },
      },
    });
  } else if (body.state === 'unavailable') {
    frames.push({
      protocolVersion: 1,
      type: 'body-unavailable',
      captureId: capture.id,
      frameSequence: frameSequence++,
      configRevision,
      bodyField: 'body',
      reason: body.reason,
      ...(body.partialByteLength === undefined ? {} : { partialByteLength: body.partialByteLength }),
    });
    frames.push({
      protocolVersion: 1,
      type: 'end',
      captureId: capture.id,
      frameSequence,
      configRevision,
      completion: { body },
    });
  } else {
    frames.push({
      protocolVersion: 1,
      type: 'end',
      captureId: capture.id,
      frameSequence,
      configRevision,
      completion: { body },
    });
  }
  return frames;
}

export function parseCaptureFrame(value: unknown, maxChunkBytes = 64 * 1024): CaptureFrame | null {
  if (!isObject(value)) return null;
  if (
    value.protocolVersion !== 1 ||
    typeof value.captureId !== 'string' ||
    value.captureId.length === 0 ||
    !isNonNegativeInteger(value.frameSequence) ||
    typeof value.configRevision !== 'string'
  ) {
    return null;
  }
  if (value.type === 'start') {
    if (!hasExactKeys(value, ['protocolVersion', 'type', 'captureId', 'frameSequence', 'configRevision', 'descriptor']) || value.frameSequence !== 0 || !isObject(value.descriptor)) return null;
    const descriptor = value.descriptor;
    if (!isObject(descriptor.capture) || !CAPTURE_KINDS.has(descriptor.capture.kind as Capture['kind'])) return null;
    if (descriptor.capture.id !== value.captureId || descriptor.capture.configRevision !== value.configRevision) return null;
    const hasBody = BODY_KINDS.has(descriptor.capture.kind as Capture['kind']);
    if (!hasExactKeys(descriptor, ['body', 'capture']) || descriptor.body !== (hasBody ? 'framed' : 'not-applicable')) return null;
    if (!isCaptureDescriptor(descriptor.capture, hasBody)) return null;
    return value as unknown as CaptureStartFrame;
  }
  if (value.type === 'chunk') {
    if (
      !hasExactKeys(value, ['protocolVersion', 'type', 'captureId', 'frameSequence', 'configRevision', 'bodyField', 'chunkSequence', 'encoding', 'byteLength', 'data']) ||
      value.bodyField !== 'body' ||
      value.encoding !== 'base64' ||
      !isNonNegativeInteger(value.chunkSequence) ||
      !isNonNegativeInteger(value.byteLength) ||
      value.byteLength > maxChunkBytes ||
      typeof value.data !== 'string'
    ) return null;
    try {
      if (base64ToBytes(value.data).byteLength !== value.byteLength) return null;
    } catch {
      return null;
    }
    return value as unknown as CaptureChunkFrame;
  }
  if (value.type === 'body-unavailable') {
    const keys = ['protocolVersion', 'type', 'captureId', 'frameSequence', 'configRevision', 'bodyField', 'reason'];
    if (value.partialByteLength !== undefined) keys.push('partialByteLength');
    if (!hasExactKeys(value, keys) || value.bodyField !== 'body' || !isUnavailableReason(value.reason)) return null;
    if (value.partialByteLength !== undefined && !isNonNegativeInteger(value.partialByteLength)) return null;
    return value as unknown as CaptureBodyUnavailableFrame;
  }
  if (value.type === 'end') {
    if (!hasExactKeys(value, ['protocolVersion', 'type', 'captureId', 'frameSequence', 'configRevision', 'completion']) || !isObject(value.completion) || !hasExactKeys(value.completion, ['body'])) return null;
    const body = value.completion.body;
    if (body === 'not-applicable') return value as unknown as CaptureEndFrame;
    if (!isObject(body) || !['absent', 'captured', 'unavailable'].includes(String(body.state))) return null;
    if (body.state === 'absent' && !hasExactKeys(body, ['state'])) return null;
    if (body.state === 'captured') {
      const keys = ['state', 'encoding', 'byteLength'];
      if (body.fidelity !== undefined) keys.push('fidelity');
      if (!hasExactKeys(body, keys) || body.encoding !== 'base64' || !isNonNegativeInteger(body.byteLength) || (body.fidelity !== undefined && body.fidelity !== 'decoded-text-projection')) return null;
    }
    if (body.state === 'unavailable') {
      const keys = ['state', 'reason'];
      if (body.partialByteLength !== undefined) keys.push('partialByteLength');
      if (!hasExactKeys(body, keys) || !isUnavailableReason(body.reason) || (body.partialByteLength !== undefined && !isNonNegativeInteger(body.partialByteLength))) return null;
    }
    return value as unknown as CaptureEndFrame;
  }
  if (value.type === 'error') {
    return hasExactKeys(value, ['protocolVersion', 'type', 'captureId', 'frameSequence', 'configRevision', 'reason']) && ['capture-cancelled', 'invalid-state', 'channel-overflow'].includes(String(value.reason))
      ? (value as unknown as CaptureErrorFrame)
      : null;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isUnavailableReason(value: unknown): value is UnavailableBodyReason {
  return ['opaque-response', 'unsupported-body', 'read-error', 'size-limit', 'storage-limit'].includes(String(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isCaptureDescriptor(value: Record<string, unknown>, bodyCapture: boolean): boolean {
  if (!isCaptureBase(value) || typeof value.kind !== 'string' || typeof value.url !== 'string') return false;
  const base = ['kind', 'id', 'capturedAt', 'pageUrl', 'matchedRuleId', 'configRevision', 'url'];
  switch (value.kind) {
    case 'http-request':
      return bodyCapture && hasExactKeys(value, [...base, 'exchangeId', 'transport', 'httpVersion', 'method', 'headers']) && isHttpBase(value) && typeof value.method === 'string' && isHeaders(value.headers);
    case 'http-response':
      return bodyCapture && hasExactKeys(value, [...base, 'exchangeId', 'transport', 'httpVersion', 'status', 'statusText', 'headers']) && isHttpBase(value) && isNonNegativeInteger(value.status) && typeof value.statusText === 'string' && isHeaders(value.headers);
    case 'http-error':
      return !bodyCapture && hasExactKeys(value, [...base, 'exchangeId', 'transport', 'httpVersion', 'phase', 'reason']) && isHttpBase(value) && ['request', 'response'].includes(String(value.phase)) && ['aborted', 'network-error'].includes(String(value.reason));
    case 'sse-stream-open':
      return !bodyCapture && hasExactKeys(value, [...base, 'streamId', 'exchangeId', 'source', 'fidelity', 'attempt', 'status', 'statusText', 'headers', 'httpVersion']) && isSseBase(value) && isObservation(value.status, 'number') && isObservation(value.statusText, 'string') && isHeaders(value.headers) && isHttpVersion(value.httpVersion);
    case 'sse-event':
      return bodyCapture && hasExactKeys(value, [...base, 'streamId', 'exchangeId', 'source', 'fidelity', 'attempt', 'sequence', 'eventType', 'lastEventId']) && isSseBase(value) && isNonNegativeInteger(value.sequence) && nullableString(value.eventType) && nullableString(value.lastEventId);
    case 'sse-stream-close': {
      const keys = [...base, 'streamId', 'exchangeId', 'source', 'fidelity', 'attempt', 'outcome', 'eventCount', 'capturedByteLength', 'truncatedDueToLimit'];
      if (value.partialEventByteLength !== undefined) keys.push('partialEventByteLength');
      if (value.reason !== undefined) keys.push('reason');
      return !bodyCapture && hasExactKeys(value, keys) && isSseBase(value) && ['eof', 'aborted', 'reconnecting', 'read-error', 'limit-exceeded'].includes(String(value.outcome)) && isNonNegativeInteger(value.eventCount) && isNonNegativeInteger(value.capturedByteLength) && typeof value.truncatedDueToLimit === 'boolean' && (value.partialEventByteLength === undefined || isNonNegativeInteger(value.partialEventByteLength)) && (value.reason === undefined || typeof value.reason === 'string');
    }
    case 'websocket-open':
      return !bodyCapture && hasExactKeys(value, [...base, 'connectionId', 'requestedProtocols', 'negotiatedProtocol', 'extensions', 'handshake']) && isWebSocketBase(value) && Array.isArray(value.requestedProtocols) && value.requestedProtocols.every((item) => typeof item === 'string') && typeof value.negotiatedProtocol === 'string' && typeof value.extensions === 'string' && isExactUnavailable(value.handshake, 'websocket-api');
    case 'websocket-message':
      return bodyCapture && hasExactKeys(value, [...base, 'connectionId', 'direction', 'sequence', 'payloadType']) && isWebSocketBase(value) && ['outbound', 'inbound'].includes(String(value.direction)) && isNonNegativeInteger(value.sequence) && ['text', 'binary'].includes(String(value.payloadType));
    case 'websocket-close':
      return !bodyCapture && hasExactKeys(value, [...base, 'connectionId', 'code', 'reason', 'wasClean', 'sentMessageCount', 'receivedMessageCount']) && isWebSocketBase(value) && isNonNegativeInteger(value.code) && typeof value.reason === 'string' && typeof value.wasClean === 'boolean' && isNonNegativeInteger(value.sentMessageCount) && isNonNegativeInteger(value.receivedMessageCount);
    case 'websocket-error':
      return !bodyCapture && hasExactKeys(value, [...base, 'connectionId', 'phase', 'reason']) && isWebSocketBase(value) && ['connecting', 'open'].includes(String(value.phase)) && value.reason === 'unspecified-by-browser';
    default:
      return false;
  }
}

function isCaptureBase(value: Record<string, unknown>): boolean {
  return typeof value.id === 'string' && value.id.length > 0 && isNonNegativeInteger(value.capturedAt) && typeof value.pageUrl === 'string' && typeof value.matchedRuleId === 'string' && typeof value.configRevision === 'string';
}

function isHttpBase(value: Record<string, unknown>): boolean {
  return typeof value.exchangeId === 'string' && ['fetch', 'xhr'].includes(String(value.transport)) && isHttpVersion(value.httpVersion);
}

function isSseBase(value: Record<string, unknown>): boolean {
  return typeof value.streamId === 'string' && nullableString(value.exchangeId) && ['fetch', 'xhr', 'event-source'].includes(String(value.source)) && ['raw-event-bytes', 'decoded-text-projection', 'message-event-projection'].includes(String(value.fidelity)) && isNonNegativeInteger(value.attempt);
}

function isWebSocketBase(value: Record<string, unknown>): boolean {
  return typeof value.connectionId === 'string' && value.connectionId.length > 0;
}

function isHttpVersion(value: unknown): boolean {
  return isExactObject(value, ['value', 'source']) && ['http/1.0', 'http/1.1', 'h2', 'h3', 'unknown'].includes(String(value.value)) && ['performance-resource-timing', 'debugger', 'unavailable'].includes(String(value.source));
}

function isHeaders(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.state === 'unavailable') return hasExactKeys(value, ['state', 'reason']) && ['api-restriction', 'event-source-api', 'websocket-api'].includes(String(value.reason));
  return value.state === 'captured' && hasExactKeys(value, ['state', 'visibility', 'entries']) && value.visibility === 'script-visible' && Array.isArray(value.entries) && value.entries.every((entry) => Array.isArray(entry) && entry.length === 2 && entry.every((item) => typeof item === 'string'));
}

function isObservation(value: unknown, type: 'number' | 'string'): boolean {
  if (!isObject(value)) return false;
  if (value.state === 'observed') return hasExactKeys(value, ['state', 'value']) && typeof value.value === type;
  return value.state === 'unavailable' && hasExactKeys(value, ['state', 'reason']) && value.reason === 'event-source-api';
}

function isExactUnavailable(value: unknown, reason: string): boolean {
  return isExactObject(value, ['state', 'reason']) && value.state === 'unavailable' && value.reason === reason;
}

function isExactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isObject(value) && hasExactKeys(value, keys);
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}