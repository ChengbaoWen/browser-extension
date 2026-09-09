import { concatBytes } from './bytes';

export interface SseFramer {
  push(chunk: Uint8Array): Uint8Array[];
  finish(): { events: Uint8Array[]; incomplete: Uint8Array | null };
}

export function createSseFramer(): SseFramer {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();

  function drain(): Uint8Array[] {
    const events: Uint8Array[] = [];
    let start = 0;
    let index = 0;
    while (index < pending.length) {
      const delimiterLength = delimiterAt(pending, index);
      if (delimiterLength === 0) {
        index += 1;
        continue;
      }
      const end = index + delimiterLength;
      events.push(pending.slice(start, end));
      start = end;
      index = end;
    }
    pending = pending.slice(start);
    return events;
  }

  return {
    push(chunk) {
      if (chunk.byteLength > 0) pending = concatBytes([pending, chunk]);
      return drain();
    },
    finish() {
      const events = drain();
      const incomplete = pending.byteLength === 0 ? null : pending.slice();
      pending = new Uint8Array();
      return { events, incomplete };
    },
  };
}

function delimiterAt(bytes: Uint8Array, index: number): number {
  if (bytes[index] === 0x0a && bytes[index + 1] === 0x0a) return 2;
  if (bytes[index] === 0x0d && bytes[index + 1] === 0x0d) return 2;
  if (
    bytes[index] === 0x0d &&
    bytes[index + 1] === 0x0a &&
    bytes[index + 2] === 0x0d &&
    bytes[index + 3] === 0x0a
  ) return 4;
  return 0;
}