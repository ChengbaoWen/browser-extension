import { describe, expect, it } from 'vitest';
import { createSseFramer } from '../../src/capture/sse-framer';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('createSseFramer', () => {
  it('preserves raw LF-delimited event bytes across network chunks', () => {
    const framer = createSseFramer();
    const first = framer.push(encoder.encode('data: one\n\ndata: tw'));
    expect(first.map((event) => decoder.decode(event))).toEqual(['data: one\n\n']);
    const events = framer.push(encoder.encode('o\n\n'));
    expect(events.map((event) => decoder.decode(event))).toEqual(['data: two\n\n']);
    expect(framer.finish()).toEqual({ events: [], incomplete: null });
  });

  it('supports CRLF and reports an incomplete tail without inventing an event', () => {
    const framer = createSseFramer();
    const events = framer.push(encoder.encode('event: token\r\ndata: x\r\n\r\ndata: partial'));
    expect(events.map((event) => decoder.decode(event))).toEqual(['event: token\r\ndata: x\r\n\r\n']);
    const result = framer.finish();
    expect(result.events).toEqual([]);
    expect(decoder.decode(result.incomplete!)).toBe('data: partial');
  });
});