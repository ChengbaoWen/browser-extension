import type { Capture, HttpRequestCapture, HttpResponseCapture, SseEventCapture } from './capture';
import { UNKNOWN_HTTP_VERSION } from './capture';
import { capturedBody, capturedHeaders, createCaptureBase, createCaptureId, normalizeUrl, requestBody, type CaptureContext } from './capture-helpers';
import { createSseFramer } from './sse-framer';

export interface FetchCapturePolicy {
  captureRequestBody: boolean;
  captureResponseBody: boolean;
  maxBodyBytes: number;
  sseEnabled: boolean;
  maxSseEventBytes: number;
  maxSseStreamBytes: number;
}

export function installFetchAdapter(options: {
  match(url: string): CaptureContext | null;
  emit(capture: Capture): void;
  policy(): FetchCapturePolicy;
}): () => void {
  const previous = window.fetch;
  const wrapped: typeof window.fetch = async function (input, init) {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = normalizeUrl(rawUrl);
    const context = options.match(url);
    if (!context) return previous(input, init);
    const policy = options.policy();
    const exchangeId = createCaptureId();
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    const suppliedBody = init?.body ?? (input instanceof Request ? input.body : null);
    const bodyPromise = policy.captureRequestBody
      ? requestBody(input, init, policy.maxBodyBytes)
      : Promise.resolve(suppliedBody === null
        ? { state: 'absent' } as const
        : { state: 'unavailable', reason: 'unsupported-body' } as const);
    const responsePromise = previous(input, init);
    void (async () => {
      const request: HttpRequestCapture = {
        ...createCaptureBase(context), kind: 'http-request', exchangeId, url, transport: 'fetch',
        httpVersion: UNKNOWN_HTTP_VERSION, method, headers: capturedHeaders(headers),
        body: await bodyPromise,
      };
      options.emit(request);
    })();
    try {
      const response = await responsePromise;
      try {
        const clone = response.clone();
        void captureResponse(clone, exchangeId, url, context, policy, options.emit);
      } catch {
        options.emit({
          ...createCaptureBase(context), kind: 'http-response', exchangeId, url, transport: 'fetch',
          httpVersion: UNKNOWN_HTTP_VERSION, status: response.status, statusText: response.statusText,
          headers: capturedHeaders(response.headers), body: { state: 'unavailable', reason: 'read-error' },
        });
      }
      return response;
    } catch (error) {
      options.emit({
        ...createCaptureBase(context), kind: 'http-error', exchangeId, url, transport: 'fetch',
        httpVersion: UNKNOWN_HTTP_VERSION, phase: 'response',
        reason: error instanceof DOMException && error.name === 'AbortError' ? 'aborted' : 'network-error',
      });
      throw error;
    }
  };
  window.fetch = wrapped;
  return () => {
    if (window.fetch === wrapped) window.fetch = previous;
  };
}

async function captureResponse(
  response: Response,
  exchangeId: string,
  url: string,
  context: CaptureContext,
  policy: FetchCapturePolicy,
  emit: (capture: Capture) => void,
): Promise<void> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (policy.sseEnabled && contentType.includes('text/event-stream') && response.body) {
    await captureSse(response, exchangeId, url, context, policy, emit);
    return;
  }
  const bodyForbidden = response.status === 204 || response.status === 205 || response.status === 304;
  let body: HttpResponseCapture['body'] = bodyForbidden || response.body === null
    ? { state: 'absent' }
    : { state: 'unavailable', reason: 'unsupported-body' };
  if (policy.captureResponseBody && !bodyForbidden && response.body) {
    body = await readResponseBody(response, policy.maxBodyBytes);
  }
  emit({
    ...createCaptureBase(context), kind: 'http-response', exchangeId, url, transport: 'fetch',
    httpVersion: UNKNOWN_HTTP_VERSION, status: response.status, statusText: response.statusText,
    headers: capturedHeaders(response.headers), body,
  });
}

async function captureSse(
  response: Response,
  exchangeId: string,
  url: string,
  context: CaptureContext,
  policy: FetchCapturePolicy,
  emit: (capture: Capture) => void,
): Promise<void> {
  const streamId = createCaptureId();
  emit({
    ...createCaptureBase(context), kind: 'sse-stream-open', streamId, exchangeId, url,
    source: 'fetch', fidelity: 'raw-event-bytes', attempt: 1,
    status: { state: 'observed', value: response.status },
    statusText: { state: 'observed', value: response.statusText },
    headers: capturedHeaders(response.headers), httpVersion: UNKNOWN_HTTP_VERSION,
  });
  const reader = response.body!.getReader();
  const framer = createSseFramer();
  let sequence = 0;
  let capturedByteLength = 0;
  let outcome: 'eof' | 'read-error' | 'limit-exceeded' = 'eof';
  let partialEventByteLength: number | undefined;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      for (const bytes of framer.push(result.value)) {
        if (bytes.byteLength > policy.maxSseEventBytes || capturedByteLength + bytes.byteLength > policy.maxSseStreamBytes) {
          outcome = 'limit-exceeded';
          partialEventByteLength = bytes.byteLength;
          void reader.cancel().catch(() => undefined);
          break;
        }
        sequence += 1;
        capturedByteLength += bytes.byteLength;
        const event: SseEventCapture = {
          ...createCaptureBase(context), kind: 'sse-event', streamId, exchangeId, url,
          source: 'fetch', fidelity: 'raw-event-bytes', attempt: 1, sequence,
          eventType: null, lastEventId: null,
          body: capturedBody(bytes, policy.maxSseEventBytes) as SseEventCapture['body'],
        };
        emit(event);
      }
      if (outcome === 'limit-exceeded') break;
    }
  } catch {
    outcome = 'read-error';
  } finally {
    reader.releaseLock();
  }
  emit({
    ...createCaptureBase(context), kind: 'sse-stream-close', streamId, exchangeId, url,
    source: 'fetch', fidelity: 'raw-event-bytes', attempt: 1, outcome,
    eventCount: sequence, capturedByteLength, truncatedDueToLimit: outcome === 'limit-exceeded',
    ...(partialEventByteLength === undefined ? {} : { partialEventByteLength }),
  });
}

async function readResponseBody(response: Response, maxBytes: number): Promise<HttpResponseCapture['body']> {
  if (response.type === 'opaque') return { state: 'unavailable', reason: 'opaque-response' };
  if (!response.body) return { state: 'absent' };
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return { state: 'unavailable', reason: 'size-limit', partialByteLength: length };
      }
      parts.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return capturedBody(bytes, maxBytes);
  } catch {
    return { state: 'unavailable', reason: 'read-error', partialByteLength: length || undefined };
  } finally {
    reader.releaseLock();
  }
}