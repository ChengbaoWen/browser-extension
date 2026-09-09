import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capture } from '../../src/capture/capture';
import { createDelivery } from '../../src/delivery/delivery';
import { createBatchId, toDeliveryCapture } from '../../src/delivery/delivery-contract';

const capture: Capture = {
  kind: 'http-error', id: 'capture-1', exchangeId: 'exchange-1', capturedAt: 1,
  pageUrl: 'https://page.example', matchedRuleId: 'rule', configRevision: 'r1',
  url: 'https://api.example/v1', transport: 'fetch', httpVersion: { value: 'unknown', source: 'unavailable' },
  phase: 'response', reason: 'network-error',
};

beforeEach(() => {
  vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '1.0.0' }) } });
});

describe('Delivery', () => {
  it('maps an independent DTO and creates stable endpoint-scoped batch IDs', async () => {
    const internal = { ...capture, internalOnly: 'do-not-send' } as Capture;
    expect(toDeliveryCapture(internal)).not.toHaveProperty('internalOnly');
    const first = await createBatchId('https://delivery.example/v1', ['a', 'b']);
    expect(await createBatchId('https://delivery.example/v2', ['a', 'b'])).toBe(first);
    expect(await createBatchId('https://other.example/v1', ['a', 'b'])).not.toBe(first);
  });

  it('preserves decoded text Body fidelity', () => {
    const response: Capture = {
      kind: 'http-response', id: 'response-1', exchangeId: 'exchange-1', capturedAt: 1,
      pageUrl: 'https://gemini.google.com/app', matchedRuleId: 'gemini-web-chat', configRevision: 'r1',
      url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
      transport: 'xhr', httpVersion: { value: 'unknown', source: 'unavailable' },
      status: 200, statusText: 'OK', headers: { state: 'captured', visibility: 'script-visible', entries: [] },
      body: { state: 'captured', encoding: 'base64', byteLength: 4, data: 'dGVzdA==', fidelity: 'decoded-text-projection' },
    };

    expect(toDeliveryCapture(response)).toMatchObject({
      kind: 'http-response', body: { state: 'captured', fidelity: 'decoded-text-projection' },
    });
  });

  it('does not read or send while disabled', async () => {
    const listPending = vi.fn(async () => [capture]);
    const transport = vi.fn();
    const delivery = createDelivery({
      queue: { listPending, markDelivered: vi.fn() },
      config: () => ({ revision: 'r1', enabled: false, endpoint: null, batchSize: 10, flushIntervalMs: 1000, timeoutMs: 1000 }),
      transport,
    });
    expect(await delivery.flush()).toEqual({ status: 'disabled' });
    expect(listPending).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('coalesces concurrent flushes and confirms only a complete receipt', async () => {
    const markDelivered = vi.fn(async () => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delivery = createDelivery({
      queue: { listPending: vi.fn(async () => [capture]), markDelivered },
      config: () => ({ revision: 'r1', enabled: true, endpoint: 'https://delivery.example/v1', batchSize: 10, flushIntervalMs: 1000, timeoutMs: 5000 }),
      transport: () => ({
        async send(batch) {
          await gate;
          return { schemaVersion: 1, batchId: batch.batchId, acceptedCaptureIds: [capture.id] };
        },
      }),
    });
    const first = delivery.flush();
    const second = delivery.flush();
    release();
    expect(await first).toEqual(await second);
    expect(markDelivered).toHaveBeenCalledOnce();
  });

  it('keeps records pending after partial acceptance', async () => {
    const markDelivered = vi.fn(async () => undefined);
    const delivery = createDelivery({
      queue: { listPending: vi.fn(async () => [capture]), markDelivered },
      config: () => ({ revision: 'r1', enabled: true, endpoint: 'https://delivery.example/v1', batchSize: 10, flushIntervalMs: 1000, timeoutMs: 5000 }),
      transport: () => ({ send: async (batch) => ({ schemaVersion: 1, batchId: batch.batchId, acceptedCaptureIds: [] }) }),
    });
    expect((await delivery.flush()).status).toBe('failed');
    expect(markDelivered).not.toHaveBeenCalled();
  });

  it('returns failed when reading the queue fails', async () => {
    const delivery = createDelivery({
      queue: { listPending: async () => { throw new Error('storage unavailable'); }, markDelivered: vi.fn() },
      config: () => ({ revision: 'r1', enabled: true, endpoint: 'https://delivery.example/v1', batchSize: 10, flushIntervalMs: 1000, timeoutMs: 5000 }),
      transport: vi.fn(),
    });
    expect(await delivery.flush()).toMatchObject({ status: 'failed' });
  });
});