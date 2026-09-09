import { parseCaptureFrame, type CaptureErrorFrame, type CaptureFrame } from '../capture/capture-frame';
import type { IsolatedChannelConfig } from '../config/config-projections';
import { CAPTURE_EVENT_NAME } from './main-capture-channel';
import { CAPTURE_PORT_NAME, CONFIG_EVENT_NAME, CONFIG_REQUEST_EVENT_NAME, parseConfigEnvelope, type ConfigEnvelope } from './config-channel';

const DEFAULT_POLICY: IsolatedChannelConfig = {
  revision: 'bootstrap', maxFrameBytes: 64 * 1024, maxQueuedFrames: 512,
  maxQueuedBytes: 8 * 1024 * 1024, reconnectInitialDelayMs: 250, reconnectMaxDelayMs: 10_000,
};
const CONTROL_FRAME_RESERVE_BYTES = 64 * 1024;

export function installIsolatedChannel(options: {
  connect?: () => chrome.runtime.Port;
  eventTarget?: EventTarget;
} = {}): () => void {
  const connect = options.connect ?? (() => chrome.runtime.connect({ name: CAPTURE_PORT_NAME }));
  const target = options.eventTarget ?? window;
  let policy = DEFAULT_POLICY;
  let envelope: ConfigEnvelope | null = null;
  let port: chrome.runtime.Port | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = policy.reconnectInitialDelayMs;
  let stopped = false;
  const queue: CaptureFrame[] = [];
  const diagnostics: Array<{ kind: 'diagnostic'; area: 'channel'; level: 'warn'; code: string; message: string; occurredAt: number }> = [];
  let queuedBytes = 0;
  let queuedControlBytes = 0;

  const post = (message: unknown): boolean => {
    if (!port) return false;
    try {
      port.postMessage(message);
      return true;
    } catch {
      port = null;
      scheduleReconnect();
      return false;
    }
  };

  const flush = () => {
    while (diagnostics.length > 0 && port) {
      if (!post(diagnostics[0])) break;
      diagnostics.shift();
    }
    while (queue.length > 0 && port) {
      const frame = queue[0]!;
      if (!post({ kind: 'capture-frame', frame })) break;
      queue.shift();
      if (frame.type === 'chunk') queuedBytes -= frame.byteLength;
      else queuedControlBytes -= controlFrameBytes(frame);
    }
  };

  const enqueue = (frame: CaptureFrame) => {
    if (post({ kind: 'capture-frame', frame })) return;
    const bodyBytes = frame.type === 'chunk' ? frame.byteLength : 0;
    const controlBytes = frame.type === 'chunk' ? 0 : controlFrameBytes(frame);
    if (!fits(frame, bodyBytes, controlBytes)) {
      const terminatedCaptureId = overflowOldest();
      if (terminatedCaptureId === frame.captureId || !fits(frame, bodyBytes, controlBytes)) return;
    }
    queue.push(frame);
    queuedBytes += bodyBytes;
    queuedControlBytes += controlBytes;
  };

  const fits = (frame: CaptureFrame, bodyBytes: number, controlBytes: number) => {
    const terminalControl = frame.type === 'body-unavailable' || frame.type === 'end' || frame.type === 'error';
    if (terminalControl) return queuedControlBytes + controlBytes <= CONTROL_FRAME_RESERVE_BYTES;
    if (queue.length >= policy.maxQueuedFrames || queuedBytes > policy.maxQueuedBytes) return false;
    return queue.length < policy.maxQueuedFrames && queuedBytes + bodyBytes <= policy.maxQueuedBytes && queuedControlBytes + controlBytes <= CONTROL_FRAME_RESERVE_BYTES;
  };

  const overflowOldest = (): string | null => {
    const oldestFrame = queue[0];
    if (!oldestFrame) return null;
    const oldest = oldestFrame.captureId;
    let firstRemovedSequence = Number.POSITIVE_INFINITY;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index]!.captureId !== oldest) continue;
      const removed = queue.splice(index, 1)[0]!;
      firstRemovedSequence = Math.min(firstRemovedSequence, removed.frameSequence);
      if (removed.type === 'chunk') queuedBytes -= removed.byteLength;
      else queuedControlBytes -= controlFrameBytes(removed);
    }
    const error: CaptureErrorFrame = {
      protocolVersion: 1, type: 'error', captureId: oldest,
      frameSequence: Number.isFinite(firstRemovedSequence) ? firstRemovedSequence : 0,
      configRevision: oldestFrame.configRevision, reason: 'channel-overflow',
    };
    queue.push(error);
    queuedControlBytes += controlFrameBytes(error);
    diagnostics.push({
      kind: 'diagnostic', area: 'channel', level: 'warn', code: 'queue-overflow',
      message: `Capture ${oldest} terminated because the channel queue overflowed`, occurredAt: Date.now(),
    });
    if (diagnostics.length > 20) diagnostics.shift();
    return oldest;
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openPort();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, policy.reconnectMaxDelayMs);
  };

  const openPort = () => {
    if (stopped || port) return;
    try {
      const next = connect();
      port = next;
      reconnectDelay = policy.reconnectInitialDelayMs;
      next.onMessage.addListener(onPortMessage);
      next.onDisconnect.addListener(() => {
        if (port === next) port = null;
        scheduleReconnect();
      });
      flush();
      post({ kind: 'config-request' });
    } catch {
      port = null;
      scheduleReconnect();
    }
  };

  const onPortMessage = (value: unknown) => {
    const parsed = parseConfigEnvelope(value);
    if (!parsed) return;
    envelope = parsed;
    publishMainConfig(parsed);
  };
  const onMainAck = (event: Event) => {
    const value = (event as CustomEvent<unknown>).detail;
    if (!isObject(value) || value.kind !== 'main-config-ack' || typeof value.revision !== 'string') return;
    if (!envelope || envelope.revision !== value.revision) return;
    policy = envelope.isolated;
    reconnectDelay = policy.reconnectInitialDelayMs;
    post({ kind: 'config-ack', revision: envelope.revision });
  };
  const onConfigRequest = () => {
    if (envelope) publishMainConfig(envelope);
    else post({ kind: 'config-request' });
  };
  const publishMainConfig = (value: ConfigEnvelope) => {
    target.dispatchEvent(new CustomEvent(CONFIG_EVENT_NAME, {
      detail: { kind: 'main-config', revision: value.revision, config: value.main },
    }));
  };
  const onFrame = (event: Event) => {
    const frame = parseCaptureFrame((event as CustomEvent<unknown>).detail, policy.maxFrameBytes);
    if (frame) enqueue(frame);
  };

  target.addEventListener(CAPTURE_EVENT_NAME, onFrame);
  target.addEventListener(CONFIG_EVENT_NAME, onMainAck);
  target.addEventListener(CONFIG_REQUEST_EVENT_NAME, onConfigRequest);
  openPort();
  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    target.removeEventListener(CAPTURE_EVENT_NAME, onFrame);
    target.removeEventListener(CONFIG_EVENT_NAME, onMainAck);
    target.removeEventListener(CONFIG_REQUEST_EVENT_NAME, onConfigRequest);
    port?.disconnect();
    port = null;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function controlFrameBytes(frame: Exclude<CaptureFrame, { type: 'chunk' }>): number;
function controlFrameBytes(frame: CaptureFrame): number {
  return frame.type === 'chunk' ? 0 : new TextEncoder().encode(JSON.stringify(frame)).byteLength;
}