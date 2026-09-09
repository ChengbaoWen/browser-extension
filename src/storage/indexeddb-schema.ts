import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Capture } from '../capture/capture';
import type { CaptureStartDescriptor, CaptureCompletion } from '../capture/capture-frame';

export interface StoredCapture {
  id: string;
  capture: Capture;
  capturedAt: number;
  kind: Capture['kind'];
  interactionId: string;
  exchangeId: string | null;
  streamId: string | null;
  connectionId: string | null;
  deliveryState: 'pending' | 'delivered';
  logicalBytes: number;
}

export interface CaptureDraft {
  id: string;
  descriptor: CaptureStartDescriptor;
  completion?: CaptureCompletion;
  nextFrameSequence: number;
  nextChunkSequence: number;
  frameDigests: Record<string, string>;
  bodyUnavailable: boolean;
  updatedAt: number;
}

export interface CaptureChunk {
  captureId: string;
  sequence: number;
  bytes: ArrayBuffer;
}

export interface CaptureTombstone {
  id: string;
  expiresAt: number;
  lastFrameSequence: number;
  lastFrameDigest: string;
}

export interface StorageMetadata {
  key: 'logicalBytes';
  value: number;
}

export interface CaptureDatabase extends DBSchema {
  captures: {
    key: string;
    value: StoredCapture;
    indexes: {
      capturedAt: number;
      kind: Capture['kind'];
      interactionId: string;
      exchangeId: string;
      streamId: string;
      connectionId: string;
      deliveryState: 'pending' | 'delivered';
    };
  };
  captureChunks: {
    key: [string, number];
    value: CaptureChunk;
    indexes: { captureId: string };
  };
  captureDrafts: {
    key: string;
    value: CaptureDraft;
    indexes: { updatedAt: number };
  };
  captureTombstones: {
    key: string;
    value: CaptureTombstone;
    indexes: { expiresAt: number };
  };
  storageMetadata: {
    key: 'logicalBytes';
    value: StorageMetadata;
  };
}

const DATABASE_NAME = 'network_capture_v1';
const DATABASE_VERSION = 2;
let databasePromise: Promise<IDBPDatabase<CaptureDatabase>> | null = null;

export function openCaptureDatabase(): Promise<IDBPDatabase<CaptureDatabase>> {
  databasePromise ??= openDB<CaptureDatabase>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(database, oldVersion, _newVersion, transaction) {
      if (oldVersion >= 1) {
        const captures = transaction.objectStore('captures');
        captures.createIndex('exchangeId', 'exchangeId');
        captures.createIndex('streamId', 'streamId');
        captures.createIndex('connectionId', 'connectionId');
        database.createObjectStore('storageMetadata', { keyPath: 'key' }).put({ key: 'logicalBytes', value: -1 });
        return;
      }
      const captures = database.createObjectStore('captures', { keyPath: 'id' });
      captures.createIndex('capturedAt', 'capturedAt');
      captures.createIndex('kind', 'kind');
      captures.createIndex('interactionId', 'interactionId');
      captures.createIndex('exchangeId', 'exchangeId');
      captures.createIndex('streamId', 'streamId');
      captures.createIndex('connectionId', 'connectionId');
      captures.createIndex('deliveryState', 'deliveryState');
      const chunks = database.createObjectStore('captureChunks', { keyPath: ['captureId', 'sequence'] });
      chunks.createIndex('captureId', 'captureId');
      const drafts = database.createObjectStore('captureDrafts', { keyPath: 'id' });
      drafts.createIndex('updatedAt', 'updatedAt');
      const tombstones = database.createObjectStore('captureTombstones', { keyPath: 'id' });
      tombstones.createIndex('expiresAt', 'expiresAt');
      database.createObjectStore('storageMetadata', { keyPath: 'key' }).put({ key: 'logicalBytes', value: 0 });
    },
  });
  return databasePromise;
}

export function resetCaptureDatabaseForTests(): void {
  databasePromise = null;
}