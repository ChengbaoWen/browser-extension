import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureFrame } from '../../src/capture/capture-frame';
import { captureToFrames } from '../../src/capture/capture-frame';
import type { HttpRequestCapture } from '../../src/capture/capture';
import { bytesToBase64 } from '../../src/capture/bytes';
import { CAPTURE_EVENT_NAME } from '../../src/channel/main-capture-channel';
import { CONFIG_EVENT_NAME, parseConfigEnvelope, parseMainConfigEnvelope, type ConfigEnvelope } from '../../src/channel/config-channel';
import { installIsolatedChannel } from '../../src/channel/isolated-channel';

function config(maxQueuedFrames = 3): ConfigEnvelope {
  return {
    kind: 'config', revision: 'r1',
    main: {
      revision: 'r1', enabled: true, channelMaxFrameBytes: 64 * 1024,
      endpoints: [{
        id: 'rule',
        hosts: [{ schemes: ['https'], host: 'api.example', paths: [{ match: 'exact', value: '/v1' }] }],
      }],
      http: { enabled: true, captureRequestBody: true, captureResponseBody: true, maxBodyBytes: 1024 },
      sse: { enabled: true, sources: ['fetch'], maxEventBytes: 1024, maxStreamBytes: 4096 },
      websocket: { enabled: true, maxMessageBytes: 1024, maxConnectionBytes: 4096 },
    },
    isolated: {
      revision: 'r1', maxFrameBytes: 64 * 1024, maxQueuedFrames, maxQueuedBytes: 1024,
      reconnectInitialDelayMs: 1, reconnectMaxDelayMs: 4,
    },
  };
}

function fakePort(postMessage = vi.fn()) {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port = {
    name: 'network-capture-v1', postMessage, disconnect: vi.fn(),
    onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
  } as unknown as chrome.runtime.Port;
  return { port, emitMessage: (message: unknown) => messageListeners.forEach((listener) => listener(message)) };
}

function requestCapture(id: string): HttpRequestCapture {
  const bytes = new TextEncoder().encode('abcd');
  return {
    kind: 'http-request', id, exchangeId: `exchange-${id}`, capturedAt: 1,
    pageUrl: 'https://page.example', matchedRuleId: 'rule', configRevision: 'r1',
    url: 'https://api.example/v1', transport: 'fetch', httpVersion: { value: 'unknown', source: 'unavailable' },
    method: 'POST', headers: { state: 'captured', visibility: 'script-visible', entries: [] },
    body: { state: 'captured', encoding: 'base64', byteLength: bytes.byteLength, data: bytesToBase64(bytes) },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Channel', () => {
  it('strictly validates and freezes complete config envelopes', () => {
    const envelope = config();
    const parsed = parseConfigEnvelope(envelope);
    expect(parsed).not.toBeNull();
    expect(Object.isFrozen(parsed?.main.http)).toBe(true);
    expect(parseConfigEnvelope({ ...envelope, main: { ...envelope.main, http: { enabled: true } } })).toBeNull();
    expect(parseConfigEnvelope({ ...envelope, unexpected: true })).toBeNull();
  });

  it('forwards only the MAIN projection across the page-world boundary', () => {
    const target = new EventTarget();
    const forwarded: unknown[] = [];
    target.addEventListener(CONFIG_EVENT_NAME, (event) => forwarded.push((event as CustomEvent<unknown>).detail));
    const port = fakePort();
    const cleanup = installIsolatedChannel({ connect: () => port.port, eventTarget: target });
    port.emitMessage(config());
    expect(forwarded).toHaveLength(1);
    expect(parseMainConfigEnvelope(forwarded[0])).not.toBeNull();
    expect(forwarded[0]).not.toHaveProperty('isolated');
    cleanup();
  });

  it('reconnects after connect failures', async () => {
    vi.useFakeTimers();
    const second = fakePort();
    const connect = vi.fn<() => chrome.runtime.Port>()
      .mockImplementationOnce(() => { throw new Error('offline'); })
      .mockReturnValue(second.port);
    const cleanup = installIsolatedChannel({ connect, eventTarget: new EventTarget() });
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(connect).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('terminates the oldest complete frame group and preserves the incoming frame', async () => {
    vi.useFakeTimers();
    let failPosts = false;
    const first = fakePort(vi.fn(() => { if (failPosts) throw new Error('disconnected'); }));
    const secondMessages: unknown[] = [];
    const second = fakePort(vi.fn((message) => secondMessages.push(message)));
    const connect = vi.fn<() => chrome.runtime.Port>().mockReturnValueOnce(first.port).mockReturnValue(second.port);
    const target = new EventTarget();
    const cleanup = installIsolatedChannel({ connect, eventTarget: target });
    first.emitMessage(config());
    target.dispatchEvent(new CustomEvent(CONFIG_EVENT_NAME, { detail: { kind: 'main-config-ack', revision: 'r1' } }));
    failPosts = true;
    const firstFrames = captureToFrames(requestCapture('first'), 2);
    for (const frame of firstFrames.slice(0, 3)) target.dispatchEvent(new CustomEvent(CAPTURE_EVENT_NAME, { detail: frame }));
    const incoming = captureToFrames(requestCapture('second'), 2)[0]!;
    target.dispatchEvent(new CustomEvent(CAPTURE_EVENT_NAME, { detail: incoming }));
    await vi.advanceTimersByTimeAsync(1);

    const forwarded = secondMessages
      .filter((message): message is { kind: 'capture-frame'; frame: CaptureFrame } => typeof message === 'object' && message !== null && (message as { kind?: string }).kind === 'capture-frame')
      .map((message) => message.frame);
    expect(forwarded.map((frame) => [frame.captureId, frame.type])).toEqual([['first', 'error'], ['second', 'start']]);
    expect(forwarded[0]?.configRevision).toBe('r1');
    cleanup();
  });

  it('keeps terminal controls admissible after queue limits shrink', async () => {
    vi.useFakeTimers();
    let failPosts = false;
    const first = fakePort(vi.fn(() => { if (failPosts) throw new Error('disconnected'); }));
    const forwarded: unknown[] = [];
    const second = fakePort(vi.fn((message) => forwarded.push(message)));
    const connect = vi.fn<() => chrome.runtime.Port>().mockReturnValueOnce(first.port).mockReturnValue(second.port);
    const target = new EventTarget();
    const cleanup = installIsolatedChannel({ connect, eventTarget: target });
    first.emitMessage(config(8));
    target.dispatchEvent(new CustomEvent(CONFIG_EVENT_NAME, { detail: { kind: 'main-config-ack', revision: 'r1' } }));
    failPosts = true;
    const frames = captureToFrames(requestCapture('shrinking'), 2);
    for (const frame of frames.slice(0, -1)) target.dispatchEvent(new CustomEvent(CAPTURE_EVENT_NAME, { detail: frame }));
    const smaller = config(1);
    smaller.revision = 'r2'; smaller.main.revision = 'r2'; smaller.isolated.revision = 'r2';
    first.emitMessage(smaller);
    target.dispatchEvent(new CustomEvent(CONFIG_EVENT_NAME, { detail: { kind: 'main-config-ack', revision: 'r2' } }));
    target.dispatchEvent(new CustomEvent(CAPTURE_EVENT_NAME, { detail: frames.at(-1) }));
    await vi.advanceTimersByTimeAsync(1);
    const sentFrames = forwarded.filter((message): message is { kind: 'capture-frame'; frame: CaptureFrame } =>
      typeof message === 'object' && message !== null && (message as { kind?: string }).kind === 'capture-frame');
    expect(sentFrames.at(-1)?.frame.type).toBe('end');
    cleanup();
  });
});