import { describe, expect, it } from 'vitest';
import { decodeBodyText } from '../../src/entrypoints/sidepanel/body-text';

describe('Side Panel body text', () => {
  it('decodes JSON as UTF-8 when charset is omitted', () => {
    const bytes = new TextEncoder().encode('{"message":"你好"}');

    expect(decodeBodyText(bytes, 'application/json')).toBe('{"message":"你好"}');
    expect(decodeBodyText(bytes)).toBe('{"message":"你好"}');
  });

  it('returns null when bytes are invalid for the selected encoding', () => {
    expect(decodeBodyText(new Uint8Array([0xff]), 'application/json')).toBeNull();
  });
});