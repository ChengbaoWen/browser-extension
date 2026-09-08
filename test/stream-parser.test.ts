import { describe, it, expect } from 'vitest';
import { createStreamParser } from '../src/parser/stream-parser';

describe('StreamParser (Deep Module)', () => {
  it('extracts prompt messages and model from OpenAI formatted request body', () => {
    const parser = createStreamParser({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      transport: 'fetch',
      requestContentType: 'application/json',
      requestBodyText: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Explain quantum computing.' }
        ]
      })
    });

    expect(parser.startEvent.type).toBe('AI_HOOK_START');
    expect(parser.startEvent.model).toBe('gpt-4o');
    expect(parser.startEvent.prompts).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Explain quantum computing.' }
    ]);
  });

  it('correctly buffers and frames SSE stream chunks across network packet splits', () => {
    const parser = createStreamParser({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      transport: 'fetch'
    });

    parser.setResponseMeta('text/event-stream; charset=utf-8', 200);

    // Chunk split across SSE line boundaries
    const chunk1 = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":';
    const chunk2 = '[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n';

    const events1 = parser.feed(chunk1);
    expect(events1).toHaveLength(1);
    expect(events1[0].delta).toBe('Hello');
    expect(events1[0].response).toBe('Hello');

    const events2 = parser.feed(chunk2);
    expect(events2).toHaveLength(1);
    expect(events2[0].delta).toBe(' world');
    expect(events2[0].response).toBe('Hello world');

    const finishEvents = parser.flush();
    expect(finishEvents).toHaveLength(1);
    expect(finishEvents[0].type).toBe('AI_HOOK_END');
    expect(finishEvents[0].status).toBe('completed');
    expect(finishEvents[0].response).toBe('Hello world');
  });

  it('parses Claude content_block_delta stream events', () => {
    const parser = createStreamParser({
      url: 'https://claude.ai/api/chat',
      method: 'POST',
      transport: 'fetch'
    });

    parser.setResponseMeta('text/event-stream', 200);

    const chunk = `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude reply"}}\n\n`;
    const events = parser.feed(chunk);

    expect(events).toHaveLength(1);
    expect(events[0].delta).toBe('Claude reply');
    expect(events[0].response).toBe('Claude reply');

    const endEvents = parser.flush();
    expect(endEvents[0].response).toBe('Claude reply');
    expect(endEvents[0].status).toBe('completed');
  });

  it('handles non-streaming JSON responses via feedJson', () => {
    const parser = createStreamParser({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      transport: 'fetch'
    });

    parser.setResponseMeta('application/json', 200);
    parser.feedJson({
      model: 'gpt-3.5-turbo',
      choices: [{ message: { role: 'assistant', content: 'Single JSON response' } }]
    });

    const endEvents = parser.flush();
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0].type).toBe('AI_HOOK_END');
    expect(endEvents[0].response).toBe('Single JSON response');
    expect(endEvents[0].model).toBe('gpt-3.5-turbo');
    expect(endEvents[0].status).toBe('completed');
  });

  it('falls back gracefully on unknown raw text streams', () => {
    const parser = createStreamParser({
      url: 'https://custom-ai.org/stream',
      method: 'POST',
      transport: 'fetch'
    });

    parser.setResponseMeta('text/plain', 200);
    const events = parser.feed('Raw stream text');
    expect(events).toHaveLength(1);
    expect(events[0].delta).toBe('Raw stream text');
    expect(events[0].response).toBe('Raw stream text');

    const end = parser.flush();
    expect(end[0].status).toBe('completed');
    expect(end[0].response).toBe('Raw stream text');
  });

  it('emits error events on stream failure', () => {
    const parser = createStreamParser({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      transport: 'fetch'
    });

    parser.setResponseMeta('text/event-stream', 500);
    const errorEvent = parser.fail(new Error('Network disconnected'));

    expect(errorEvent.type).toBe('AI_HOOK_ERROR');
    expect(errorEvent.error).toBe('Network disconnected');
    expect(errorEvent.status).toBe('error');
  });
});
