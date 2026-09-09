import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64ToBytes } from '../../src/capture/bytes';
import type { Capture } from '../../src/capture/capture';
import { installXhrAdapter } from '../../src/capture/xhr-adapter';

class FakeXmlHttpRequest extends EventTarget {
  status = 200;
  statusText = 'OK';
  responseType: XMLHttpRequestResponseType = '';
  response: unknown = '';
  open(_method: string, _url: string | URL, _async = true, _username?: string | null, _password?: string | null) {}
  send(_body?: Document | XMLHttpRequestBodyInit | null) {}
  setRequestHeader(_name: string, _value: string) {}
  getResponseHeader(name: string) { return name.toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null; }
  getAllResponseHeaders() { return 'content-type: text/event-stream; charset=utf-8\r\nx-trace: one\r\n'; }
}

beforeEach(() => {
  vi.stubGlobal('location', new URL('http://page.example/app'));
  vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);
});
afterEach(() => vi.unstubAllGlobals());

describe('XHR adapter', () => {
  it('does not read a request Blob when request body capture is disabled', async () => {
    const captures: Capture[] = [];
    const cleanup = installXhrAdapter({
      match: () => ({ matchedRuleId: 'rule', configRevision: 'r1' }),
      emit: (capture) => captures.push(capture),
      policy: () => ({ captureRequestBody: false, captureResponseBody: false, maxBodyBytes: 10 }),
    });
    const body = new Blob(['secret']);
    const read = vi.spyOn(body, 'arrayBuffer');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.example/v1');
    xhr.send(body);
    await vi.waitFor(() => expect(captures).toHaveLength(1));
    expect(read).not.toHaveBeenCalled();
    expect(captures[0]).toMatchObject({ kind: 'http-request', body: { state: 'unavailable', reason: 'unsupported-body' } });
    cleanup();
  });

  it('does not describe an uncollected response body as absent', async () => {
    const captures: Capture[] = [];
    const cleanup = installXhrAdapter({
      match: () => ({ matchedRuleId: 'rule', configRevision: 'r1' }),
      emit: (capture) => captures.push(capture),
      policy: () => ({ captureRequestBody: false, captureResponseBody: false, maxBodyBytes: 10 }),
    });
    const xhr = new XMLHttpRequest() as unknown as FakeXmlHttpRequest;
    xhr.response = 'not inspected';
    xhr.open('GET', 'https://api.example/v1');
    xhr.send();
    xhr.dispatchEvent(new Event('loadend'));
    await vi.waitFor(() => expect(captures.some((capture) => capture.kind === 'http-response')).toBe(true));
    expect(captures.find((capture) => capture.kind === 'http-response')).toMatchObject({ body: { state: 'unavailable', reason: 'unsupported-body' } });
    cleanup();
  });

  it('captures a regular decoded text response', async () => {
    const captures: Capture[] = [];
    const cleanup = installXhrAdapter({
      match: () => ({ matchedRuleId: 'gemini-web-chat', configRevision: 'r1' }),
      emit: (capture) => captures.push(capture),
      policy: () => ({ captureRequestBody: false, captureResponseBody: true, maxBodyBytes: 1024 }),
    });
    const xhr = new XMLHttpRequest() as unknown as FakeXmlHttpRequest;
    xhr.response = `)]}'\n42\n[["wrb.fr","rpc",null]]`;
    xhr.open('POST', 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate');
    xhr.send();
    xhr.dispatchEvent(new Event('loadend'));

    await vi.waitFor(() => expect(captures.find((capture) => capture.kind === 'http-response')).toMatchObject({
      kind: 'http-response', body: { state: 'captured', fidelity: 'decoded-text-projection' },
    }));
    const response = captures.find((capture) => capture.kind === 'http-response');
    if (!response || response.kind !== 'http-response' || response.body.state !== 'captured') {
      throw new Error('Expected captured HTTP response');
    }
    expect(new TextDecoder().decode(base64ToBytes(response.body.data))).toBe(xhr.response);
    cleanup();
  });

  it('captures a decoded text SSE response without labeling it as raw bytes', async () => {
    const captures: Capture[] = [];
    const cleanup = installXhrAdapter({
      match: () => ({ matchedRuleId: 'rule', configRevision: 'r1' }),
      emit: (capture) => captures.push(capture),
      policy: () => ({ captureRequestBody: false, captureResponseBody: true, maxBodyBytes: 10, sseEnabled: true, maxSseEventBytes: 100, maxSseStreamBytes: 100 }),
    });
    const xhr = new XMLHttpRequest() as unknown as FakeXmlHttpRequest;
    xhr.response = 'data: decoded\n\n';
    xhr.open('GET', 'https://api.example/events');
    xhr.send();
    xhr.dispatchEvent(new Event('loadend'));
    await vi.waitFor(() => expect(captures.some((capture) => capture.kind === 'sse-stream-close')).toBe(true));
    expect(captures.find((capture) => capture.kind === 'sse-event')).toMatchObject({
      fidelity: 'decoded-text-projection',
      sequence: 1,
      body: { state: 'captured', byteLength: 15 },
    });
    expect(captures.some((capture) => capture.kind === 'http-response')).toBe(false);
    expect(captures.find((capture) => capture.kind === 'sse-stream-close')).toMatchObject({
      fidelity: 'decoded-text-projection', outcome: 'eof', eventCount: 1,
    });
    cleanup();
  });
});