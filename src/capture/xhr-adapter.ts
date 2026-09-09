import type { Capture, MessageBody } from './capture';
import { UNKNOWN_HTTP_VERSION } from './capture';
import { base64ToBytes } from './bytes';
import { capturedBody, capturedHeaders, createCaptureBase, createCaptureId, normalizeUrl, readableBody, type CaptureContext } from './capture-helpers';
import { createSseFramer } from './sse-framer';

const META = Symbol('capture-xhr-meta');

interface XhrMeta {
  method: string;
  url: string;
  context: CaptureContext | null;
  exchangeId: string;
  requestHeaders: Array<[string, string]>;
}

export function installXhrAdapter(options: {
  match(url: string): CaptureContext | null;
  emit(capture: Capture): void;
  policy(): {
    captureRequestBody: boolean;
    captureResponseBody: boolean;
    maxBodyBytes: number;
    sseEnabled?: boolean;
    maxSseEventBytes?: number;
    maxSseStreamBytes?: number;
  };
}): () => void {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  const openImplementation = function (
    this: XMLHttpRequest,
    method: string,
    rawUrl: string | URL,
    async = true,
    username?: string | null,
    password?: string | null,
  ) {
    const url = normalizeUrl(String(rawUrl));
    (this as XMLHttpRequest & { [META]?: XhrMeta })[META] = {
      method: method.toUpperCase(), url, context: options.match(url), exchangeId: createCaptureId(), requestHeaders: [],
    };
    return originalOpen.call(this, method, rawUrl, async, username, password);
  };
  const wrappedOpen = openImplementation as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = wrappedOpen;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    (this as XMLHttpRequest & { [META]?: XhrMeta })[META]?.requestHeaders.push([name, value]);
    return originalSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const meta = (this as XMLHttpRequest & { [META]?: XhrMeta })[META];
    if (!meta?.context) return originalSend.call(this, body);
    const policy = options.policy();
    const bodyCapture = policy.captureRequestBody
      ? readableBody(body, policy.maxBodyBytes)
      : Promise.resolve<MessageBody>(body === null || body === undefined
        ? { state: 'absent' }
        : { state: 'unavailable', reason: 'unsupported-body' });
    void bodyCapture.then((captured) => {
      options.emit({
        ...createCaptureBase(meta.context!), kind: 'http-request', exchangeId: meta.exchangeId,
        url: meta.url, transport: 'xhr', httpVersion: UNKNOWN_HTTP_VERSION, method: meta.method,
        headers: { state: 'captured', visibility: 'script-visible', entries: [...meta.requestHeaders] },
        body: captured,
      });
    });
    this.addEventListener('loadend', () => void captureXhrResponse(this, meta, policy, options.emit), { once: true });
    return originalSend.call(this, body);
  };
  return () => {
    if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = originalOpen;
    if (XMLHttpRequest.prototype.send !== originalSend) XMLHttpRequest.prototype.send = originalSend;
    if (XMLHttpRequest.prototype.setRequestHeader !== originalSetHeader) XMLHttpRequest.prototype.setRequestHeader = originalSetHeader;
  };
}

async function captureXhrResponse(
  xhr: XMLHttpRequest,
  meta: XhrMeta,
  policy: {
    captureResponseBody: boolean;
    maxBodyBytes: number;
    sseEnabled?: boolean;
    maxSseEventBytes?: number;
    maxSseStreamBytes?: number;
  },
  emit: (capture: Capture) => void,
): Promise<void> {
  if (xhr.status === 0) {
    emit({
      ...createCaptureBase(meta.context!), kind: 'http-error', exchangeId: meta.exchangeId,
      url: meta.url, transport: 'xhr', httpVersion: UNKNOWN_HTTP_VERSION, phase: 'response',
      reason: 'network-error',
    });
    return;
  }
  const contentType = xhr.getResponseHeader('content-type')?.toLowerCase() ?? '';
  const headers = responseHeaders(xhr);
  if (policy.sseEnabled && contentType.includes('text/event-stream')) {
    const rawBytes = xhr.responseType === 'arraybuffer' || xhr.responseType === 'blob';
    const decodedText = xhr.responseType === '' || xhr.responseType === 'text';
    const sourceBody = rawBytes || decodedText
      ? await readableBody(xhr.response, policy.maxSseStreamBytes ?? 0)
      : { state: 'unavailable', reason: 'unsupported-body' } as const;
    emitXhrSse(sourceBody, rawBytes ? 'raw-event-bytes' : 'decoded-text-projection', xhr, headers, meta, policy, emit);
    return;
  }
  const bodyForbidden = meta.method === 'HEAD' || xhr.status === 204 || xhr.status === 205 || xhr.status === 304;
  let body: MessageBody = bodyForbidden
    ? { state: 'absent' }
    : { state: 'unavailable', reason: 'unsupported-body' };
  if (policy.captureResponseBody && !bodyForbidden) {
    if (xhr.responseType === '' || xhr.responseType === 'text' || xhr.responseType === 'arraybuffer' || xhr.responseType === 'blob') {
      body = await readableBody(xhr.response, policy.maxBodyBytes);
      if ((xhr.responseType === '' || xhr.responseType === 'text') && body.state === 'captured') {
        body = { ...body, fidelity: 'decoded-text-projection' };
      }
    }
  }
  emit({
    ...createCaptureBase(meta.context!), kind: 'http-response', exchangeId: meta.exchangeId,
    url: meta.url, transport: 'xhr', httpVersion: UNKNOWN_HTTP_VERSION,
    status: xhr.status, statusText: xhr.statusText, headers: capturedHeaders(headers), body,
  });
}

function emitXhrSse(
  body: MessageBody,
  fidelity: 'raw-event-bytes' | 'decoded-text-projection',
  xhr: XMLHttpRequest,
  headers: Headers,
  meta: XhrMeta,
  policy: { maxSseEventBytes?: number; maxSseStreamBytes?: number },
  emit: (capture: Capture) => void,
): void {
  const streamId = createCaptureId();
  const maxEventBytes = policy.maxSseEventBytes ?? 0;
  const maxStreamBytes = policy.maxSseStreamBytes ?? 0;
  const context = meta.context!;
  emit({
    ...createCaptureBase(context), kind: 'sse-stream-open', streamId, exchangeId: meta.exchangeId,
    url: meta.url, source: 'xhr', fidelity, attempt: 1,
    status: { state: 'observed', value: xhr.status }, statusText: { state: 'observed', value: xhr.statusText },
    headers: capturedHeaders(headers), httpVersion: UNKNOWN_HTTP_VERSION,
  });
  if (body.state !== 'captured') {
    emit({
      ...createCaptureBase(context), kind: 'sse-stream-close', streamId, exchangeId: meta.exchangeId,
      url: meta.url, source: 'xhr', fidelity, attempt: 1,
      outcome: body.state === 'unavailable' && body.reason === 'size-limit' ? 'limit-exceeded' : 'read-error',
      eventCount: 0, capturedByteLength: 0,
      truncatedDueToLimit: body.state === 'unavailable' && body.reason === 'size-limit',
      ...(body.state === 'unavailable' && body.partialByteLength !== undefined ? { partialEventByteLength: body.partialByteLength } : {}),
      ...(body.state === 'unavailable' ? { reason: body.reason } : {}),
    });
    return;
  }
  const raw = base64ToBytes(body.data);
    const framer = createSseFramer();
    const events = [...framer.push(raw), ...framer.finish().events];
    let capturedByteLength = 0;
    let eventCount = 0;
    let truncated = false;
    let partialEventByteLength: number | undefined;
    for (const event of events) {
      if (event.byteLength > maxEventBytes || capturedByteLength + event.byteLength > maxStreamBytes) {
        truncated = true;
        partialEventByteLength = event.byteLength;
        break;
      }
      eventCount += 1;
      capturedByteLength += event.byteLength;
      emit({
        ...createCaptureBase(context), kind: 'sse-event', streamId, exchangeId: meta.exchangeId,
        url: meta.url, source: 'xhr', fidelity, attempt: 1,
        sequence: eventCount, eventType: null, lastEventId: null,
        body: capturedBody(event, maxEventBytes) as Extract<MessageBody, { state: 'captured' }>,
      });
    }
    emit({
      ...createCaptureBase(context), kind: 'sse-stream-close', streamId, exchangeId: meta.exchangeId,
      url: meta.url, source: 'xhr', fidelity, attempt: 1,
      outcome: truncated ? 'limit-exceeded' : 'eof', eventCount, capturedByteLength,
      truncatedDueToLimit: truncated,
      ...(partialEventByteLength === undefined ? {} : { partialEventByteLength }),
    });
}

function responseHeaders(xhr: XMLHttpRequest): Headers {
  const headers = new Headers();
  for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
    const separator = line.indexOf(':');
    if (separator > 0) headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return headers;
}