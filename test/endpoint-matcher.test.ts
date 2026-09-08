import { describe, it, expect } from 'vitest';
import {
  matchEndpoint,
  shouldInterceptUrl,
  DEFAULT_PROVIDER_RULES,
  DEFAULT_FILTER_CONFIG
} from '../src/matcher/endpoint-matcher';

describe('EndpointMatcher (Deep Module)', () => {
  it('matches ChatGPT endpoint with wildcard pattern', () => {
    const url = 'https://chatgpt.com/backend-api/conversation';
    const result = matchEndpoint(url, DEFAULT_PROVIDER_RULES);
    expect(result.matched).toBe(true);
    expect(result.provider).toBe('ChatGPT');
  });

  it('matches Claude conversations with organization wildcard', () => {
    const url = 'https://claude.ai/api/organizations/123e4567-e89b-12d3-a456-426614174000/chat_conversations';
    const result = matchEndpoint(url, DEFAULT_PROVIDER_RULES);
    expect(result.matched).toBe(true);
    expect(result.provider).toBe('Claude');
  });

  it('matches OpenAI /v1/chat/completions on custom host', () => {
    const url = 'https://my-custom-proxy.internal/v1/chat/completions?stream=true';
    const result = matchEndpoint(url, DEFAULT_PROVIDER_RULES);
    expect(result.matched).toBe(true);
    expect(result.provider).toBe('OpenAI');
  });

  it('matches DeepSeek chat completion', () => {
    const url = 'https://chat.deepseek.com/api/v0/chat/completion';
    const result = matchEndpoint(url, DEFAULT_PROVIDER_RULES);
    expect(result.matched).toBe(true);
    expect(result.provider).toBe('DeepSeek');
  });

  it('does not match unrelated URLs in whitelist mode', () => {
    const url = 'https://www.google.com/search?q=test';
    const result = shouldInterceptUrl(url, DEFAULT_FILTER_CONFIG);
    expect(result.intercept).toBe(false);
  });

  it('intercepts all URLs when mode is set to "all"', () => {
    const url = 'https://unknown-ai-service.com/api/chat';
    const result = shouldInterceptUrl(url, {
      mode: 'all',
      rules: DEFAULT_PROVIDER_RULES
    });
    expect(result.intercept).toBe(true);
    expect(result.provider).toBe('generic-raw');
  });

  it('respects disabled rules', () => {
    const disabledRules = DEFAULT_PROVIDER_RULES.map((r) =>
      r.provider === 'ChatGPT' ? { ...r, enabled: false } : r
    );
    const result = matchEndpoint('https://chatgpt.com/backend-api/conversation', disabledRules);
    expect(result.matched).toBe(false);
  });

  it('matches custom regex pattern', () => {
    const customRules = [
      {
        id: 'custom_1',
        provider: 'CustomBot',
        urlPattern: '/api\\/v[12]\\/chat/i',
        enabled: true
      }
    ];
    const match = matchEndpoint('https://example.com/api/v2/chat', customRules);
    expect(match.matched).toBe(true);
    expect(match.provider).toBe('CustomBot');
  });
});
