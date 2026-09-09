import type { EndpointRule, LocalConsent, SystemConfig } from './system-config';

export interface MainCaptureConfig {
  revision: string;
  enabled: boolean;
  channelMaxFrameBytes: number;
  endpoints: EndpointRule[];
  http: SystemConfig['capture']['http'];
  sse: SystemConfig['capture']['sse'];
  websocket: SystemConfig['capture']['websocket'];
}

export type IsolatedChannelConfig = SystemConfig['channel'] & { revision: string };

export type StorageConfig = SystemConfig['storage'] & { revision: string };

export type DeliveryConfig = SystemConfig['delivery'] & { revision: string };

export type DebugUiConfig = SystemConfig['debugUi'] & { revision: string };

export type ObservabilityConfig = SystemConfig['observability'] & { revision: string };

export interface ConfigProjectionMap {
  main: MainCaptureConfig;
  isolated: IsolatedChannelConfig;
  storage: StorageConfig;
  delivery: DeliveryConfig;
  debugUi: DebugUiConfig;
  observability: ObservabilityConfig;
}

export function createConfigProjections(
  config: SystemConfig,
  consent: LocalConsent,
): ConfigProjectionMap {
  return {
    main: {
      revision: config.revision,
      enabled: config.capture.enabled,
      channelMaxFrameBytes: config.channel.maxFrameBytes,
      endpoints: config.capture.endpoints.map((rule) => ({
        id: rule.id,
        hosts: rule.hosts.map((host) => ({
          ...host,
          schemes: [...host.schemes],
          paths: host.paths.map((path) => ({ ...path })),
        })),
      })),
      http: { ...config.capture.http },
      sse: { ...config.capture.sse, sources: [...config.capture.sse.sources] },
      websocket: { ...config.capture.websocket },
    },
    isolated: { revision: config.revision, ...config.channel },
    storage: { revision: config.revision, ...config.storage },
    delivery: {
      revision: config.revision,
      ...config.delivery,
      enabled: config.delivery.enabled && consent.deliveryEnabled,
    },
    debugUi: { revision: config.revision, ...config.debugUi },
    observability: { revision: config.revision, ...config.observability },
  };
}