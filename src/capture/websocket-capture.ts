import type { Capture, MessageBody } from './capture';
import { capturedBody, createCaptureBase, createCaptureId, normalizeUrl, readableBody, type CaptureContext } from './capture-helpers';

export function installWebSocketCapture(options: {
  match(url: string): CaptureContext | null;
  emit(capture: Capture): void;
  limits(): { maxMessageBytes: number; maxConnectionBytes: number };
}): () => void {
  const Original = window.WebSocket;
  const Wrapped = function (this: WebSocket, rawUrl: string | URL, protocols?: string | string[]) {
    const url = normalizeUrl(String(rawUrl));
    const context = options.match(url);
    let instance: WebSocket;
    try {
      instance = protocols === undefined ? new Original(rawUrl) : new Original(rawUrl, protocols);
    } catch (error) {
      if (context) options.emit({
        ...createCaptureBase(context), kind: 'websocket-error', connectionId: createCaptureId(), url,
        phase: 'connecting', reason: 'unspecified-by-browser',
      });
      throw error;
    }
    if (!context) return instance;
    const captureContext = context;
    const connectionId = createCaptureId();
    const limits = options.limits();
    const requestedProtocols = protocols === undefined ? [] : typeof protocols === 'string' ? [protocols] : [...protocols];
    let sentMessageCount = 0;
    let receivedMessageCount = 0;
    let sentSequence = 0;
    let receivedSequence = 0;
    let capturedBytes = 0;
    let connectionLimitReached = false;
    let messageQueue = Promise.resolve();
    const originalSend = instance.send;
    instance.send = function (data) {
      const result = originalSend.call(this, data);
      sentSequence += 1;
      sentMessageCount += 1;
      enqueueMessage(data, 'outbound', sentSequence);
      return result;
    };
    instance.addEventListener('open', () => options.emit({
      ...createCaptureBase(context), kind: 'websocket-open', connectionId, url, requestedProtocols,
      negotiatedProtocol: instance.protocol, extensions: instance.extensions,
      handshake: { state: 'unavailable', reason: 'websocket-api' },
    }));
    instance.addEventListener('message', (event) => {
      receivedSequence += 1;
      receivedMessageCount += 1;
      enqueueMessage(event.data, 'inbound', receivedSequence);
    });
    instance.addEventListener('error', () => options.emit({
      ...createCaptureBase(context), kind: 'websocket-error', connectionId, url,
      phase: instance.readyState === Original.CONNECTING ? 'connecting' : 'open',
      reason: 'unspecified-by-browser',
    }));
    instance.addEventListener('close', (event) => {
      void messageQueue.then(() => options.emit({
        ...createCaptureBase(context), kind: 'websocket-close', connectionId, url,
        code: event.code, reason: event.reason, wasClean: event.wasClean,
        sentMessageCount, receivedMessageCount,
      }));
    });

    function enqueueMessage(data: unknown, direction: 'outbound' | 'inbound', sequence: number) {
      messageQueue = messageQueue.then(() => emitMessage(data, direction, sequence));
    }

    async function emitMessage(data: unknown, direction: 'outbound' | 'inbound', sequence: number) {
      let body: MessageBody;
      let payloadType: 'text' | 'binary';
      if (typeof data === 'string') {
        payloadType = 'text';
        const bytes = new TextEncoder().encode(data);
        body = connectionLimitReached
          ? { state: 'unavailable', reason: 'size-limit', partialByteLength: bytes.byteLength }
          : capturedBody(bytes, limits.maxMessageBytes);
      } else {
        payloadType = 'binary';
        body = connectionLimitReached
          ? { state: 'unavailable', reason: 'size-limit', partialByteLength: observableByteLength(data) }
          : await readableBody(data, limits.maxMessageBytes);
      }
      const bodyBytes = body.state === 'captured' ? body.byteLength : 0;
      if (body.state === 'captured' && capturedBytes + bodyBytes > limits.maxConnectionBytes) {
        body = { state: 'unavailable', reason: 'size-limit', partialByteLength: bodyBytes };
        connectionLimitReached = true;
      } else if (body.state === 'captured') capturedBytes += bodyBytes;
      options.emit({
        ...createCaptureBase(captureContext), kind: 'websocket-message', connectionId, url,
        direction, sequence, payloadType,
        body: body as Extract<MessageBody, { state: 'captured' | 'unavailable' }>,
      });
    }
    return instance;
  } as unknown as typeof WebSocket;
  Object.setPrototypeOf(Wrapped, Original);
  Wrapped.prototype = Original.prototype;
  window.WebSocket = Wrapped;
  return () => {
    if (window.WebSocket === Wrapped) window.WebSocket = Original;
  };
}

function observableByteLength(data: unknown): number | undefined {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data instanceof Blob) return data.size;
  return undefined;
}