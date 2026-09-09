import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64ToBytes } from '../../src/capture/bytes';
import { createCaptureId, readableBody } from '../../src/capture/capture-helpers';

afterEach(() => vi.unstubAllGlobals());

describe('Capture helpers', () => {
  it('creates UUID-shaped IDs when randomUUID is unavailable', () => {
    let next = 0;
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        bytes.forEach((_, index) => { bytes[index] = next++ & 0xff; });
        return bytes;
      },
    });
    expect(createCaptureId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('captures URLSearchParams using its form-urlencoded bytes', async () => {
    const body = await readableBody(new URLSearchParams({ 'f.req': '[["你好"]]' }), 1024);

    expect(body.state).toBe('captured');
    if (body.state !== 'captured') throw new Error('Expected captured body');
    expect(new TextDecoder().decode(base64ToBytes(body.data))).toBe('f.req=%5B%5B%22%E4%BD%A0%E5%A5%BD%22%5D%5D');
  });
});