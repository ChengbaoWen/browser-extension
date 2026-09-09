import { parseSystemConfig } from './config-contract';
import { createConfigProjections, type ConfigProjectionMap } from './config-projections';
import type { ConfigSource } from './config-source';
import type { LocalConsentSource } from './local-consent';
import type { SafetyPolicy, SystemConfig } from './system-config';

export interface ConfigRefreshResult {
  status: 'activated' | 'unchanged' | 'retained-current' | 'safe-disabled';
  source: ConfigSource['name'] | 'safe-default';
  revision: string;
}

export interface ConfigManager {
  initialize(): Promise<SystemConfig | null>;
  reload(): Promise<ConfigRefreshResult>;
  current(): SystemConfig | null;
  projection<T extends keyof ConfigProjectionMap>(name: T): ConfigProjectionMap[T] | null;
  projections(): ConfigProjectionMap | null;
  subscribe(listener: (config: SystemConfig | null) => void): () => void;
}

export function createConfigManager(options: {
  sources: ConfigSource[];
  consent: LocalConsentSource;
  safetyPolicy: SafetyPolicy;
  now?: () => number;
}): ConfigManager {
  const now = options.now ?? Date.now;
  let active: SystemConfig | null = null;
  let projections: ConfigProjectionMap | null = null;
  const listeners = new Set<(config: SystemConfig | null) => void>();

  async function choose(): Promise<{ config: SystemConfig; source: ConfigSource['name'] | 'safe-default' }> {
    for (const source of options.sources) {
      try {
        const candidate = parseSystemConfig(await source.load(), options.safetyPolicy, now());
        return { config: candidate, source: source.name };
      } catch (error) {
        console.warn(`[Config] ${source.name} config rejected`, error);
      }
    }
    return { config: createSafeConfig(options.safetyPolicy, now()), source: 'safe-default' };
  }

  async function activate(config: SystemConfig): Promise<void> {
    const consent = await options.consent.load();
    const nextProjections = createConfigProjections(config, consent);
    active = config;
    projections = nextProjections;
    for (const listener of listeners) {
      try {
        listener(config);
      } catch (error) {
        console.warn('[Config] subscriber failed', error);
      }
    }
  }

  return {
    async initialize() {
      const selected = await choose();
      await activate(selected.config);
      return selected.config;
    },
    async reload() {
      const current = active;
      if (current && (current.expiresAt === null || current.expiresAt > now())) {
        const firstSource = options.sources[0];
        if (firstSource) {
          try {
            const candidate = parseSystemConfig(await firstSource.load(), options.safetyPolicy, now());
            if (candidate.revision === current.revision) {
              await activate(candidate);
              return { status: 'unchanged', source: firstSource.name, revision: current.revision };
            }
            await activate(candidate);
            return { status: 'activated', source: firstSource.name, revision: candidate.revision };
          } catch {
            return { status: 'retained-current', source: firstSource.name, revision: current.revision };
          }
        }
      }
      const selected = await choose();
      if (active?.revision === selected.config.revision) {
        return { status: 'unchanged', source: selected.source, revision: selected.config.revision };
      }
      await activate(selected.config);
      return {
        status: selected.source === 'safe-default' ? 'safe-disabled' : 'activated',
        source: selected.source,
        revision: selected.config.revision,
      };
    },
    current: () => active,
    projection: (name) => projections?.[name] ?? null,
    projections: () => projections,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createSafeConfig(safety: SafetyPolicy, issuedAt: number): SystemConfig {
  return {
    schemaVersion: 1,
    revision: `safe-disabled-${issuedAt}`,
    issuedAt,
    expiresAt: null,
    capture: {
      enabled: false,
      endpoints: [],
      http: { enabled: false, captureRequestBody: false, captureResponseBody: false, maxBodyBytes: 0 },
      sse: { enabled: false, sources: [], maxEventBytes: 0, maxStreamBytes: 0 },
      websocket: { enabled: false, maxMessageBytes: 0, maxConnectionBytes: 0 },
    },
    channel: {
      maxFrameBytes: safety.captureLimits.maxFrameBytes,
      maxQueuedFrames: safety.channelLimits.maxQueuedFrames,
      maxQueuedBytes: safety.channelLimits.maxQueuedBytes,
      reconnectInitialDelayMs: 250,
      reconnectMaxDelayMs: safety.channelLimits.maxReconnectDelayMs,
    },
    storage: {
      warningBytes: Math.floor(safety.storageHardLimitBytes * 0.75),
      hardLimitBytes: safety.storageHardLimitBytes,
      draftTtlMs: 86_400_000,
    },
    delivery: { enabled: false, endpoint: null, batchSize: 50, flushIntervalMs: 60_000, timeoutMs: 15_000 },
    debugUi: { refreshIntervalMs: 2_000, pageSize: 100, defaultBodyView: 'text' },
    observability: { logLevel: 'warn', retainDiagnostics: 200 },
  };
}