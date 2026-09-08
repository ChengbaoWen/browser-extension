import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { FilterConfig, Session } from '../types';
import { DEFAULT_FILTER_CONFIG } from '../matcher/endpoint-matcher';

interface HookDBSchema extends DBSchema {
  sessions: {
    key: string;
    value: Session;
    indexes: {
      'by-timestamp': number;
    };
  };
  settings: {
    key: string;
    value: any;
  };
}

const DB_NAME = 'ai_chatbox_hook_db';
const DB_VERSION = 2;
const MAX_SESSIONS = 500;
const FILTER_CONFIG_KEY = 'filter_config';

let dbPromise: Promise<IDBPDatabase<HookDBSchema>> | null = null;

export function getDatabase() {
  if (!dbPromise) {
    dbPromise = openDB<HookDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('sessions')) {
          const store = db.createObjectStore('sessions', { keyPath: 'id' });
          store.createIndex('by-timestamp', 'timestamp');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
      }
    });
  }
  return dbPromise;
}

export async function getFilterConfig(): Promise<FilterConfig> {
  try {
    const db = await getDatabase();
    const stored = await db.get('settings', FILTER_CONFIG_KEY);
    if (stored && Array.isArray(stored.rules)) {
      return stored as FilterConfig;
    }
  } catch (err) {
    console.warn('[Storage] Failed to read filter config from DB:', err);
  }
  return DEFAULT_FILTER_CONFIG;
}

export async function saveFilterConfig(config: FilterConfig): Promise<void> {
  const db = await getDatabase();
  await db.put('settings', config, FILTER_CONFIG_KEY);
}

export async function resetFilterConfig(): Promise<FilterConfig> {
  const db = await getDatabase();
  await db.put('settings', DEFAULT_FILTER_CONFIG, FILTER_CONFIG_KEY);
  return DEFAULT_FILTER_CONFIG;
}

export async function saveSession(payload: Session): Promise<void> {
  const db = await getDatabase();
  await db.put('sessions', payload);

  // Maintain sliding window max size
  const count = await db.count('sessions');
  if (count > MAX_SESSIONS) {
    const tx = db.transaction('sessions', 'readwrite');
    const index = tx.store.index('by-timestamp');
    let cursor = await index.openCursor();
    let toDelete = count - MAX_SESSIONS;
    while (cursor && toDelete > 0) {
      await cursor.delete();
      toDelete--;
      cursor = await cursor.continue();
    }
    await tx.done;
  }
}

export async function getSession(id: string): Promise<Session | undefined> {
  const db = await getDatabase();
  return db.get('sessions', id);
}

export async function getAllSessions(): Promise<Session[]> {
  const db = await getDatabase();
  const sessions = await db.getAllFromIndex('sessions', 'by-timestamp');
  return sessions.reverse(); // newest first
}

export async function clearAllSessions(): Promise<void> {
  const db = await getDatabase();
  await db.clear('sessions');
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDatabase();
  await db.delete('sessions', id);
}
