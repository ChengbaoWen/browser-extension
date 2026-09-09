import type { Capture } from './capture';
import { UNKNOWN_HTTP_VERSION } from './capture';
import { capturedBody, createCaptureBase, createCaptureId, normalizeUrl, type CaptureContext } from './capture-helpers';

export function installEventSourceAdapter(options: {
  match(url: string): CaptureContext | null;
  emit(capture: Capture): void;
  limits(): { maxEventBytes: number; maxStreamBytes: number };
}): () => void {
  const Original = window.EventSource;
  const Wrapped = function (this: EventSource, rawUrl: string | URL, init?: EventSourceInit) {
    const instance = new Original(rawUrl, init);
    const url = normalizeUrl(String(rawUrl));
    const context = options.match(url);
    if (!context) return instance;
    const streamId = createCaptureId();
    const limits = options.limits();
    let attempt = 0;
    let sequence = 0;
    let capturedByteLength = 0;
    let terminated = false;
    const originalClose = instance.close.bind(instance);
    instance.close = () => {
      if (!terminated) {
        terminated = true;
        options.emit({
          ...createCaptureBase(context), kind: 'sse-stream-close', streamId, exchangeId: null, url,
          source: 'event-source', fidelity: 'message-event-projection', attempt: Math.max(attempt, 1),
          outcome: 'aborted', eventCount: sequence, capturedByteLength, truncatedDueToLimit: false,
        });
      }
      originalClose();
    };
    instance.addEventListener('open', () => {
      if (terminated) return;
      attempt += 1;
      options.emit({
        ...createCaptureBase(context), kind: 'sse-stream-open', streamId, exchangeId: null, url,
        source: 'event-source', fidelity: 'message-event-projection', attempt,
        status: { state: 'unavailable', reason: 'event-source-api' },
        statusText: { state: 'unavailable', reason: 'event-source-api' },
        headers: { state: 'unavailable', reason: 'event-source-api' }, httpVersion: UNKNOWN_HTTP_VERSION,
      });
    });
    instance.addEventListener('message', (event) => {
      if (terminated) return;
      const bytes = new TextEncoder().encode(event.data);
      sequence += 1;
      const body = capturedBody(bytes, limits.maxEventBytes);
      if (body.state !== 'captured' || capturedByteLength + bytes.byteLength > limits.maxStreamBytes) {
        terminated = true;
        options.emit({
          ...createCaptureBase(context), kind: 'sse-stream-close', streamId, exchangeId: null, url,
          source: 'event-source', fidelity: 'message-event-projection', attempt: Math.max(attempt, 1),
          outcome: 'limit-exceeded', eventCount: sequence - 1, capturedByteLength,
          truncatedDueToLimit: true, partialEventByteLength: bytes.byteLength,
        });
        return;
      }
      capturedByteLength += bytes.byteLength;
      options.emit({
        ...createCaptureBase(context), kind: 'sse-event', streamId, exchangeId: null, url,
        source: 'event-source', fidelity: 'message-event-projection', attempt: Math.max(attempt, 1),
        sequence, eventType: event.type, lastEventId: event.lastEventId || null,
        body,
      });
    });
    instance.addEventListener('error', () => {
      if (terminated) return;
      options.emit({
        ...createCaptureBase(context), kind: 'sse-stream-close', streamId, exchangeId: null, url,
        source: 'event-source', fidelity: 'message-event-projection', attempt: Math.max(attempt, 1),
        outcome: instance.readyState === Original.CONNECTING ? 'reconnecting' : 'read-error',
        eventCount: sequence, capturedByteLength, truncatedDueToLimit: false,
      });
    });
    return instance;
  } as unknown as typeof EventSource;
  Object.setPrototypeOf(Wrapped, Original);
  Wrapped.prototype = Original.prototype;
  window.EventSource = Wrapped;
  return () => {
    if (window.EventSource === Wrapped) window.EventSource = Original;
  };
}