import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capture } from '../../src/capture/capture';
import { installWebSocketCapture } from '../../src/capture/websocket-capture';

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly protocol = '';
  readonly extensions = '';
  readonly readyState = FakeWebSocket.OPEN;
  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView) {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('location', new URL('http://page.example/app'));
  vi.stubGlobal('window', { WebSocket: FakeWebSocket });
});
afterEach(() => vi.unstubAllGlobals());

describe('WebSocket capture', () => {
  it('serializes async messages and permanently stops payload capture at the connection limit', async () => {
    const captures: Capture[] = [];
    let limits = { maxMessageBytes: 10, maxConnectionBytes: 4 };
    const cleanup = installWebSocketCapture({
      match: () => ({ matchedRuleId: 'rule', configRevision: 'r1' }),
      emit: (capture) => captures.push(capture),
      limits: () => limits,
    });
    const socket = new window.WebSocket('wss://api.example/socket');
    limits = { maxMessageBytes: 1, maxConnectionBytes: 1 };
    socket.send('abc');
    socket.send(new Blob(['de']));
    socket.send('x');

    await vi.waitFor(() => expect(captures.filter((capture) => capture.kind === 'websocket-message')).toHaveLength(3));
    const messages = captures.filter((capture) => capture.kind === 'websocket-message');
    expect(messages.map((capture) => capture.kind === 'websocket-message' ? capture.sequence : 0)).toEqual([1, 2, 3]);
    expect(messages.map((capture) => capture.kind === 'websocket-message' ? capture.body.state : '')).toEqual([
      'captured', 'unavailable', 'unavailable',
    ]);
    cleanup();
  });
});