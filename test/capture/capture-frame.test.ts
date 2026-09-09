import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '../../src/capture/bytes';
import { captureToFrames, parseCaptureFrame } from '../../src/capture/capture-frame';
import type { HttpRequestCapture, SseEventCapture } from '../../src/capture/capture';

function requestCapture(): HttpRequestCapture {
  const bytes = new TextEncoder().encode('abcdef');
  return {
    kind: 'http-request', id: 'capture-1', exchangeId: 'exchange-1', capturedAt: 1,
    pageUrl: 'https://page.example', matchedRuleId: 'rule-1', configRevision: 'revision-1',
    url: 'https://api.example/v1', transport: 'fetch',
    httpVersion: { value: 'unknown', source: 'unavailable' }, method: 'POST',
    headers: { state: 'captured', visibility: 'script-visible', entries: [] },
    body: { state: 'captured', encoding: 'base64', byteLength: bytes.byteLength, data: bytesToBase64(bytes) },
  };
}

describe('CaptureFrame', () => {
  it('splits captured bodies into ordered validated frames', () => {
    const frames = captureToFrames(requestCapture(), 2);
    expect(frames.map((frame) => frame.type)).toEqual(['start', 'chunk', 'chunk', 'chunk', 'end']);
    expect(frames.map((frame) => frame.frameSequence)).toEqual([0, 1, 2, 3, 4]);
    expect(frames.every((frame) => parseCaptureFrame(frame, 2) !== null)).toBe(true);
  });

  it('rejects forged byte lengths and oversized chunks', () => {
    const frame = captureToFrames(requestCapture(), 6)[1];
    expect(frame.type).toBe('chunk');
    expect(parseCaptureFrame({ ...frame, byteLength: 7 }, 6)).toBeNull();
    expect(parseCaptureFrame(frame, 5)).toBeNull();
  });

  it('rejects descriptors whose identity does not match the frame envelope', () => {
    const start = captureToFrames(requestCapture(), 6)[0];
    expect(start.type).toBe('start');
    expect(parseCaptureFrame({ ...start, captureId: 'forged' })).toBeNull();
    if (start.type !== 'start') throw new Error('Expected start frame');
    const malformed = structuredClone(start) as Record<string, any>;
    delete malformed.descriptor.capture.url;
    expect(parseCaptureFrame(malformed)).toBeNull();
    expect(parseCaptureFrame({ ...start, unexpected: true })).toBeNull();
  });

  it('accepts decoded text projection SSE events across the channel', () => {
    const bytes = new TextEncoder().encode('data: hello\n\n');
    const capture: SseEventCapture = {
      kind: 'sse-event', id: 'event-1', streamId: 'stream-1', exchangeId: 'exchange-1',
      capturedAt: 1, pageUrl: 'https://page.example', matchedRuleId: 'rule-1', configRevision: 'revision-1',
      url: 'https://api.example/events', source: 'xhr', fidelity: 'decoded-text-projection',
      attempt: 1, sequence: 1, eventType: null, lastEventId: null,
      body: { state: 'captured', encoding: 'base64', byteLength: bytes.byteLength, data: bytesToBase64(bytes) },
    };

    expect(captureToFrames(capture, 64).every((frame) => parseCaptureFrame(frame, 64) !== null)).toBe(true);
  });

  it('preserves decoded text Body fidelity in the completion frame', () => {
    const capture = requestCapture();
    if (capture.body.state !== 'captured') throw new Error('Expected captured request Body');
    capture.body = { ...capture.body, fidelity: 'decoded-text-projection' };
    const frames = captureToFrames(capture, 64);
    const end = frames.at(-1);

    expect(end).toMatchObject({
      type: 'end',
      completion: { body: { state: 'captured', fidelity: 'decoded-text-projection' } },
    });
    expect(end && parseCaptureFrame(end, 64)).not.toBeNull();
  });
});