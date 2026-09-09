import type {
  EndpointHost,
  EndpointPath,
  EndpointRule,
  EndpointScheme,
  PathMatch,
  SafetyPolicy,
  SystemConfig,
} from './system-config';

type JsonObject = Record<string, unknown>;
const MAX_CONFIG_BYTES = 1024 * 1024;

function object(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonObject;
}

function exact(value: JsonObject, keys: string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is unknown`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${path}.${key} is required`);
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function number(value: unknown, path: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new Error(`${path} must be a finite number >= ${min}`);
  }
  return value;
}

function integer(value: unknown, path: string, min = 0): number {
  const result = number(value, path, min);
  if (!Number.isInteger(result)) throw new Error(`${path} must be an integer`);
  return result;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${path} is invalid`);
  }
  return value as T;
}

function parseEndpointPath(value: unknown, path: string): EndpointPath {
  const input = object(value, path);
  exact(input, ['match', 'value'], path);
  const match = enumValue(
    input.match,
    ['exact', 'prefix', 'suffix', 'contains', 'glob'] as const,
    `${path}.match`,
  );
  const pattern = string(input.value, `${path}.value`);
  if (!pattern.startsWith('/')) throw new Error(`${path}.value must start with /`);
  if (pattern.includes('?') || pattern.includes('#')) {
    throw new Error(`${path}.value cannot contain query or fragment`);
  }
  if (match === 'glob' && !pattern.includes('*')) {
    throw new Error(`${path}.value must contain * for glob matching`);
  }
  if (match !== 'glob' && pattern.includes('*')) {
    throw new Error(`${path}.value can contain * only for glob matching`);
  }
  return { match: match as PathMatch, value: pattern };
}

function parseEndpointHost(value: unknown, path: string): EndpointHost {
  const input = object(value, path);
  const allowed = ['schemes', 'host', 'port', 'paths'];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is unknown`);
  }
  for (const key of ['schemes', 'host', 'paths']) {
    if (!(key in input)) throw new Error(`${path}.${key} is required`);
  }
  if (!Array.isArray(input.schemes) || input.schemes.length === 0) {
    throw new Error(`${path}.schemes must be a non-empty array`);
  }
  const schemes = input.schemes.map((scheme, schemeIndex) =>
    enumValue(scheme, ['http', 'https', 'ws', 'wss'] as const, `${path}.schemes[${schemeIndex}]`),
  );
  if (!Array.isArray(input.paths) || input.paths.length === 0) {
    throw new Error(`${path}.paths must be a non-empty array`);
  }
  const paths = input.paths.map((endpointPath, pathIndex) =>
    parseEndpointPath(endpointPath, `${path}.paths[${pathIndex}]`),
  );
  const pathSignatures = new Set<string>();
  for (const endpointPath of paths) {
    const signature = `${endpointPath.match}|${endpointPath.value}`;
    if (pathSignatures.has(signature)) throw new Error(`duplicate endpoint path: ${path}`);
    pathSignatures.add(signature);
  }
  const host = string(input.host, `${path}.host`).toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error(`${path}.host is invalid`);
  const port = input.port === undefined ? undefined : integer(input.port, `${path}.port`, 1);
  if (port !== undefined && port > 65_535) throw new Error(`${path}.port is invalid`);
  return {
    schemes: [...new Set(schemes)] as EndpointScheme[],
    host,
    ...(port === undefined ? {} : { port }),
    paths,
  };
}

function parseEndpointRule(value: unknown, index: number): EndpointRule {
  const path = `capture.endpoints[${index}]`;
  const input = object(value, path);
  exact(input, ['id', 'hosts'], path);
  if (!Array.isArray(input.hosts) || input.hosts.length === 0) {
    throw new Error(`${path}.hosts must be a non-empty array`);
  }
  const hosts = input.hosts.map((host, hostIndex) =>
    parseEndpointHost(host, `${path}.hosts[${hostIndex}]`),
  );
  const hostSignatures = new Set<string>();
  for (const host of hosts) {
    const signature = `${host.host}|${host.port ?? ''}`;
    if (hostSignatures.has(signature)) throw new Error(`duplicate endpoint host: ${host.host}`);
    hostSignatures.add(signature);
  }
  return { id: string(input.id, `${path}.id`), hosts };
}

export function parseSystemConfig(
  value: unknown,
  safety: SafetyPolicy,
  now = Date.now(),
): SystemConfig {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('config must be JSON serializable');
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_CONFIG_BYTES) {
    throw new Error('config exceeds the maximum serialized size');
  }
  const root = object(value, 'config');
  exact(
    root,
    [
      'schemaVersion',
      'revision',
      'issuedAt',
      'expiresAt',
      'capture',
      'channel',
      'storage',
      'delivery',
      'debugUi',
      'observability',
    ],
    'config',
  );
  if (root.schemaVersion !== 1) throw new Error('config.schemaVersion must be 1');
  const issuedAt = integer(root.issuedAt, 'config.issuedAt');
  const expiresAt =
    root.expiresAt === null ? null : integer(root.expiresAt, 'config.expiresAt');
  if (expiresAt !== null && (expiresAt < issuedAt || expiresAt <= now)) {
    throw new Error('config is expired or has an invalid lifetime');
  }

  const capture = object(root.capture, 'capture');
  exact(capture, ['enabled', 'endpoints', 'http', 'sse', 'websocket'], 'capture');
  if (!Array.isArray(capture.endpoints) || capture.endpoints.length > 256) {
    throw new Error('capture.endpoints must contain at most 256 rules');
  }
  const endpoints = capture.endpoints.map(parseEndpointRule);
  const ids = new Set<string>();
  const signatures = new Set<string>();
  let compiledRuleCount = 0;
  for (const rule of endpoints) {
    if (ids.has(rule.id)) throw new Error(`duplicate endpoint id: ${rule.id}`);
    ids.add(rule.id);
    for (const host of rule.hosts) {
      compiledRuleCount += host.schemes.length * host.paths.length;
      for (const scheme of host.schemes) {
        for (const endpointPath of host.paths) {
          const signature = `${scheme}|${host.host}|${host.port ?? ''}|${endpointPath.match}|${endpointPath.value}`;
          if (signatures.has(signature)) throw new Error(`duplicate endpoint rule: ${rule.id}`);
          signatures.add(signature);
        }
      }
    }
  }
  if (compiledRuleCount > 256) throw new Error('capture.endpoints must expand to at most 256 rules');

  const http = object(capture.http, 'capture.http');
  exact(http, ['enabled', 'captureRequestBody', 'captureResponseBody', 'maxBodyBytes'], 'capture.http');
  const sse = object(capture.sse, 'capture.sse');
  exact(sse, ['enabled', 'sources', 'maxEventBytes', 'maxStreamBytes'], 'capture.sse');
  if (!Array.isArray(sse.sources)) throw new Error('capture.sse.sources must be an array');
  const sseSources = sse.sources.map((source, index) =>
    enumValue(source, ['fetch', 'xhr', 'event-source'] as const, `capture.sse.sources[${index}]`),
  );
  const websocket = object(capture.websocket, 'capture.websocket');
  exact(websocket, ['enabled', 'maxMessageBytes', 'maxConnectionBytes'], 'capture.websocket');

  const channel = object(root.channel, 'channel');
  exact(channel, ['maxFrameBytes', 'maxQueuedFrames', 'maxQueuedBytes', 'reconnectInitialDelayMs', 'reconnectMaxDelayMs'], 'channel');
  const storage = object(root.storage, 'storage');
  exact(storage, ['warningBytes', 'hardLimitBytes', 'draftTtlMs'], 'storage');
  const delivery = object(root.delivery, 'delivery');
  exact(delivery, ['enabled', 'endpoint', 'batchSize', 'flushIntervalMs', 'timeoutMs'], 'delivery');
  const debugUi = object(root.debugUi, 'debugUi');
  exact(debugUi, ['refreshIntervalMs', 'pageSize', 'defaultBodyView'], 'debugUi');
  const observability = object(root.observability, 'observability');
  exact(observability, ['logLevel', 'retainDiagnostics'], 'observability');

  const deliveryEndpoint =
    delivery.endpoint === null ? null : string(delivery.endpoint, 'delivery.endpoint');
  if (deliveryEndpoint !== null) {
    const parsed = new URL(deliveryEndpoint);
    if (
      parsed.protocol !== 'https:' ||
      !safety.allowedDeliveryOrigins.includes(parsed.origin)
    ) {
      throw new Error('delivery.endpoint is not allowed');
    }
  }

  const hardLimitBytes = Math.min(
    integer(storage.hardLimitBytes, 'storage.hardLimitBytes', 1),
    safety.storageHardLimitBytes,
  );
  const warningBytes = integer(storage.warningBytes, 'storage.warningBytes', 1);
  if (warningBytes >= hardLimitBytes) {
    throw new Error('storage.warningBytes must be below hardLimitBytes');
  }
  const reconnectInitialDelayMs = integer(channel.reconnectInitialDelayMs, 'channel.reconnectInitialDelayMs', 1);
  const reconnectMaxDelayMs = Math.min(
    integer(channel.reconnectMaxDelayMs, 'channel.reconnectMaxDelayMs', 1),
    safety.channelLimits.maxReconnectDelayMs,
  );
  if (reconnectInitialDelayMs > reconnectMaxDelayMs) {
    throw new Error('channel reconnect delay range is invalid');
  }

  return deepFreeze({
    schemaVersion: 1,
    revision: string(root.revision, 'config.revision'),
    issuedAt,
    expiresAt,
    capture: {
      enabled: boolean(capture.enabled, 'capture.enabled'),
      endpoints,
      http: {
        enabled: boolean(http.enabled, 'capture.http.enabled'),
        captureRequestBody: boolean(http.captureRequestBody, 'capture.http.captureRequestBody'),
        captureResponseBody: boolean(http.captureResponseBody, 'capture.http.captureResponseBody'),
        maxBodyBytes: Math.min(integer(http.maxBodyBytes, 'capture.http.maxBodyBytes'), safety.captureLimits.maxHttpBodyBytes),
      },
      sse: {
        enabled: boolean(sse.enabled, 'capture.sse.enabled'),
        sources: [...new Set(sseSources)],
        maxEventBytes: Math.min(integer(sse.maxEventBytes, 'capture.sse.maxEventBytes'), safety.captureLimits.maxSseEventBytes),
        maxStreamBytes: Math.min(integer(sse.maxStreamBytes, 'capture.sse.maxStreamBytes'), safety.captureLimits.maxSseStreamBytes),
      },
      websocket: {
        enabled: boolean(websocket.enabled, 'capture.websocket.enabled'),
        maxMessageBytes: Math.min(integer(websocket.maxMessageBytes, 'capture.websocket.maxMessageBytes'), safety.captureLimits.maxWebSocketMessageBytes),
        maxConnectionBytes: Math.min(integer(websocket.maxConnectionBytes, 'capture.websocket.maxConnectionBytes'), safety.captureLimits.maxWebSocketConnectionBytes),
      },
    },
    channel: {
      maxFrameBytes: Math.min(integer(channel.maxFrameBytes, 'channel.maxFrameBytes', 1), safety.captureLimits.maxFrameBytes),
      maxQueuedFrames: Math.min(integer(channel.maxQueuedFrames, 'channel.maxQueuedFrames', 1), safety.channelLimits.maxQueuedFrames),
      maxQueuedBytes: Math.min(integer(channel.maxQueuedBytes, 'channel.maxQueuedBytes', 1), safety.channelLimits.maxQueuedBytes),
      reconnectInitialDelayMs,
      reconnectMaxDelayMs,
    },
    storage: {
      warningBytes,
      hardLimitBytes,
      draftTtlMs: integer(storage.draftTtlMs, 'storage.draftTtlMs', 1),
    },
    delivery: {
      enabled: boolean(delivery.enabled, 'delivery.enabled'),
      endpoint: deliveryEndpoint,
      batchSize: integer(delivery.batchSize, 'delivery.batchSize', 1),
      flushIntervalMs: integer(delivery.flushIntervalMs, 'delivery.flushIntervalMs', 1),
      timeoutMs: integer(delivery.timeoutMs, 'delivery.timeoutMs', 1),
    },
    debugUi: {
      refreshIntervalMs: integer(debugUi.refreshIntervalMs, 'debugUi.refreshIntervalMs', 100),
      pageSize: integer(debugUi.pageSize, 'debugUi.pageSize', 1),
      defaultBodyView: enumValue(debugUi.defaultBodyView, ['hex', 'base64', 'text'] as const, 'debugUi.defaultBodyView'),
    },
    observability: {
      logLevel: enumValue(observability.logLevel, ['error', 'warn', 'info', 'debug'] as const, 'observability.logLevel'),
      retainDiagnostics: integer(observability.retainDiagnostics, 'observability.retainDiagnostics'),
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}