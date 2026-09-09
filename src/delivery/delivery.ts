import type { Capture } from '../capture/capture';
import { getClientContext } from './client-context';
import { createBatchId, toDeliveryCapture, type DeliveryBatch, type DeliveryReceipt } from './delivery-contract';
import type { DeliveryTransport } from './http-delivery';

export interface DeliveryQueue {
  listPending(limit: number): Promise<Capture[]>;
  markDelivered(captureIds: string[]): Promise<void>;
}

export type DeliveryResult =
  | { status: 'disabled' | 'empty' | 'in-flight' }
  | { status: 'delivered'; captureIds: string[]; batchId: string }
  | { status: 'failed'; error: unknown };

export interface Delivery {
  flush(): Promise<DeliveryResult>;
}

export interface DeliveryPolicy {
  revision: string;
  enabled: boolean;
  endpoint: string | null;
  batchSize: number;
  flushIntervalMs: number;
  timeoutMs: number;
}

export function createDelivery(options: {
  queue: DeliveryQueue;
  config(): DeliveryPolicy;
  transport(endpoint: string): DeliveryTransport;
  now?: () => number;
}): Delivery {
  let inFlight: Promise<DeliveryResult> | null = null;
  const now = options.now ?? Date.now;

  async function execute(): Promise<DeliveryResult> {
    const config = options.config();
    if (!config.enabled || config.endpoint === null) return { status: 'disabled' };
    try {
      const captures = await options.queue.listPending(config.batchSize);
      if (captures.length === 0) return { status: 'empty' };
      const captureIds = captures.map((capture) => capture.id);
      const batchId = await createBatchId(config.endpoint, captureIds);
      const batch: DeliveryBatch = {
        schemaVersion: 1,
        batchId,
        createdAt: now(),
        client: getClientContext(),
        captures: captures.map(toDeliveryCapture),
      };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
      const receipt = await options.transport(config.endpoint).send(batch, controller.signal);
      assertCompleteReceipt(receipt, batchId, captureIds);
      await options.queue.markDelivered(captureIds);
      return { status: 'delivered', captureIds, batchId };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      return { status: 'failed', error };
    }
  }

  return {
    flush() {
      if (inFlight) return inFlight;
      inFlight = execute().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}

function assertCompleteReceipt(receipt: DeliveryReceipt, batchId: string, captureIds: string[]): void {
  if (receipt.batchId !== batchId || receipt.schemaVersion !== 1) throw new Error('Receipt does not match batch');
  const accepted = [...receipt.acceptedCaptureIds].sort();
  const expected = [...captureIds].sort();
  if (accepted.length !== expected.length || accepted.some((id, index) => id !== expected[index])) {
    throw new Error('Receipt did not accept the complete batch');
  }
}