import type { IDBPDatabase, IDBPObjectStore, StoreNames } from 'idb';
import { base64ToBytes, bytesToBase64, concatBytes } from '../capture/bytes';
import type { Capture, MessageBody } from '../capture/capture';
import type { CaptureFrame, CaptureStartDescriptor } from '../capture/capture-frame';
import { openCaptureDatabase, type CaptureChunk, type CaptureDatabase, type CaptureDraft, type StoredCapture } from './indexeddb-schema';

export interface StoragePolicy {
  revision: string;
  warningBytes: number;
  hardLimitBytes: number;
  draftTtlMs: number;
}

export interface InteractionQuery {
  cursor?: number;
  limit: number;
  kinds?: Array<'http' | 'sse' | 'websocket'>;
}

export interface InteractionScope {
  interactionId: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: number | null;
}

export interface InteractionSummary {
  id: string;
  protocol: 'http' | 'sse' | 'websocket';
  url: string;
  capturedAt: number;
  captureCount: number;
}

export interface CaptureSummary {
  id: string;
  kind: Capture['kind'];
  capturedAt: number;
  url: string;
  bodyState: MessageBody['state'] | 'not-applicable';
  byteLength: number | null;
  direction?: 'outbound' | 'inbound';
}

export interface CapacityStatus {
  logicalBytes: number;
  warningBytes: number;
  hardLimitBytes: number;
  level: 'normal' | 'warning' | 'full';
  browserUsageBytes: number | null;
  browserQuotaBytes: number | null;
}

export interface CaptureWriter {
  ingest(frame: CaptureFrame): Promise<void>;
}

export interface CaptureReader {
  listInteractions(query: InteractionQuery): Promise<Page<InteractionSummary>>;
  listCaptures(scope: InteractionScope): Promise<CaptureSummary[]>;
  getById(captureId: string): Promise<Capture | null>;
  getCapacityStatus(): Promise<CapacityStatus>;
}

export interface CaptureCleaner {
  clear(): Promise<void>;
}

export interface CaptureStore extends CaptureWriter, CaptureReader, CaptureCleaner {
  listPending(limit: number): Promise<Capture[]>;
  markDelivered(captureIds: string[]): Promise<void>;
  cleanup(): Promise<void>;
}

export function createCaptureStore(options: {
  config(): StoragePolicy;
  database?: Promise<IDBPDatabase<CaptureDatabase>>;
  now?: () => number;
  onDiagnostic?: (code: 'capacity-warning' | 'start-rejected' | 'body-dropped', message: string) => void;
}): CaptureStore {
  const database = (options.database ?? openCaptureDatabase()).then(async (db) => {
    const metadata = await db.get('storageMetadata', 'logicalBytes');
    if (!metadata || metadata.value < 0) {
      await db.put('storageMetadata', { key: 'logicalBytes', value: await calculateLogicalBytes(db) });
    }
    return db;
  });
  const now = options.now ?? Date.now;
  const queues = new Map<string, Promise<void>>();

  const serialize = (captureId: string, operation: () => Promise<void>) => {
    const previous = queues.get(captureId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(captureId, current);
    return current.finally(() => {
      if (queues.get(captureId) === current) queues.delete(captureId);
    });
  };

  async function ingestFrame(frame: CaptureFrame): Promise<void> {
    const db = await database;
    const tx = db.transaction(['captures', 'captureChunks', 'captureDrafts', 'captureTombstones', 'storageMetadata'], 'readwrite');
    const captures = tx.objectStore('captures');
    const chunks = tx.objectStore('captureChunks');
    const drafts = tx.objectStore('captureDrafts');
    const tombstones = tx.objectStore('captureTombstones');
    const metadata = tx.objectStore('storageMetadata');
    let logicalBytes = (await metadata.get('logicalBytes'))?.value ?? 0;
    const initialLogicalBytes = logicalBytes;
    let crossedWarningLevel = false;
    const saveLogicalBytes = () => {
      crossedWarningLevel ||= initialLogicalBytes < options.config().warningBytes && logicalBytes >= options.config().warningBytes;
      return metadata.put({ key: 'logicalBytes', value: Math.max(0, logicalBytes) });
    };
    void tx.done.then(() => {
      if (crossedWarningLevel) options.onDiagnostic?.('capacity-warning', `Storage usage reached the warning level at ${logicalBytes} bytes`);
    }).catch(() => undefined);
    if (await captures.get(frame.captureId) || await tombstones.get(frame.captureId)) {
      await tx.done;
      return;
    }
    const digest = stableDigest(frame);
    let draft = await drafts.get(frame.captureId);
    if (frame.type === 'start') {
      if (draft) {
        if (draft.frameDigests['0'] !== digest) {
          logicalBytes -= logicalByteLength(draft) + await deleteDraftChunks(chunks, frame.captureId);
          await drafts.delete(frame.captureId);
          await tombstones.put(tombstoneFor(frame, digest, now(), options.config().draftTtlMs));
          await saveLogicalBytes();
        }
      } else {
        draft = {
          id: frame.captureId, descriptor: frame.descriptor, nextFrameSequence: 1,
          nextChunkSequence: 0, frameDigests: { '0': digest }, bodyUnavailable: false, updatedAt: now(),
        };
        const draftBytes = logicalByteLength(draft);
        if (logicalBytes + draftBytes > options.config().hardLimitBytes) {
          await tombstones.put(tombstoneFor(frame, digest, now(), options.config().draftTtlMs));
          options.onDiagnostic?.('start-rejected', `Capture ${frame.captureId} rejected at the storage hard limit`);
        } else {
          await drafts.add(draft);
          logicalBytes += draftBytes;
          await saveLogicalBytes();
        }
      }
      await tx.done;
      return;
    }
    if (!draft && frame.type === 'error') {
      await tombstones.put(tombstoneFor(frame, digest, now(), options.config().draftTtlMs));
      await tx.done;
      return;
    }
    if (!draft) throw new Error(`Missing start frame for ${frame.captureId}`);
    const oldDraftBytes = logicalByteLength(draft);
    const terminateDraft = async () => {
      logicalBytes -= oldDraftBytes + await deleteDraftChunks(chunks, frame.captureId);
      await drafts.delete(frame.captureId);
      await tombstones.put(tombstoneFor(frame, digest, now(), options.config().draftTtlMs));
      await saveLogicalBytes();
      await tx.done;
    };
    if (frame.frameSequence < draft.nextFrameSequence) {
      if (draft.frameDigests[String(frame.frameSequence)] === digest) await tx.done;
      else await terminateDraft();
      return;
    }
    if (frame.frameSequence !== draft.nextFrameSequence) {
      await terminateDraft();
      return;
    }
    draft.frameDigests[String(frame.frameSequence)] = digest;
    draft.nextFrameSequence += 1;
    draft.updatedAt = now();
    if (frame.type === 'chunk') {
      if (draft.bodyUnavailable) {
        await drafts.put(draft);
        logicalBytes += logicalByteLength(draft) - oldDraftBytes;
        await saveLogicalBytes();
        await tx.done;
        return;
      }
      if (frame.chunkSequence !== draft.nextChunkSequence) {
        await terminateDraft();
        return;
      }
      if (logicalBytes - oldDraftBytes + logicalByteLength(draft) + frame.byteLength > options.config().hardLimitBytes) {
        const removedBytes = await deleteDraftChunks(chunks, frame.captureId);
        draft.bodyUnavailable = true;
        draft.completion = { body: { state: 'unavailable', reason: 'storage-limit' } };
        logicalBytes = logicalBytes - oldDraftBytes - removedBytes + logicalByteLength(draft);
        options.onDiagnostic?.('body-dropped', `Body for ${frame.captureId} dropped at the storage hard limit`);
      } else {
        const bytes = base64ToBytes(frame.data);
        const ownedBytes = new Uint8Array(bytes);
        const value: CaptureChunk = {
          captureId: frame.captureId,
          sequence: frame.chunkSequence,
          bytes: ownedBytes.buffer,
        };
        await chunks.add(value);
        draft.nextChunkSequence += 1;
        logicalBytes = logicalBytes - oldDraftBytes + logicalByteLength(draft) + frame.byteLength;
      }
      await drafts.put(draft);
      await saveLogicalBytes();
    } else if (frame.type === 'body-unavailable') {
      const removedBytes = await deleteDraftChunks(chunks, frame.captureId);
      draft.bodyUnavailable = true;
      draft.completion = { body: { state: 'unavailable', reason: frame.reason, ...(frame.partialByteLength === undefined ? {} : { partialByteLength: frame.partialByteLength }) } };
      await drafts.put(draft);
      logicalBytes = logicalBytes - oldDraftBytes - removedBytes + logicalByteLength(draft);
      await saveLogicalBytes();
    } else if (frame.type === 'error') {
      logicalBytes -= oldDraftBytes + await deleteDraftChunks(chunks, frame.captureId);
      await drafts.delete(frame.captureId);
      await tombstones.put(tombstoneFor(frame, digest, now(), options.config().draftTtlMs));
      await saveLogicalBytes();
    } else {
      const completion = draft.completion ?? frame.completion;
      const storageOverride = draft.completion?.body !== 'not-applicable' &&
        draft.completion?.body.state === 'unavailable' &&
        draft.completion.body.reason === 'storage-limit';
      if (draft.completion && !storageOverride && stableDigest(draft.completion) !== stableDigest(frame.completion)) {
        await terminateDraft();
        return;
      }
      const stored = await finalizeCapture(draft.descriptor, completion, chunks, frame.captureId);
      await captures.add(stored);
      await drafts.delete(frame.captureId);
      await tombstones.put(tombstoneFor(frame, digest, now(), options.config().draftTtlMs));
      logicalBytes = logicalBytes - oldDraftBytes + stored.logicalBytes;
      await saveLogicalBytes();
    }
    await tx.done;
  }

  async function getById(captureId: string): Promise<Capture | null> {
    const db = await database;
    const stored = await db.get('captures', captureId);
    if (!stored) return null;
    if (!hasBody(stored.capture) || stored.capture.body.state !== 'captured') return structuredClone(stored.capture);
    const chunks = await db.getAllFromIndex('captureChunks', 'captureId', captureId);
    chunks.sort((left, right) => left.sequence - right.sequence);
    const bytes = concatBytes(chunks.map((chunk) => new Uint8Array(chunk.bytes)));
    if (bytes.byteLength !== stored.capture.body.byteLength) throw new Error(`Body integrity failure for ${captureId}`);
    return { ...stored.capture, body: { ...stored.capture.body, data: bytesToBase64(bytes) } } as Capture;
  }

  return {
    ingest: (frame) => serialize(frame.captureId, () => ingestFrame(frame)),
    async listInteractions(query) {
      const db = await database;
      const all = (await db.getAllFromIndex('captures', 'capturedAt')).reverse();
      const groups = new Map<string, InteractionSummary>();
      for (const record of all) {
        const protocol = protocolOf(record.capture);
        if (query.kinds && !query.kinds.includes(protocol)) continue;
        const existing = groups.get(record.interactionId);
        if (existing) {
          existing.captureCount += 1;
          if (protocol === 'sse') existing.protocol = 'sse';
        }
        else groups.set(record.interactionId, { id: record.interactionId, protocol, url: record.capture.url, capturedAt: record.capturedAt, captureCount: 1 });
      }
      const items = [...groups.values()].sort((a, b) => b.capturedAt - a.capturedAt);
      const start = query.cursor ?? 0;
      const page = items.slice(start, start + query.limit);
      return { items: page, nextCursor: start + page.length < items.length ? start + page.length : null };
    },
    async listCaptures(scope) {
      const db = await database;
      const records = await db.getAllFromIndex('captures', 'interactionId', scope.interactionId);
      return records.sort((a, b) => a.capturedAt - b.capturedAt).map(toSummary);
    },
    getById,
    async getCapacityStatus() {
      const logicalBytes = (await (await database).get('storageMetadata', 'logicalBytes'))?.value ?? 0;
      const config = options.config();
      const estimate: StorageEstimate = typeof navigator !== 'undefined' && navigator.storage?.estimate
        ? await navigator.storage.estimate().catch(() => ({}))
        : {};
      return {
        logicalBytes, warningBytes: config.warningBytes, hardLimitBytes: config.hardLimitBytes,
        level: logicalBytes >= config.hardLimitBytes ? 'full' : logicalBytes >= config.warningBytes ? 'warning' : 'normal',
        browserUsageBytes: estimate.usage ?? null,
        browserQuotaBytes: estimate.quota ?? null,
      };
    },
    async listPending(limit) {
      const db = await database;
      const records = await db.getAllFromIndex('captures', 'deliveryState', 'pending');
      records.sort((a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id));
      const values = await Promise.all(records.slice(0, limit).map((record) => getById(record.id)));
      return values.filter((capture): capture is Capture => capture !== null);
    },
    async markDelivered(captureIds) {
      const db = await database;
      const tx = db.transaction('captures', 'readwrite');
      for (const id of captureIds) {
        const record = await tx.store.get(id);
        if (record?.deliveryState === 'pending') await tx.store.put({ ...record, deliveryState: 'delivered' });
      }
      await tx.done;
    },
    async clear() {
      const db = await database;
      const tx = db.transaction(['captures', 'captureChunks', 'captureDrafts', 'captureTombstones', 'storageMetadata'], 'readwrite');
      await Promise.all([
        tx.objectStore('captures').clear(),
        tx.objectStore('captureChunks').clear(),
        tx.objectStore('captureDrafts').clear(),
        tx.objectStore('captureTombstones').clear(),
      ]);
      await tx.objectStore('storageMetadata').put({ key: 'logicalBytes', value: 0 });
      await tx.done;
    },
    async cleanup() {
      const db = await database;
      const cutoff = now() - options.config().draftTtlMs;
      const tx = db.transaction(['captureDrafts', 'captureChunks', 'captureTombstones', 'storageMetadata'], 'readwrite');
      const metadata = tx.objectStore('storageMetadata');
      let logicalBytes = (await metadata.get('logicalBytes'))?.value ?? 0;
      const expiredDrafts = await tx.objectStore('captureDrafts').index('updatedAt').getAll(IDBKeyRange.upperBound(cutoff), 100);
      for (const draft of expiredDrafts) {
        logicalBytes -= logicalByteLength(draft) + await deleteDraftChunks(tx.objectStore('captureChunks'), draft.id);
        await tx.objectStore('captureDrafts').delete(draft.id);
      }
      const expiredTombstones = await tx.objectStore('captureTombstones').index('expiresAt').getAll(IDBKeyRange.upperBound(now()), 100);
      for (const tombstone of expiredTombstones) await tx.objectStore('captureTombstones').delete(tombstone.id);
      await metadata.put({ key: 'logicalBytes', value: Math.max(0, logicalBytes) });
      await tx.done;
    },
  };
}

async function finalizeCapture<TxStores extends ArrayLike<StoreNames<CaptureDatabase>>>(
  descriptor: CaptureStartDescriptor,
  completion: import('../capture/capture-frame').CaptureCompletion,
  chunks: IDBPObjectStore<CaptureDatabase, TxStores, 'captureChunks', 'readwrite'>,
  captureId: string,
): Promise<StoredCapture> {
  let capture: Capture;
  let logicalBytes = 0;
  if (descriptor.body === 'not-applicable') {
    if (completion.body !== 'not-applicable') throw new Error('Bodyless capture has body completion');
    capture = descriptor.capture;
  } else {
    if (completion.body === 'not-applicable') throw new Error('Body capture is missing completion');
    let body: MessageBody;
    if (completion.body.state === 'captured') {
      const records = await chunks.index('captureId').getAll(captureId) as CaptureChunk[];
      records.sort((left, right) => left.sequence - right.sequence);
      if (records.some((record, index) => record.sequence !== index)) throw new Error('Captured Body chunk sequence mismatch');
      const total = records.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
      if (total !== completion.body.byteLength) throw new Error('Captured Body byteLength mismatch');
      body = { ...completion.body, data: '' };
    } else body = completion.body;
    capture = { ...descriptor.capture, body } as Capture;
  }
  logicalBytes = logicalByteLength(capture) + 64;
  const interactionId = interactionIdOf(capture);
  return {
    id: capture.id, capture, capturedAt: capture.capturedAt, kind: capture.kind, interactionId,
    exchangeId: 'exchangeId' in capture ? capture.exchangeId : null,
    streamId: 'streamId' in capture ? capture.streamId : null,
    connectionId: 'connectionId' in capture ? capture.connectionId : null,
    deliveryState: 'pending', logicalBytes,
  };
}

async function deleteDraftChunks<TxStores extends ArrayLike<StoreNames<CaptureDatabase>>>(
  store: IDBPObjectStore<CaptureDatabase, TxStores, 'captureChunks', 'readwrite'>,
  captureId: string,
): Promise<number> {
  let removedBytes = 0;
  let cursor = await store.index('captureId').openCursor(captureId);
  while (cursor) {
    removedBytes += cursor.value.bytes.byteLength;
    await cursor.delete();
    cursor = await cursor.continue();
  }
  return removedBytes;
}

async function calculateLogicalBytes(db: IDBPDatabase<CaptureDatabase>): Promise<number> {
  const captures = await db.getAll('captures');
  const drafts = await db.getAll('captureDrafts');
  const chunks = await db.getAll('captureChunks');
  return captures.reduce((sum, record) => sum + logicalByteLength(record.capture) + 64, 0) +
    drafts.reduce((sum, draft) => sum + logicalByteLength(draft), 0) +
    chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
}

function interactionIdOf(capture: Capture): string {
  if ('streamId' in capture) return capture.exchangeId ?? capture.streamId;
  if ('connectionId' in capture) return capture.connectionId;
  return capture.exchangeId;
}

function protocolOf(capture: Capture): 'http' | 'sse' | 'websocket' {
  if (capture.kind.startsWith('sse-')) return 'sse';
  if (capture.kind.startsWith('websocket-')) return 'websocket';
  return 'http';
}

function hasBody(capture: Capture): capture is Extract<Capture, { body: MessageBody }> {
  return 'body' in capture;
}

function toSummary(record: StoredCapture): CaptureSummary {
  const bodyState = hasBody(record.capture) ? record.capture.body.state : 'not-applicable';
  const byteLength = hasBody(record.capture) && record.capture.body.state === 'captured' ? record.capture.body.byteLength : null;
  return {
    id: record.id, kind: record.kind, capturedAt: record.capturedAt, url: record.capture.url, bodyState, byteLength,
    ...(record.capture.kind === 'websocket-message' ? { direction: record.capture.direction } : {}),
  };
}

function stableDigest(value: unknown): string {
  const input = JSON.stringify(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function logicalByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function tombstoneFor(frame: CaptureFrame, digest: string, timestamp: number, ttlMs: number) {
  return {
    id: frame.captureId,
    expiresAt: timestamp + ttlMs,
    lastFrameSequence: frame.frameSequence,
    lastFrameDigest: digest,
  };
}