import { describe, expect, it } from 'vitest';
import bundled from '../../src/config/system-config.json';
import { parseSystemConfig } from '../../src/config/config-contract';
import { createConfigProjections } from '../../src/config/config-projections';
import { createConfigManager } from '../../src/config/config-manager';
import { DEFAULT_SAFETY_POLICY } from '../../src/config/safety-policy';

describe('SystemConfig', () => {
  it('includes the supported web AI chat endpoints', () => {
    expect(bundled.capture.endpoints).toEqual(expect.arrayContaining([
      {
        id: 'deepseek-web-chat',
        hosts: [{
          schemes: ['https'],
          host: 'chat.deepseek.com',
          paths: [{ match: 'exact', value: '/api/v0/chat/completion' }],
        }],
      },
      {
        id: 'chatgpt-web-conversation',
        hosts: [{
          schemes: ['https'],
          host: 'chatgpt.com',
          paths: [{ match: 'exact', value: '/backend-api/f/conversation' }],
        }],
      },
      {
        id: 'dola-web-chat',
        hosts: [{
          schemes: ['https'],
          host: 'www.dola.com',
          paths: [{ match: 'exact', value: '/chat/completion' }],
        }],
      },
      {
        id: 'gemini-web-chat',
        hosts: [{
          schemes: ['https'],
          host: 'gemini.google.com',
          paths: [{ match: 'exact', value: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate' }],
        }],
      },
    ]));
  });

  it('rejects ambiguous path patterns and excessive expanded rules', () => {
    const ambiguous = structuredClone(bundled) as Record<string, any>;
    ambiguous.capture.endpoints[0].hosts[0].paths[0] = { match: 'exact', value: '/v1/*' };
    expect(() => parseSystemConfig(ambiguous, DEFAULT_SAFETY_POLICY, bundled.issuedAt)).toThrow(/only for glob/);

    const excessive = structuredClone(bundled) as Record<string, any>;
    excessive.capture.endpoints = [{
      id: 'too-many',
      hosts: [{
        schemes: ['http', 'https', 'ws', 'wss'],
        host: 'api.example.com',
        paths: Array.from({ length: 65 }, (_, index) => ({ match: 'exact', value: `/v${index}` })),
      }],
    }];
    expect(() => parseSystemConfig(excessive, DEFAULT_SAFETY_POLICY, bundled.issuedAt)).toThrow(/expand to at most 256/);
  });

  it('enables capture from config and applies local consent only to delivery', () => {
    const config = parseSystemConfig(bundled, DEFAULT_SAFETY_POLICY, bundled.issuedAt);
    const projections = createConfigProjections(config, { deliveryEnabled: false });
    expect(projections.main.enabled).toBe(true);
    expect(projections.delivery.enabled).toBe(false);
  });

  it('rejects unknown fields and clamps configured limits', () => {
    const candidate = structuredClone(bundled) as Record<string, any>;
    candidate.capture.http.maxBodyBytes = Number.MAX_SAFE_INTEGER;
    const parsed = parseSystemConfig(candidate, DEFAULT_SAFETY_POLICY, bundled.issuedAt);
    expect(parsed.capture.http.maxBodyBytes).toBe(DEFAULT_SAFETY_POLICY.captureLimits.maxHttpBodyBytes);
    candidate.unexpected = true;
    expect(() => parseSystemConfig(candidate, DEFAULT_SAFETY_POLICY, bundled.issuedAt)).toThrow(/unknown/);
  });

  it('falls back to the next valid source and then to safe-disabled', async () => {
    const manager = createConfigManager({
      sources: [
        { name: 'remote', load: async () => ({ invalid: true }) },
        { name: 'bundled', load: async () => bundled },
      ],
      consent: { load: async () => ({ deliveryEnabled: false }) },
      safetyPolicy: DEFAULT_SAFETY_POLICY,
      now: () => bundled.issuedAt,
    });
    expect((await manager.initialize())?.revision).toBe(bundled.revision);
    expect(manager.projections()?.main.enabled).toBe(true);
    expect(manager.projection('main')?.revision).toBe(bundled.revision);

    const safe = createConfigManager({
      sources: [{ name: 'remote', load: async () => { throw new Error('offline'); } }],
      consent: { load: async () => ({ deliveryEnabled: true }) },
      safetyPolicy: DEFAULT_SAFETY_POLICY,
      now: () => bundled.issuedAt,
    });
    expect((await safe.initialize())?.capture.enabled).toBe(false);
    expect(safe.projections()?.delivery.enabled).toBe(false);
  });

  it('returns deeply immutable snapshots and rejects oversized input', () => {
    const parsed = parseSystemConfig(bundled, DEFAULT_SAFETY_POLICY, bundled.issuedAt);
    expect(Object.isFrozen(parsed.capture.http)).toBe(true);
    expect(Object.isFrozen(parsed.capture.endpoints[0])).toBe(true);
    const oversized = structuredClone(bundled) as Record<string, any>;
    oversized.revision = 'x'.repeat(1024 * 1024);
    expect(() => parseSystemConfig(oversized, DEFAULT_SAFETY_POLICY, bundled.issuedAt)).toThrow(/maximum serialized size/);
  });
});