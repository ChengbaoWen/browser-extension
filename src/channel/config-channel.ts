import type { IsolatedChannelConfig, MainCaptureConfig } from '../config/config-projections';

export const CONFIG_EVENT_NAME = '__NETWORK_CAPTURE_CONFIG_V1__';
export const CONFIG_REQUEST_EVENT_NAME = '__NETWORK_CAPTURE_CONFIG_REQUEST_V1__';
export const CAPTURE_PORT_NAME = 'network-capture-v1';

export interface ConfigEnvelope {
  kind: 'config';
  revision: string;
  main: MainCaptureConfig;
  isolated: IsolatedChannelConfig;
}

export interface ConfigAck {
  kind: 'config-ack';
  revision: string;
}

export interface MainConfigEnvelope {
  kind: 'main-config';
  revision: string;
  config: MainCaptureConfig;
}

export function isConfigEnvelope(value: unknown): value is ConfigEnvelope {
  return parseConfigEnvelope(value) !== null;
}

export function parseConfigEnvelope(value: unknown): ConfigEnvelope | null {
  if (!isExactObject(value, ['kind', 'revision', 'main', 'isolated']) || value.kind !== 'config' || !nonEmptyString(value.revision)) return null;
  if (!isMainConfig(value.main, value.revision) || !isIsolatedConfig(value.isolated, value.revision)) return null;
  return deepFreeze(structuredClone(value)) as unknown as ConfigEnvelope;
}

export function parseMainConfigEnvelope(value: unknown): MainConfigEnvelope | null {
  if (!isExactObject(value, ['kind', 'revision', 'config']) || value.kind !== 'main-config' || !nonEmptyString(value.revision)) return null;
  if (!isMainConfig(value.config, value.revision)) return null;
  return deepFreeze(structuredClone(value)) as unknown as MainConfigEnvelope;
}

export function installMainConfigReceiver(options: {
  target: EventTarget;
  activate(config: MainCaptureConfig): void;
}): () => void {
  const listener = (event: Event) => {
    const value = (event as CustomEvent<unknown>).detail;
    const envelope = parseMainConfigEnvelope(value);
    if (!envelope) return;
    options.activate(envelope.config);
    options.target.dispatchEvent(new CustomEvent(CONFIG_EVENT_NAME, {
      detail: { kind: 'main-config-ack', revision: envelope.revision },
    }));
  };
  options.target.addEventListener(CONFIG_EVENT_NAME, listener);
  options.target.dispatchEvent(new CustomEvent(CONFIG_REQUEST_EVENT_NAME));
  return () => options.target.removeEventListener(CONFIG_EVENT_NAME, listener);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}

function isMainConfig(value: unknown, revision: string): value is MainCaptureConfig {
  if (!isExactObject(value, ['revision', 'enabled', 'channelMaxFrameBytes', 'endpoints', 'http', 'sse', 'websocket'])) return false;
  if (value.revision !== revision || typeof value.enabled !== 'boolean' || !positiveInteger(value.channelMaxFrameBytes)) return false;
  if (!Array.isArray(value.endpoints) || value.endpoints.length > 256 || !value.endpoints.every(isEndpoint)) return false;
  const compiledRuleCount = value.endpoints.reduce((count, endpoint) => count + endpointCombinationCount(endpoint), 0);
  if (compiledRuleCount > 256) return false;
  if (!isExactObject(value.http, ['enabled', 'captureRequestBody', 'captureResponseBody', 'maxBodyBytes'])) return false;
  if (typeof value.http.enabled !== 'boolean' || typeof value.http.captureRequestBody !== 'boolean' || typeof value.http.captureResponseBody !== 'boolean' || !nonNegativeInteger(value.http.maxBodyBytes)) return false;
  if (!isExactObject(value.sse, ['enabled', 'sources', 'maxEventBytes', 'maxStreamBytes'])) return false;
  if (typeof value.sse.enabled !== 'boolean' || !Array.isArray(value.sse.sources) || !value.sse.sources.every((source) => ['fetch', 'xhr', 'event-source'].includes(String(source))) || !nonNegativeInteger(value.sse.maxEventBytes) || !nonNegativeInteger(value.sse.maxStreamBytes)) return false;
  if (!isExactObject(value.websocket, ['enabled', 'maxMessageBytes', 'maxConnectionBytes'])) return false;
  return typeof value.websocket.enabled === 'boolean' && nonNegativeInteger(value.websocket.maxMessageBytes) && nonNegativeInteger(value.websocket.maxConnectionBytes);
}

function isEndpoint(value: unknown): boolean {
  return isExactObject(value, ['id', 'hosts']) && nonEmptyString(value.id) &&
    Array.isArray(value.hosts) && value.hosts.length > 0 && value.hosts.every(isEndpointHost);
}

function isEndpointHost(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (!keys.every((key) => ['schemes', 'host', 'port', 'paths'].includes(key)) || !['schemes', 'host', 'paths'].every((key) => key in value)) return false;
  return nonEmptyString(value.host) && /^[a-z0-9.-]+$/i.test(value.host) &&
    Array.isArray(value.schemes) && value.schemes.length > 0 && value.schemes.every((scheme) => ['http', 'https', 'ws', 'wss'].includes(String(scheme))) &&
    Array.isArray(value.paths) && value.paths.length > 0 && value.paths.every(isEndpointPath) &&
    (value.port === undefined || (positiveInteger(value.port) && value.port <= 65_535));
}

function isEndpointPath(value: unknown): boolean {
  if (!isExactObject(value, ['match', 'value']) || !nonEmptyString(value.value) || !value.value.startsWith('/')) return false;
  if (value.value.includes('?') || value.value.includes('#')) return false;
  if (!['exact', 'prefix', 'suffix', 'contains', 'glob'].includes(String(value.match))) return false;
  return value.match === 'glob' ? value.value.includes('*') : !value.value.includes('*');
}

function endpointCombinationCount(value: unknown): number {
  if (!isObject(value) || !Array.isArray(value.hosts)) return 0;
  return value.hosts.reduce((count, host) => {
    if (!isObject(host) || !Array.isArray(host.schemes) || !Array.isArray(host.paths)) return count;
    return count + host.schemes.length * host.paths.length;
  }, 0);
}

function isIsolatedConfig(value: unknown, revision: string): value is IsolatedChannelConfig {
  if (!isExactObject(value, ['revision', 'maxFrameBytes', 'maxQueuedFrames', 'maxQueuedBytes', 'reconnectInitialDelayMs', 'reconnectMaxDelayMs'])) return false;
  return value.revision === revision && positiveInteger(value.maxFrameBytes) && positiveInteger(value.maxQueuedFrames) && positiveInteger(value.maxQueuedBytes) &&
    positiveInteger(value.reconnectInitialDelayMs) && positiveInteger(value.reconnectMaxDelayMs) && value.reconnectInitialDelayMs <= value.reconnectMaxDelayMs;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}