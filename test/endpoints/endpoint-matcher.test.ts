import { describe, expect, it } from 'vitest';
import bundled from '../../src/config/system-config.json';
import { parseSystemConfig } from '../../src/config/config-contract';
import { DEFAULT_SAFETY_POLICY } from '../../src/config/safety-policy';
import { createEndpointMatcher, type EndpointMatcherConfig } from '../../src/endpoints/endpoint-matcher';

const config: EndpointMatcherConfig = {
  revision: 'revision-1',
  endpoints: [
    {
      id: 'http-api',
      hosts: [
        {
          schemes: ['https'],
          host: 'api.example.com',
          paths: [
            { match: 'exact', value: '/v1/messages' },
            { match: 'prefix', value: '/v2/messages/' },
          ],
        },
        {
          schemes: ['https'],
          host: 'api-alt.example.com',
          paths: [{ match: 'exact', value: '/messages' }],
        },
      ],
    },
    {
      id: 'socket-api',
      hosts: [{ schemes: ['wss'], host: 'socket.example.com', port: 443, paths: [{ match: 'exact', value: '/events' }] }],
    },
  ],
};

describe('createEndpointMatcher', () => {
  it('matches an exact HTTP path and ignores query and fragment', () => {
    const matcher = createEndpointMatcher(config);
    expect(matcher.match('https://API.EXAMPLE.COM/v1/messages?q=1#result', 'http')).toEqual({
      matched: true,
      ruleId: 'http-api',
      configRevision: 'revision-1',
    });
  });

  it('keeps protocol and path boundaries strict', () => {
    const matcher = createEndpointMatcher(config);
    expect(matcher.match('http://api.example.com/v1/messages', 'http')).toEqual({ matched: false });
    expect(matcher.match('https://api.example.com/v1/messages/extra', 'http')).toEqual({ matched: false });
    expect(matcher.match('wss://socket.example.com/events', 'http')).toEqual({ matched: false });
  });

  it('matches multiple hosts and paths within one endpoint rule', () => {
    const matcher = createEndpointMatcher(config);
    expect(matcher.match('https://api.example.com/v2/messages/42', 'http').matched).toBe(true);
    expect(matcher.match('https://api-alt.example.com/messages', 'http')).toMatchObject({ matched: true, ruleId: 'http-api' });
  });

  it('supports explicit suffix, contains, and glob path matching', () => {
    const matcher = createEndpointMatcher({
      revision: 'patterns',
      endpoints: [{
        id: 'patterns',
        hosts: [{
          schemes: ['https'],
          host: 'api.example.com',
          paths: [
            { match: 'suffix', value: '/completion' },
            { match: 'contains', value: '/conversation/' },
            { match: 'glob', value: '/api/*/messages/*' },
          ],
        }],
      }],
    });
    expect(matcher.match('https://api.example.com/v1/chat/completion', 'http').matched).toBe(true);
    expect(matcher.match('https://api.example.com/v1/conversation/42', 'http').matched).toBe(true);
    expect(matcher.match('https://api.example.com/api/v2/messages/42', 'http').matched).toBe(true);
    expect(matcher.match('https://api.example.com/v1/message', 'http').matched).toBe(false);
  });

  it('treats regex metacharacters in glob patterns as literal characters', () => {
    const matcher = createEndpointMatcher({
      revision: 'literal-glob',
      endpoints: [{
        id: 'files',
        hosts: [{
          schemes: ['https'],
          host: 'api.example.com',
          paths: [{ match: 'glob', value: '/files/*.json' }],
        }],
      }],
    });
    expect(matcher.match('https://api.example.com/files/result.json', 'http').matched).toBe(true);
    expect(matcher.match('https://api.example.com/files/resultXjson', 'http').matched).toBe(false);
  });

  it('matches the bundled DeepSeek, ChatGPT, Dola, and Gemini web endpoints', () => {
    const parsed = parseSystemConfig(bundled, DEFAULT_SAFETY_POLICY, bundled.issuedAt);
    const matcher = createEndpointMatcher({ revision: parsed.revision, endpoints: parsed.capture.endpoints });
    expect(matcher.match('https://chat.deepseek.com/api/v0/chat/completion', 'http')).toMatchObject({ matched: true, ruleId: 'deepseek-web-chat' });
    expect(matcher.match('https://chatgpt.com/backend-api/f/conversation', 'http')).toMatchObject({ matched: true, ruleId: 'chatgpt-web-conversation' });
    expect(matcher.match('https://www.dola.com/chat/completion?aid=495671&device_id=123', 'http')).toMatchObject({ matched: true, ruleId: 'dola-web-chat' });
    expect(matcher.match('https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=release&rt=c', 'http')).toMatchObject({ matched: true, ruleId: 'gemini-web-chat' });
  });

  it('normalizes default ports and keeps matcher revisions immutable', () => {
    const matcher = createEndpointMatcher(config);
    config.revision = 'revision-2';
    expect(matcher.match('wss://socket.example.com:443/events', 'websocket')).toEqual({
      matched: true,
      ruleId: 'socket-api',
      configRevision: 'revision-1',
    });
  });

  it('returns an unmatched result for invalid URLs', () => {
    expect(createEndpointMatcher(config).match('not a url', 'http')).toEqual({ matched: false });
  });

  it('normalizes explicit default ports independently for each scheme', () => {
    const matcher = createEndpointMatcher({
      revision: 'ports',
      endpoints: [{
        id: 'both',
        hosts: [{ schemes: ['http', 'https'], host: 'api.example.com', port: 443, paths: [{ match: 'exact', value: '/v1' }] }],
      }],
    });
    expect(matcher.match('https://api.example.com/v1', 'http').matched).toBe(true);
    expect(matcher.match('http://api.example.com/v1', 'http').matched).toBe(false);
  });
});
