import type { SafetyPolicy } from './system-config';

export const DEFAULT_SAFETY_POLICY: SafetyPolicy = Object.freeze({
  captureLimits: {
    maxFrameBytes: 64 * 1024,
    maxHttpBodyBytes: 16 * 1024 * 1024,
    maxSseEventBytes: 1024 * 1024,
    maxSseStreamBytes: 64 * 1024 * 1024,
    maxWebSocketMessageBytes: 4 * 1024 * 1024,
    maxWebSocketConnectionBytes: 64 * 1024 * 1024,
  },
  channelLimits: {
    maxQueuedFrames: 512,
    maxQueuedBytes: 8 * 1024 * 1024,
    maxReconnectDelayMs: 10_000,
  },
  storageHardLimitBytes: 512 * 1024 * 1024,
  allowedConfigOrigins: [],
  allowedDeliveryOrigins: [],
});