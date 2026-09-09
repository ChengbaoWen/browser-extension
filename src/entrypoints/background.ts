import { CAPTURE_PORT_NAME, type ConfigEnvelope } from '../channel/config-channel';
import { parseCaptureFrame } from '../capture/capture-frame';
import { BundledConfigSource } from '../config/bundled-config-source';
import { createConfigManager } from '../config/config-manager';
import { saveDebugUiConfig } from '../config/config-projection-store';
import { ChromeLocalConsentSource, LOCAL_CONSENT_STORAGE_KEY } from '../config/local-consent';
import { DEFAULT_SAFETY_POLICY } from '../config/safety-policy';
import { createDelivery } from '../delivery/delivery';
import { createHttpDeliveryTransport } from '../delivery/http-delivery';
import { createCaptureStore } from '../storage/capture-store';
import { appendDiagnostic, type DiagnosticArea, type DiagnosticLevel } from '../storage/diagnostic-store';

export default defineBackground(() => {
  let initialization: Promise<void> | null = null;
  const ports = new Set<chrome.runtime.Port>();
  const ackTimers = new Map<chrome.runtime.Port, ReturnType<typeof setTimeout>>();
  const manager = createConfigManager({
    sources: [new BundledConfigSource()],
    consent: new ChromeLocalConsentSource(),
    safetyPolicy: DEFAULT_SAFETY_POLICY,
  });
  const store = createCaptureStore({
    config: () => manager.projections()?.storage ?? {
      revision: 'bootstrap', warningBytes: 384 * 1024 * 1024,
      hardLimitBytes: 512 * 1024 * 1024, draftTtlMs: 86_400_000,
    },
    onDiagnostic: (code, message) => { void reportDiagnostic('storage', 'warn', code, message); },
  });
  const delivery = createDelivery({
    queue: store,
    config: () => manager.projections()?.delivery ?? {
      revision: 'bootstrap', enabled: false, endpoint: null,
      batchSize: 50, flushIntervalMs: 60_000, timeoutMs: 15_000,
    },
    transport: createHttpDeliveryTransport,
  });

  const envelope = (): ConfigEnvelope | null => {
    const projections = manager.projections();
    if (!projections) return null;
    return { kind: 'config', revision: projections.main.revision, main: projections.main, isolated: projections.isolated };
  };

  manager.subscribe(() => { void applyActiveConfig(); });
  void initialize();
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  function initialize(): Promise<void> {
    initialization ??= (async () => {
      await manager.initialize();
      await store.cleanup();
      scheduleConfigRefresh();
    })().catch((error) => {
      initialization = null;
      console.error('[Background] initialization failed', error);
      throw error;
    });
    return initialization;
  }

  async function applyActiveConfig() {
    const debugUi = manager.projection('debugUi');
    if (debugUi) await saveDebugUiConfig(debugUi);
    scheduleDelivery();
    for (const port of ports) sendConfig(port);
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== CAPTURE_PORT_NAME) return;
    ports.add(port);
    port.onMessage.addListener((message: unknown) => {
      if (isObject(message) && message.kind === 'config-request') {
        sendConfig(port);
        return;
      }
      if (isObject(message) && message.kind === 'config-ack' && typeof message.revision === 'string') {
        const value = envelope();
        if (value?.revision === message.revision) clearAckTimer(port);
        return;
      }
      if (isDiagnosticMessage(message)) {
        void reportDiagnostic(message.area, message.level, message.code, message.message, message.occurredAt);
        return;
      }
      if (!isObject(message) || message.kind !== 'capture-frame') return;
      const maxBytes = manager.projections()?.isolated.maxFrameBytes ?? 64 * 1024;
      const frame = parseCaptureFrame(message.frame, maxBytes);
      if (frame) void store.ingest(frame)
        .then(() => store.cleanup())
        .catch((error) => { void reportDiagnostic('storage', 'warn', 'frame-rejected', errorMessage(error)); });
    });
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      clearAckTimer(port);
    });
    void initialize().then(() => sendConfig(port));
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'capture-delivery') void delivery.flush().then((result) => {
      if (result.status === 'failed') void reportDiagnostic('delivery', 'warn', 'flush-failed', errorMessage(result.error));
    });
    if (alarm.name === 'capture-config-refresh') void manager.reload().catch((error) => { void reportDiagnostic('config', 'warn', 'refresh-failed', errorMessage(error)); });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && LOCAL_CONSENT_STORAGE_KEY in changes) {
      void manager.reload().catch((error) => { void reportDiagnostic('config', 'warn', 'consent-refresh-failed', errorMessage(error)); });
    }
  });

  function sendConfig(port: chrome.runtime.Port) {
    const value = envelope();
    if (!value) return;
    try {
      port.postMessage(value);
      clearAckTimer(port);
      ackTimers.set(port, setTimeout(() => {
        ackTimers.delete(port);
        if (ports.has(port)) sendConfig(port);
      }, 1_000));
    } catch (error) {
      console.warn('[Channel] config publish failed', error);
    }
  }

  function clearAckTimer(port: chrome.runtime.Port) {
    const timer = ackTimers.get(port);
    if (timer) clearTimeout(timer);
    ackTimers.delete(port);
  }

  function scheduleDelivery() {
    const config = manager.projections()?.delivery;
    if (!config?.enabled) {
      void chrome.alarms.clear('capture-delivery');
      return;
    }
    chrome.alarms.create('capture-delivery', { periodInMinutes: Math.max(config.flushIntervalMs / 60_000, 0.5) });
  }

  function scheduleConfigRefresh() {
    chrome.alarms.create('capture-config-refresh', { periodInMinutes: 60 });
  }

  async function reportDiagnostic(area: DiagnosticArea, level: DiagnosticLevel, code: string, message: string, occurredAt = Date.now()) {
    const config = manager.projection('observability');
    if (!config) return;
    if (levelEnabled(level, config.logLevel)) console[level](`[${area}] ${code}: ${message}`);
    await appendDiagnostic({ id: crypto.randomUUID(), occurredAt, area, level, code, message }, config.retainDiagnostics);
  }
});

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function isDiagnosticMessage(value: unknown): value is { area: DiagnosticArea; level: DiagnosticLevel; code: string; message: string; occurredAt: number } {
  if (!isObject(value) || value.kind !== 'diagnostic') return false;
  return value.area === 'channel' && value.level === 'warn' && typeof value.code === 'string' &&
    typeof value.message === 'string' && typeof value.occurredAt === 'number';
}

function levelEnabled(level: DiagnosticLevel, configured: DiagnosticLevel): boolean {
  const rank: Record<DiagnosticLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
  return rank[level] <= rank[configured];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
