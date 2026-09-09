import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capture } from '../../src/capture/capture';
import { installFetchAdapter } from '../../src/capture/fetch-adapter';

const policy = {
  captureRequestBody: false,
  captureResponseBody: true,
  maxBodyBytes: 4,
  sseEnabled: false,
  maxSseEventBytes: 1024,
  maxSseStreamBytes: 4096,
};

beforeEach(() => vi.stubGlobal('location', new URL('https://page.example/app')));
afterEach(() => vi.unstubAllGlobals());

describe('Fetch adapter', () => {
  it('clones a Request body before the original fetch consumes it', async () => {
    const captures: Capture[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (input instanceof Request) void input.text();
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('window', { fetch });
    const cleanup = installFetchAdapter({
      match: () => ({ matchedRuleId: 'rule', configRevision: 'r1' }),
      emit: (capture) => captures.push(capture),
      policy: () => ({ ...policy, captureRequestBody: true, maxBodyBytes: 1024 }),
    });
    const input = new Request('https://api.example/v1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":"hello"}',
    });

    await window.fetch(input);

    await vi.waitFor(() => expect(captures.find((capture) => capture.kind === 'http-request')).toMatchObject({
      kind: 'http-request',
      body: { state: 'captured', byteLength: 19 },
    }));
    cleanup();
  });

  it('returns the original response when cloning fails', async () => {
    const response = new Response('ok', { status: 200 });
    Object.defineProperty(response, 'clone', { value: () => { throw new TypeError('used'); } });
    const fetch = vi.fn(async () => response);
    vi.stubGlobal('window', { fetch });
    const captures: Capture[] = [];
    const cleanup = installFetchAdapter({
      match: () => ({ matchedRuleId: 'rule', configRevision: 'r1' }),
      emit: (capture) => captures.push(capture),
      policy: () => policy,
    });
    expect(await window.fetch('https://api.example/v1')).toBe(response);
    expect(captures.find((capture) => capture.kind === 'http-response')).toMatchObject({
      kind: 'http-response', body: { state: 'unavailable', reason: 'read-error' },
    });
    cleanup();
  });

  it('stops capture when the response body exceeds its limit', async () => {
    const response = new Response('larger', { status: 200 });
    vi.stubGlobal('window', { fetch: vi.fn(async () => response) });
    const captures: Capture[] = [];
    const cleanup = installFetchAdapter({
      match: () => ({ matchedRuleId: 'rule', configRevision: 'r1' }),
      emit: (capture) => captures.push(capture),
      policy: () => policy,
    });
    await window.fetch('https://api.example/v1');
    await vi.waitFor(() => expect(captures.find((capture) => capture.kind === 'http-response')).toMatchObject({
      kind: 'http-response', body: { state: 'unavailable', reason: 'size-limit' },
    }));
    cleanup();
  });

  it('does not describe an uncollected response body as absent', async () => {
    const captures: Capture[] = [];
    vi.stubGlobal('window', { fetch: vi.fn(async () => new Response('not inspected')) });
    const cleanup = installFetchAdapter({
      match: () => ({ matchedRuleId: 'rule', configRevision: 'r1' }),
      emit: (capture) => captures.push(capture),
      policy: () => ({ captureRequestBody: false, captureResponseBody: false, maxBodyBytes: 10, sseEnabled: false, maxSseEventBytes: 10, maxSseStreamBytes: 10 }),
    });
    await window.fetch('https://api.example/v1');
    await vi.waitFor(() => expect(captures.some((capture) => capture.kind === 'http-response')).toBe(true));
    expect(captures.find((capture) => capture.kind === 'http-response')).toMatchObject({ body: { state: 'unavailable', reason: 'unsupported-body' } });
    cleanup();
  });
});