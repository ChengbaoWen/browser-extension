import 'fake-indexeddb/auto';
import { deleteDB, openDB, type IDBPDatabase } from 'idb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64 } from '../../src/capture/bytes';
import { captureToFrames } from '../../src/capture/capture-frame';
import type { HttpResponseCapture } from '../../src/capture/capture';
import { createCaptureStore } from '../../src/storage/capture-store';
import type { CaptureDatabase } from '../../src/storage/indexeddb-schema';

const databases: string[] = [];
const connections: IDBPDatabase<CaptureDatabase>[] = [];

async function createStore(config = { revision: 'r1', warningBytes: 1024 * 1024, hardLimitBytes: 2 * 1024 * 1024, draftTtlMs: 60_000 }) {
  const name = `capture-test-${crypto.randomUUID()}`;
  databases.push(name);
  const database = openDB<CaptureDatabase>(name, 2, {
    upgrade(db) {
      const captures = db.createObjectStore('captures', { keyPath: 'id' });
      captures.createIndex('capturedAt', 'capturedAt');
      captures.createIndex('kind', 'kind');
      captures.createIndex('interactionId', 'interactionId');
      captures.createIndex('exchangeId', 'exchangeId');
      captures.createIndex('streamId', 'streamId');
      captures.createIndex('connectionId', 'connectionId');
      captures.createIndex('deliveryState', 'deliveryState');
      const chunks = db.createObjectStore('captureChunks', { keyPath: ['captureId', 'sequence'] });
      chunks.createIndex('captureId', 'captureId');
      const drafts = db.createObjectStore('captureDrafts', { keyPath: 'id' });
      drafts.createIndex('updatedAt', 'updatedAt');
      const tombstones = db.createObjectStore('captureTombstones', { keyPath: 'id' });
      tombstones.createIndex('expiresAt', 'expiresAt');
      db.createObjectStore('storageMetadata', { keyPath: 'key' }).put({ key: 'logicalBytes', value: 0 });
    },
  });
  void database.then((connection) => connections.push(connection));
  return createCaptureStore({
    database,
    config: () => config,
  });
}

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  for (const name of databases.splice(0)) await deleteDB(name);
});

describe('CaptureStore', () => {
  it('finalizes frames and restores captured body bytes on detail reads', async () => {
    const store = await createStore();
    const bytes = new TextEncoder().encode('response bytes');
    const capture: HttpResponseCapture = {
      kind: 'http-response', id: 'response-1', exchangeId: 'exchange-1', capturedAt: 10,
      pageUrl: 'https://page.example', matchedRuleId: 'rule', configRevision: 'r1',
      url: 'https://api.example/v1', transport: 'fetch', httpVersion: { value: 'unknown', source: 'unavailable' },
      status: 200, statusText: 'OK', headers: { state: 'captured', visibility: 'script-visible', entries: [] },
      body: { state: 'captured', encoding: 'base64', byteLength: bytes.byteLength, data: bytesToBase64(bytes) },
    };
    const frames = captureToFrames(capture, 4);
    for (const frame of frames) await store.ingest(frame);
    for (const frame of frames) await store.ingest(frame);

    expect(await store.getById(capture.id)).toEqual(capture);
    const interactions = await store.listInteractions({ limit: 10 });
    expect(interactions.items).toHaveLength(1);
    expect((await store.listCaptures({ interactionId: capture.exchangeId }))[0]?.bodyState).toBe('captured');
  });

  it('marks only confirmed pending records delivered', async () => {
    const store = await createStore();
    const capture: HttpResponseCapture = {
      kind: 'http-response', id: 'response-2', exchangeId: 'exchange-2', capturedAt: 20,
      pageUrl: 'https://page.example', matchedRuleId: 'rule', configRevision: 'r1',
      url: 'https://api.example/v1', transport: 'fetch', httpVersion: { value: 'unknown', source: 'unavailable' },
      status: 204, statusText: 'No Content', headers: { state: 'captured', visibility: 'script-visible', entries: [] }, body: { state: 'absent' },
    };
    for (const frame of captureToFrames(capture, 4)) await store.ingest(frame);
    expect(await store.listPending(10)).toHaveLength(1);
    await store.markDelivered([capture.id]);
    expect(await store.listPending(10)).toEqual([]);
  });

  it('clears stored captures and resets capacity', async () => {
    const store = await createStore();
    const bytes = new TextEncoder().encode('stored body');
    const capture: HttpResponseCapture = {
      kind: 'http-response', id: 'clear-response', exchangeId: 'clear-exchange', capturedAt: 25,
      pageUrl: 'https://page.example', matchedRuleId: 'rule', configRevision: 'r1',
      url: 'https://api.example/v1', transport: 'fetch', httpVersion: { value: 'unknown', source: 'unavailable' },
      status: 200, statusText: 'OK', headers: { state: 'captured', visibility: 'script-visible', entries: [] },
      body: { state: 'captured', encoding: 'base64', byteLength: bytes.byteLength, data: bytesToBase64(bytes) },
    };
    for (const frame of captureToFrames(capture, 4)) await store.ingest(frame);
    expect((await store.getCapacityStatus()).logicalBytes).toBeGreaterThan(0);

    await store.clear();

    expect((await store.listInteractions({ limit: 10 })).items).toEqual([]);
    expect(await store.getById(capture.id)).toBeNull();
    expect(await store.listPending(10)).toEqual([]);
    expect((await store.getCapacityStatus()).logicalBytes).toBe(0);
  });

  it('finalizes metadata as storage-limit after later chunks are ignored', async () => {
    const name = `capture-limit-${crypto.randomUUID()}`;
    databases.push(name);
    const database = openDB<CaptureDatabase>(name, 2, {
      upgrade(db) {
        const captures = db.createObjectStore('captures', { keyPath: 'id' });
        captures.createIndex('capturedAt', 'capturedAt'); captures.createIndex('kind', 'kind');
        captures.createIndex('interactionId', 'interactionId'); captures.createIndex('deliveryState', 'deliveryState');
        captures.createIndex('exchangeId', 'exchangeId'); captures.createIndex('streamId', 'streamId'); captures.createIndex('connectionId', 'connectionId');
        const chunks = db.createObjectStore('captureChunks', { keyPath: ['captureId', 'sequence'] }); chunks.createIndex('captureId', 'captureId');
        const drafts = db.createObjectStore('captureDrafts', { keyPath: 'id' }); drafts.createIndex('updatedAt', 'updatedAt');
        const tombstones = db.createObjectStore('captureTombstones', { keyPath: 'id' }); tombstones.createIndex('expiresAt', 'expiresAt');
        db.createObjectStore('storageMetadata', { keyPath: 'key' }).put({ key: 'logicalBytes', value: 0 });
      },
    });
    void database.then((connection) => connections.push(connection));
    const store = createCaptureStore({ database, config: () => ({ revision: 'r1', warningBytes: 1024, hardLimitBytes: 2048, draftTtlMs: 60_000 }) });
    const bytes = new TextEncoder().encode('x'.repeat(5000));
    const capture: HttpResponseCapture = {
      kind: 'http-response', id: 'limited', exchangeId: 'limited-exchange', capturedAt: 30,
      pageUrl: 'https://page.example', matchedRuleId: 'rule', configRevision: 'r1', url: 'https://api.example/v1',
      transport: 'fetch', httpVersion: { value: 'unknown', source: 'unavailable' }, status: 200, statusText: 'OK',
      headers: { state: 'captured', visibility: 'script-visible', entries: [] },
      body: { state: 'captured', encoding: 'base64', byteLength: bytes.byteLength, data: bytesToBase64(bytes) },
    };
    for (const frame of captureToFrames(capture, 1024)) await store.ingest(frame);
    expect((await store.getById(capture.id) as HttpResponseCapture).body).toEqual({ state: 'unavailable', reason: 'storage-limit' });
  });

  it('terminates a draft after a conflicting replay', async () => {
    const store = await createStore();
    const bytes = new TextEncoder().encode('abcd');
    const capture: HttpResponseCapture = {
      kind: 'http-response', id: 'conflict', exchangeId: 'exchange-conflict', capturedAt: 40,
      pageUrl: 'https://page.example', matchedRuleId: 'rule', configRevision: 'r1', url: 'https://api.example/v1',
      transport: 'fetch', httpVersion: { value: 'unknown', source: 'unavailable' }, status: 200, statusText: 'OK',
      headers: { state: 'captured', visibility: 'script-visible', entries: [] },
      body: { state: 'captured', encoding: 'base64', byteLength: bytes.byteLength, data: bytesToBase64(bytes) },
    };
    const frames = captureToFrames(capture, 4);
    await store.ingest(frames[0]!);
    await store.ingest(frames[1]!);
    const chunk = frames[1]!;
    if (chunk.type !== 'chunk') throw new Error('Expected chunk frame');
    await store.ingest({ ...chunk, data: bytesToBase64(new TextEncoder().encode('wxyz')) });
    await store.ingest(frames[2]!);
    expect(await store.getById(capture.id)).toBeNull();
  });

  it('serializes capacity decisions across different capture IDs', async () => {
    const store = await createStore({ revision: 'r1', warningBytes: 1400, hardLimitBytes: 2800, draftTtlMs: 60_000 });
    const makeCapture = (id: string): HttpResponseCapture => {
      const bytes = new TextEncoder().encode('x'.repeat(1200));
      return {
        kind: 'http-response', id, exchangeId: `exchange-${id}`, capturedAt: 50,
        pageUrl: 'https://page.example', matchedRuleId: 'rule', configRevision: 'r1', url: 'https://api.example/v1',
        transport: 'fetch', httpVersion: { value: 'unknown', source: 'unavailable' }, status: 200, statusText: 'OK',
        headers: { state: 'captured', visibility: 'script-visible', entries: [] },
        body: { state: 'captured', encoding: 'base64', byteLength: bytes.byteLength, data: bytesToBase64(bytes) },
      };
    };
    const captures = [makeCapture('parallel-a'), makeCapture('parallel-b')];
    const frameSets = captures.map((capture) => captureToFrames(capture, 1200));
    await Promise.all(frameSets.map((frames) => store.ingest(frames[0]!)));
    await Promise.all(frameSets.map((frames) => store.ingest(frames[1]!)));
    await Promise.all(frameSets.map((frames) => store.ingest(frames[2]!)));
    const stored = await Promise.all(captures.map((capture) => store.getById(capture.id) as Promise<HttpResponseCapture>));
    expect(stored.filter((capture) => capture.body.state === 'captured')).toHaveLength(1);
    expect(stored.filter((capture) => capture.body.state === 'unavailable')).toHaveLength(1);
  });

  it('rejects a new start when its metadata would cross the hard limit', async () => {
    const store = await createStore({ revision: 'r1', warningBytes: 1, hardLimitBytes: 2, draftTtlMs: 60_000 });
    const capture: HttpResponseCapture = {
      kind: 'http-response', id: 'rejected-start', exchangeId: 'exchange-rejected', capturedAt: 60,
      pageUrl: 'https://page.example', matchedRuleId: 'rule', configRevision: 'r1', url: 'https://api.example/v1',
      transport: 'fetch', httpVersion: { value: 'unknown', source: 'unavailable' }, status: 204, statusText: 'No Content',
      headers: { state: 'captured', visibility: 'script-visible', entries: [] }, body: { state: 'absent' },
    };
    for (const frame of captureToFrames(capture, 64)) await store.ingest(frame);
    expect(await store.getById(capture.id)).toBeNull();
  });

  it('reports capacity warning once when logical usage crosses the warning level', async () => {
    const diagnostics: string[] = [];
    const name = `capture-warning-${crypto.randomUUID()}`;
    databases.push(name);
    const database = openDB<CaptureDatabase>(name, 2, { upgrade: createSchema });
    void database.then((connection) => connections.push(connection));
    const store = createCaptureStore({
      database,
      config: () => ({ revision: 'r1', warningBytes: 1, hardLimitBytes: 10_000, draftTtlMs: 60_000 }),
      onDiagnostic: (code) => diagnostics.push(code),
    });
    const capture: HttpResponseCapture = {
      kind: 'http-response', id: 'warning', exchangeId: 'exchange-warning', capturedAt: 70,
      pageUrl: 'https://page.example', matchedRuleId: 'rule', configRevision: 'r1', url: 'https://api.example/v1',
      transport: 'fetch', httpVersion: { value: 'unknown', source: 'unavailable' }, status: 204, statusText: 'No Content',
      headers: { state: 'captured', visibility: 'script-visible', entries: [] }, body: { state: 'absent' },
    };
    for (const frame of captureToFrames(capture, 64)) await store.ingest(frame);
    await vi.waitFor(() => expect(diagnostics).toContain('capacity-warning'));
    expect(diagnostics.filter((code) => code === 'capacity-warning')).toHaveLength(1);
  });
});

function createSchema(db: IDBPDatabase<CaptureDatabase>) {
  const captures = db.createObjectStore('captures', { keyPath: 'id' });
  captures.createIndex('capturedAt', 'capturedAt'); captures.createIndex('kind', 'kind');
  captures.createIndex('interactionId', 'interactionId'); captures.createIndex('deliveryState', 'deliveryState');
  captures.createIndex('exchangeId', 'exchangeId'); captures.createIndex('streamId', 'streamId'); captures.createIndex('connectionId', 'connectionId');
  const chunks = db.createObjectStore('captureChunks', { keyPath: ['captureId', 'sequence'] }); chunks.createIndex('captureId', 'captureId');
  const drafts = db.createObjectStore('captureDrafts', { keyPath: 'id' }); drafts.createIndex('updatedAt', 'updatedAt');
  const tombstones = db.createObjectStore('captureTombstones', { keyPath: 'id' }); tombstones.createIndex('expiresAt', 'expiresAt');
  db.createObjectStore('storageMetadata', { keyPath: 'key' }).put({ key: 'logicalBytes', value: 0 });
}