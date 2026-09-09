import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpResponseCapture } from '../../src/capture/capture';
import { createCaptureStore } from '../../src/storage/capture-store';
import { openCaptureDatabase, resetCaptureDatabaseForTests } from '../../src/storage/indexeddb-schema';

const databaseName = 'network_capture_v1';

afterEach(async () => {
  resetCaptureDatabaseForTests();
  await deleteDB(databaseName);
});

describe('capture database migration', () => {
  it('preserves v1 captures, adds correlation indexes, and rebuilds logical usage', async () => {
    await deleteDB(databaseName);
    const legacy = await openDB(databaseName, 1, {
      upgrade(database) {
        const captures = database.createObjectStore('captures', { keyPath: 'id' });
        captures.createIndex('capturedAt', 'capturedAt');
        captures.createIndex('kind', 'kind');
        captures.createIndex('interactionId', 'interactionId');
        captures.createIndex('deliveryState', 'deliveryState');
        const chunks = database.createObjectStore('captureChunks', { keyPath: ['captureId', 'sequence'] });
        chunks.createIndex('captureId', 'captureId');
        const drafts = database.createObjectStore('captureDrafts', { keyPath: 'id' });
        drafts.createIndex('updatedAt', 'updatedAt');
        const tombstones = database.createObjectStore('captureTombstones', { keyPath: 'id' });
        tombstones.createIndex('expiresAt', 'expiresAt');
      },
    });
    const capture: HttpResponseCapture = {
      kind: 'http-response', id: 'legacy-response', exchangeId: 'legacy-exchange', capturedAt: 1,
      pageUrl: 'https://page.example', matchedRuleId: 'rule', configRevision: 'r1', url: 'https://api.example/v1',
      transport: 'fetch', httpVersion: { value: 'unknown', source: 'unavailable' }, status: 204, statusText: 'No Content',
      headers: { state: 'captured', visibility: 'script-visible', entries: [] }, body: { state: 'absent' },
    };
    await legacy.put('captures', {
      id: capture.id, capture, capturedAt: capture.capturedAt, kind: capture.kind,
      interactionId: capture.exchangeId, deliveryState: 'pending', logicalBytes: 1,
    });
    legacy.close();

    const database = await openCaptureDatabase();
    const store = createCaptureStore({
      database: Promise.resolve(database),
      config: () => ({ revision: 'r1', warningBytes: 1024, hardLimitBytes: 2048, draftTtlMs: 60_000 }),
    });
    expect(await store.getById(capture.id)).toEqual(capture);
    expect((await store.getCapacityStatus()).logicalBytes).toBeGreaterThan(0);
    const indexNames = database.transaction('captures').store.indexNames;
    expect([...indexNames]).toEqual(expect.arrayContaining(['exchangeId', 'streamId', 'connectionId']));
    database.close();
  });
});