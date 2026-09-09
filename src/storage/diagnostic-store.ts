export type DiagnosticArea = 'channel' | 'storage' | 'config' | 'delivery';
export type DiagnosticLevel = 'error' | 'warn' | 'info' | 'debug';

export interface DiagnosticRecord {
  id: string;
  occurredAt: number;
  area: DiagnosticArea;
  level: DiagnosticLevel;
  code: string;
  message: string;
}

const STORAGE_KEY = 'capture-diagnostics-v1';
let writeQueue = Promise.resolve();

export async function appendDiagnostic(record: DiagnosticRecord, retain: number): Promise<void> {
  const operation = writeQueue.then(async () => {
    if (retain <= 0) {
      await chrome.storage.local.remove(STORAGE_KEY);
      return;
    }
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const existing = parseDiagnostics(result[STORAGE_KEY]);
    await chrome.storage.local.set({ [STORAGE_KEY]: [...existing, record].slice(-retain) });
  });
  writeQueue = operation.catch(() => undefined);
  await operation;
}

export async function loadDiagnostics(limit: number): Promise<DiagnosticRecord[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return parseDiagnostics(result[STORAGE_KEY]).slice(-Math.max(0, limit)).reverse();
}

function parseDiagnostics(value: unknown): DiagnosticRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is DiagnosticRecord => {
    if (typeof item !== 'object' || item === null) return false;
    const record = item as Record<string, unknown>;
    return typeof record.id === 'string' && typeof record.occurredAt === 'number' &&
      ['channel', 'storage', 'config', 'delivery'].includes(String(record.area)) &&
      ['error', 'warn', 'info', 'debug'].includes(String(record.level)) &&
      typeof record.code === 'string' && typeof record.message === 'string';
  });
}

export function resetDiagnosticStoreForTests(): void {
  writeQueue = Promise.resolve();
}

export async function clearDiagnostics(): Promise<void> {
  const operation = writeQueue.then(() => chrome.storage.local.remove(STORAGE_KEY));
  writeQueue = operation.catch(() => undefined);
  await operation;
}