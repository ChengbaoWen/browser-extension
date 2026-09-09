import type { CaptureFrame } from '../capture/capture-frame';

export const CAPTURE_EVENT_NAME = '__NETWORK_CAPTURE_FRAME_V1__';

export interface CaptureSender {
  send(frame: CaptureFrame): void;
}

export function createMainCaptureSender(target: EventTarget): CaptureSender {
  return {
    send(frame) {
      target.dispatchEvent(new CustomEvent(CAPTURE_EVENT_NAME, { detail: frame }));
    },
  };
}