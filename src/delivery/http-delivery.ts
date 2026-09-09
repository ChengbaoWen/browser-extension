import type { DeliveryBatch, DeliveryReceipt } from './delivery-contract';

export interface DeliveryTransport {
  send(batch: DeliveryBatch, signal: AbortSignal): Promise<DeliveryReceipt>;
}

export function createHttpDeliveryTransport(endpoint: string): DeliveryTransport {
  const target = new URL(endpoint);
  if (target.protocol !== 'https:') throw new Error('Delivery endpoint must use HTTPS');
  return {
    async send(batch, signal) {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        redirect: 'error',
        credentials: 'omit',
        signal,
      });
      if (!response.ok) throw new Error(`Delivery failed with status ${response.status}`);
      const value: unknown = await response.json();
      if (!isReceipt(value)) throw new Error('Delivery receipt is invalid');
      return value;
    },
  };
}

function isReceipt(value: unknown): value is DeliveryReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schemaVersion === 1 && typeof candidate.batchId === 'string' &&
    Array.isArray(candidate.acceptedCaptureIds) && candidate.acceptedCaptureIds.every((id) => typeof id === 'string');
}