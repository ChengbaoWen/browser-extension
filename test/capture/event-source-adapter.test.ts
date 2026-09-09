import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capture } from '../../src/capture/capture';
import { installEventSourceAdapter } from '../../src/capture/event-source-adapter';

class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = FakeEventSource.CONNECTING;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

beforeEach(() => {
  vi.stubGlobal('location', new URL('http://page.example/app'));
  vi.stubGlobal('window', { EventSource: FakeEventSource });
});
afterEach(() => vi.unstubAllGlobals());

describe('EventSource adapter', () => {
  it('keeps construction limits and terminates capture at the stream limit', () => {
    const captures: Capture[] = [];
    let limits = { maxEventBytes: 10, maxStreamBytes: 4 };
    const cleanup = installEventSourceAdapter({
      match: () => ({ matchedRuleId: 'rule', configRevision: 'r1' }),
      emit: (capture) => captures.push(capture),
      limits: () => limits,
    });
    const source = new window.EventSource('https://api.example/events');
    limits = { maxEventBytes: 1, maxStreamBytes: 1 };
    source.dispatchEvent(new Event('open'));
    source.dispatchEvent(new MessageEvent('message', { data: 'abc' }));
    source.dispatchEvent(new MessageEvent('message', { data: 'de' }));
    source.dispatchEvent(new Event('open'));

    expect(captures.map((capture) => capture.kind)).toEqual([
      'sse-stream-open', 'sse-event', 'sse-stream-close',
    ]);
    expect(captures[2]).toMatchObject({ outcome: 'limit-exceeded', eventCount: 1, capturedByteLength: 3 });
    cleanup();
  });
});