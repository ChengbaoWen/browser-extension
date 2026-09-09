export type EndpointScheme = 'http' | 'https' | 'ws' | 'wss';

export type PathMatch = 'exact' | 'prefix' | 'suffix' | 'contains' | 'glob';

export interface EndpointPath {
  match: PathMatch;
  value: string;
}

export interface EndpointHost {
  schemes: EndpointScheme[];
  host: string;
  port?: number;
  paths: EndpointPath[];
}

export interface EndpointRule {
  id: string;
  hosts: EndpointHost[];
}

export interface SystemConfig {
  schemaVersion: 1;
  revision: string;
  issuedAt: number;
  expiresAt: number | null;
  capture: {
    enabled: boolean;
    endpoints: EndpointRule[];
    http: {
      enabled: boolean;
      captureRequestBody: boolean;
      captureResponseBody: boolean;
      maxBodyBytes: number;
    };
    sse: {
      enabled: boolean;
      sources: Array<'fetch' | 'xhr' | 'event-source'>;
      maxEventBytes: number;
      maxStreamBytes: number;
    };
    websocket: {
      enabled: boolean;
      maxMessageBytes: number;
      maxConnectionBytes: number;
    };
  };
  channel: {
    maxFrameBytes: number;
    maxQueuedFrames: number;
    maxQueuedBytes: number;
    reconnectInitialDelayMs: number;
    reconnectMaxDelayMs: number;
  };
  storage: {
    warningBytes: number;
    hardLimitBytes: number;
    draftTtlMs: number;
  };
  delivery: {
    enabled: boolean;
    endpoint: string | null;
    batchSize: number;
    flushIntervalMs: number;
    timeoutMs: number;
  };
  debugUi: {
    refreshIntervalMs: number;
    pageSize: number;
    defaultBodyView: 'hex' | 'base64' | 'text';
  };
  observability: {
    logLevel: 'error' | 'warn' | 'info' | 'debug';
    retainDiagnostics: number;
  };
}

export interface SafetyPolicy {
  captureLimits: {
    maxFrameBytes: number;
    maxHttpBodyBytes: number;
    maxSseEventBytes: number;
    maxSseStreamBytes: number;
    maxWebSocketMessageBytes: number;
    maxWebSocketConnectionBytes: number;
  };
  channelLimits: {
    maxQueuedFrames: number;
    maxQueuedBytes: number;
    maxReconnectDelayMs: number;
  };
  storageHardLimitBytes: number;
  allowedConfigOrigins: string[];
  allowedDeliveryOrigins: string[];
}

export interface LocalConsent {
  deliveryEnabled: boolean;
}