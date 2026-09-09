import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendDiagnostic, loadDiagnostics, resetDiagnosticStoreForTests, type DiagnosticRecord } from '../../src/storage/diagnostic-store';

const values: Record<string, unknown> = {};

beforeEach(() => {
  resetDiagnosticStoreForTests();
  vi.stubGlobal('chrome', {
    storage: { local: {
      get: async (key: string) => ({ [key]: values[key] }),
      set: async (items: Record<string, unknown>) => { Object.assign(values, items); },
      remove: async (key: string) => { delete values[key]; },
    } },
  });
});

afterEach(() => {
  for (const key of Object.keys(values)) delete values[key];
  vi.unstubAllGlobals();
});

describe('diagnostic store', () => {
  it('serializes concurrent writes and retains only the newest records', async () => {
    const record = (id: string, occurredAt: number): DiagnosticRecord => ({
      id, occurredAt, area: 'channel', level: 'warn', code: 'overflow', message: id,
    });
    await Promise.all([
      appendDiagnostic(record('one', 1), 2),
      appendDiagnostic(record('two', 2), 2),
      appendDiagnostic(record('three', 3), 2),
    ]);
    expect((await loadDiagnostics(10)).map(({ id }) => id)).toEqual(['three', 'two']);
  });

  it('clears retained diagnostics when retention is disabled', async () => {
    const record: DiagnosticRecord = { id: 'one', occurredAt: 1, area: 'storage', level: 'warn', code: 'full', message: 'full' };
    await appendDiagnostic(record, 2);
    await appendDiagnostic(record, 0);
    expect(await loadDiagnostics(10)).toEqual([]);
  });
});