import type { EndpointMatch } from '../endpoints/endpoint-matcher';
import type { Capture } from './capture';
import type { CaptureFrame } from './capture-frame';
import { captureToFrames } from './capture-frame';
import { installEventSourceAdapter } from './event-source-adapter';
import { installFetchAdapter } from './fetch-adapter';
import { installWebSocketCapture } from './websocket-capture';
import { installXhrAdapter } from './xhr-adapter';

export interface CapturePolicy {
  enabled: boolean;
  channelMaxFrameBytes: number;
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
}

export function installCapture(options: {
  match(url: string, protocol: 'http' | 'websocket'): EndpointMatch;
  emit(frame: CaptureFrame): void;
  policy(): CapturePolicy;
}): () => void {
  const frameBytesByRevision = new Map<string, number>();
  const emit = (capture: Capture) => {
    try {
      const maxFrameBytes = frameBytesByRevision.get(capture.configRevision) ?? options.policy().channelMaxFrameBytes;
      for (const frame of captureToFrames(capture, maxFrameBytes)) options.emit(frame);
    } catch (error) {
      console.warn('[Capture] record dropped', error);
    }
  };
  const match = (url: string, protocol: 'http' | 'websocket') => {
    const config = options.policy();
    if (!config.enabled) return null;
    const result = options.match(url, protocol);
    if (!result.matched) return null;
    frameBytesByRevision.set(result.configRevision, config.channelMaxFrameBytes);
    return { matchedRuleId: result.ruleId, configRevision: result.configRevision };
  };
  const cleanups = [
    installFetchAdapter({
      match: (url) => configProtocol('http') ? match(url, 'http') : null, emit,
      policy: () => ({ ...options.policy().http, sseEnabled: options.policy().sse.enabled && options.policy().sse.sources.includes('fetch'), maxSseEventBytes: options.policy().sse.maxEventBytes, maxSseStreamBytes: options.policy().sse.maxStreamBytes }),
    }),
    installXhrAdapter({
      match: (url) => configProtocol('http') ? match(url, 'http') : null,
      emit,
      policy: () => ({
        ...options.policy().http,
        sseEnabled: options.policy().sse.enabled && options.policy().sse.sources.includes('xhr'),
        maxSseEventBytes: options.policy().sse.maxEventBytes,
        maxSseStreamBytes: options.policy().sse.maxStreamBytes,
      }),
    }),
    installEventSourceAdapter({
      match: (url) => options.policy().sse.enabled && options.policy().sse.sources.includes('event-source') ? match(url, 'http') : null,
      emit,
      limits: () => ({ maxEventBytes: options.policy().sse.maxEventBytes, maxStreamBytes: options.policy().sse.maxStreamBytes }),
    }),
    installWebSocketCapture({ match: (url) => options.policy().websocket.enabled ? match(url, 'websocket') : null, emit, limits: () => ({ maxMessageBytes: options.policy().websocket.maxMessageBytes, maxConnectionBytes: options.policy().websocket.maxConnectionBytes }) }),
  ];
  function configProtocol(protocol: 'http') {
    return protocol === 'http' && options.policy().http.enabled;
  }
  return () => cleanups.reverse().forEach((cleanup) => cleanup());
}