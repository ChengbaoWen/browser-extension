import type {
  Capture, CaptureBase, HttpCaptureBase, HttpVersionObservation, MessageBody, MessageHeaders,
  SseCaptureBase, WebSocketCaptureBase,
} from '../capture/capture';

interface DeliveryCaptureBase {
  id: string;
  capturedAt: number;
  pageUrl: string;
  matchedRuleId: string;
  configRevision: string;
}

type DeliveryHeaders =
  | { state: 'captured'; visibility: 'script-visible'; entries: Array<[string, string]> }
  | { state: 'unavailable'; reason: 'api-restriction' | 'event-source-api' | 'websocket-api' };

type DeliveryBody =
  | { state: 'absent' }
  | { state: 'captured'; encoding: 'base64'; byteLength: number; data: string; fidelity?: 'decoded-text-projection' }
  | { state: 'unavailable'; reason: 'opaque-response' | 'unsupported-body' | 'read-error' | 'size-limit' | 'storage-limit'; partialByteLength?: number };

interface DeliveryHttpBase extends DeliveryCaptureBase {
  exchangeId: string;
  url: string;
  transport: 'fetch' | 'xhr';
  httpVersion: HttpVersionObservation;
}

interface DeliverySseBase extends DeliveryCaptureBase {
  streamId: string;
  exchangeId: string | null;
  url: string;
  source: 'fetch' | 'xhr' | 'event-source';
  fidelity: 'raw-event-bytes' | 'decoded-text-projection' | 'message-event-projection';
  attempt: number;
}

interface DeliveryWebSocketBase extends DeliveryCaptureBase {
  connectionId: string;
  url: string;
}

export type DeliveryCapture =
  | (DeliveryHttpBase & { kind: 'http-request'; method: string; headers: DeliveryHeaders; body: DeliveryBody })
  | (DeliveryHttpBase & { kind: 'http-response'; status: number; statusText: string; headers: DeliveryHeaders; body: DeliveryBody })
  | (DeliveryHttpBase & { kind: 'http-error'; phase: 'request' | 'response'; reason: 'aborted' | 'network-error' })
  | (DeliverySseBase & {
      kind: 'sse-stream-open';
      status: { state: 'observed'; value: number } | { state: 'unavailable'; reason: 'event-source-api' };
      statusText: { state: 'observed'; value: string } | { state: 'unavailable'; reason: 'event-source-api' };
      headers: DeliveryHeaders;
      httpVersion: HttpVersionObservation;
    })
  | (DeliverySseBase & { kind: 'sse-event'; sequence: number; eventType: string | null; lastEventId: string | null; body: Extract<DeliveryBody, { state: 'captured' }> })
  | (DeliverySseBase & {
      kind: 'sse-stream-close';
      outcome: 'eof' | 'aborted' | 'reconnecting' | 'read-error' | 'limit-exceeded';
      eventCount: number;
      capturedByteLength: number;
      truncatedDueToLimit: boolean;
      partialEventByteLength?: number;
      reason?: string;
    })
  | (DeliveryWebSocketBase & { kind: 'websocket-open'; requestedProtocols: string[]; negotiatedProtocol: string; extensions: string; handshake: { state: 'unavailable'; reason: 'websocket-api' } })
  | (DeliveryWebSocketBase & { kind: 'websocket-message'; direction: 'outbound' | 'inbound'; sequence: number; payloadType: 'text' | 'binary'; body: Extract<DeliveryBody, { state: 'captured' | 'unavailable' }> })
  | (DeliveryWebSocketBase & { kind: 'websocket-close'; code: number; reason: string; wasClean: boolean; sentMessageCount: number; receivedMessageCount: number })
  | (DeliveryWebSocketBase & { kind: 'websocket-error'; phase: 'connecting' | 'open'; reason: 'unspecified-by-browser' });

export interface DeliveryBatch {
  schemaVersion: 1;
  batchId: string;
  createdAt: number;
  client: {
    extensionVersion: string;
    browser: 'chrome';
  };
  captures: DeliveryCapture[];
}

export interface DeliveryReceipt {
  schemaVersion: 1;
  batchId: string;
  acceptedCaptureIds: string[];
}

export function toDeliveryCapture(capture: Capture): DeliveryCapture {
  switch (capture.kind) {
    case 'http-request': return { ...httpBase(capture), kind: capture.kind, method: capture.method, headers: deliveryHeaders(capture.headers), body: deliveryBody(capture.body) };
    case 'http-response': return { ...httpBase(capture), kind: capture.kind, status: capture.status, statusText: capture.statusText, headers: deliveryHeaders(capture.headers), body: deliveryBody(capture.body) };
    case 'http-error': return { ...httpBase(capture), kind: capture.kind, phase: capture.phase, reason: capture.reason };
    case 'sse-stream-open': return { ...sseBase(capture), kind: capture.kind, status: { ...capture.status }, statusText: { ...capture.statusText }, headers: deliveryHeaders(capture.headers), httpVersion: { ...capture.httpVersion } };
    case 'sse-event': return { ...sseBase(capture), kind: capture.kind, sequence: capture.sequence, eventType: capture.eventType, lastEventId: capture.lastEventId, body: deliveryBody(capture.body) as Extract<DeliveryBody, { state: 'captured' }> };
    case 'sse-stream-close': return {
      ...sseBase(capture), kind: capture.kind, outcome: capture.outcome, eventCount: capture.eventCount,
      capturedByteLength: capture.capturedByteLength, truncatedDueToLimit: capture.truncatedDueToLimit,
      ...(capture.partialEventByteLength === undefined ? {} : { partialEventByteLength: capture.partialEventByteLength }),
      ...(capture.reason === undefined ? {} : { reason: capture.reason }),
    };
    case 'websocket-open': return { ...webSocketBase(capture), kind: capture.kind, requestedProtocols: [...capture.requestedProtocols], negotiatedProtocol: capture.negotiatedProtocol, extensions: capture.extensions, handshake: { ...capture.handshake } };
    case 'websocket-message': return { ...webSocketBase(capture), kind: capture.kind, direction: capture.direction, sequence: capture.sequence, payloadType: capture.payloadType, body: deliveryBody(capture.body) as Extract<DeliveryBody, { state: 'captured' | 'unavailable' }> };
    case 'websocket-close': return { ...webSocketBase(capture), kind: capture.kind, code: capture.code, reason: capture.reason, wasClean: capture.wasClean, sentMessageCount: capture.sentMessageCount, receivedMessageCount: capture.receivedMessageCount };
    case 'websocket-error': return { ...webSocketBase(capture), kind: capture.kind, phase: capture.phase, reason: capture.reason };
    default:
      return assertNever(capture);
  }
}

export async function createBatchId(endpoint: string, captureIds: string[]): Promise<string> {
  const canonical = JSON.stringify([1, new URL(endpoint).origin, captureIds]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Capture kind: ${JSON.stringify(value)}`);
}

function captureBase(capture: CaptureBase): DeliveryCaptureBase {
  return { id: capture.id, capturedAt: capture.capturedAt, pageUrl: capture.pageUrl, matchedRuleId: capture.matchedRuleId, configRevision: capture.configRevision };
}

function httpBase(capture: HttpCaptureBase): DeliveryHttpBase {
  return { ...captureBase(capture), exchangeId: capture.exchangeId, url: capture.url, transport: capture.transport, httpVersion: { ...capture.httpVersion } };
}

function sseBase(capture: SseCaptureBase): DeliverySseBase {
  return { ...captureBase(capture), streamId: capture.streamId, exchangeId: capture.exchangeId, url: capture.url, source: capture.source, fidelity: capture.fidelity, attempt: capture.attempt };
}

function webSocketBase(capture: WebSocketCaptureBase): DeliveryWebSocketBase {
  return { ...captureBase(capture), connectionId: capture.connectionId, url: capture.url };
}

function deliveryHeaders(headers: MessageHeaders): DeliveryHeaders {
  return headers.state === 'captured'
    ? { state: 'captured', visibility: 'script-visible', entries: headers.entries.map(([name, value]) => [name, value]) }
    : { state: 'unavailable', reason: headers.reason };
}

function deliveryBody(body: MessageBody): DeliveryBody {
  if (body.state === 'absent') return { state: 'absent' };
  if (body.state === 'captured') return {
    state: 'captured', encoding: 'base64', byteLength: body.byteLength, data: body.data,
    ...(body.fidelity === undefined ? {} : { fidelity: body.fidelity }),
  };
  return { state: 'unavailable', reason: body.reason, ...(body.partialByteLength === undefined ? {} : { partialByteLength: body.partialByteLength }) };
}