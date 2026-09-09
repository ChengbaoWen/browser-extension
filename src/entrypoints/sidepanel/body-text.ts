export function decodeBodyText(bytes: Uint8Array, contentType?: string): string | null {
  const charset = contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}