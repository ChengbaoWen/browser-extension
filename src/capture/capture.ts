export interface CaptureBase {
  id: string;
  capturedAt: number;
  pageUrl: string;
  matchedRuleId: string;
  configRevision: string;
}

export type HttpVersion =
  | 'http/1.0'
  | 'http/1.1'
  | 'h2'
  | 'h3'
  | 'unknown';

export interface HttpVersionObservation {
  value: HttpVersion;
  source: 'performance-resource-timing' | 'debugger' | 'unavailable';
}

export type MessageHeaders =
  | {
      state: 'captured';
      visibility: 'script-visible';
      entries: Array<[name: string, value: string]>;
    }
  | {
      state: 'unavailable';
      reason: 'api-restriction' | 'event-source-api' | 'websocket-api';
    };

export type UnavailableBodyReason =
  | 'opaque-response'
  | 'unsupported-body'
  | 'read-error'
  | 'size-limit'
  | 'storage-limit';

export type MessageBody =
  | { state: 'absent' }
  | {
      state: 'captured';
      encoding: 'base64';
      byteLength: number;
      data: string;
      fidelity?: 'decoded-text-projection';
    }
  | {
      state: 'unavailable';
      reason: UnavailableBodyReason;
      partialByteLength?: number;
    };

export interface HttpCaptureBase extends CaptureBase {
  exchangeId: string;
  url: string;
  transport: 'fetch' | 'xhr';
  httpVersion: HttpVersionObservation;
}

export interface HttpRequestCapture extends HttpCaptureBase {
  kind: 'http-request';
  method: string;
  headers: MessageHeaders;
  body: MessageBody;
}

export interface HttpResponseCapture extends HttpCaptureBase {
  kind: 'http-response';
  status: number;
  statusText: string;
  headers: MessageHeaders;
  body: MessageBody;
}

export interface HttpErrorCapture extends HttpCaptureBase {
  kind: 'http-error';
  phase: 'request' | 'response';
  reason: 'aborted' | 'network-error';
}

export type Observation<T, TReason extends string> =
  | { state: 'observed'; value: T }
  | { state: 'unavailable'; reason: TReason };

export interface SseCaptureBase extends CaptureBase {
  streamId: string;
  exchangeId: string | null;
  url: string;
  source: 'fetch' | 'xhr' | 'event-source';
  fidelity: 'raw-event-bytes' | 'decoded-text-projection' | 'message-event-projection';
  attempt: number;
}

export interface SseStreamOpenCapture extends SseCaptureBase {
  kind: 'sse-stream-open';
  status: Observation<number, 'event-source-api'>;
  statusText: Observation<string, 'event-source-api'>;
  headers: MessageHeaders;
  httpVersion: HttpVersionObservation;
}

export interface SseEventCapture extends SseCaptureBase {
  kind: 'sse-event';
  sequence: number;
  eventType: string | null;
  lastEventId: string | null;
  body: Extract<MessageBody, { state: 'captured' }>;
}

export interface SseStreamCloseCapture extends SseCaptureBase {
  kind: 'sse-stream-close';
  outcome:
    | 'eof'
    | 'aborted'
    | 'reconnecting'
    | 'read-error'
    | 'limit-exceeded';
  eventCount: number;
  capturedByteLength: number;
  truncatedDueToLimit: boolean;
  partialEventByteLength?: number;
  reason?: string;
}

export interface WebSocketCaptureBase extends CaptureBase {
  connectionId: string;
  url: string;
}

export interface WebSocketOpenCapture extends WebSocketCaptureBase {
  kind: 'websocket-open';
  requestedProtocols: string[];
  negotiatedProtocol: string;
  extensions: string;
  handshake: { state: 'unavailable'; reason: 'websocket-api' };
}

export interface WebSocketMessageCapture extends WebSocketCaptureBase {
  kind: 'websocket-message';
  direction: 'outbound' | 'inbound';
  sequence: number;
  payloadType: 'text' | 'binary';
  body: Extract<MessageBody, { state: 'captured' | 'unavailable' }>;
}

export interface WebSocketCloseCapture extends WebSocketCaptureBase {
  kind: 'websocket-close';
  code: number;
  reason: string;
  wasClean: boolean;
  sentMessageCount: number;
  receivedMessageCount: number;
}

export interface WebSocketErrorCapture extends WebSocketCaptureBase {
  kind: 'websocket-error';
  phase: 'connecting' | 'open';
  reason: 'unspecified-by-browser';
}

export type Capture =
  | HttpRequestCapture
  | HttpResponseCapture
  | HttpErrorCapture
  | SseStreamOpenCapture
  | SseEventCapture
  | SseStreamCloseCapture
  | WebSocketOpenCapture
  | WebSocketMessageCapture
  | WebSocketCloseCapture
  | WebSocketErrorCapture;

export const UNKNOWN_HTTP_VERSION: HttpVersionObservation = {
  value: 'unknown',
  source: 'unavailable',
};