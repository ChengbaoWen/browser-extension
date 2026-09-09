import { createMainCaptureSender } from '../channel/main-capture-channel';
import { installMainConfigReceiver } from '../channel/config-channel';
import { installCapture } from '../capture/http-capture';
import type { MainCaptureConfig } from '../config/config-projections';
import { createEndpointMatcher } from '../endpoints/endpoint-matcher';

const BOOTSTRAP_CONFIG: MainCaptureConfig = {
  revision: 'bootstrap', enabled: false, channelMaxFrameBytes: 64 * 1024, endpoints: [],
  http: { enabled: false, captureRequestBody: false, captureResponseBody: false, maxBodyBytes: 0 },
  sse: { enabled: false, sources: [], maxEventBytes: 0, maxStreamBytes: 0 },
  websocket: { enabled: false, maxMessageBytes: 0, maxConnectionBytes: 0 },
};

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    let config = BOOTSTRAP_CONFIG;
    let matcher = createEndpointMatcher(config);
    const sender = createMainCaptureSender(window);
    const cleanupCapture = installCapture({
      match: (url, protocol) => matcher.match(url, protocol),
      emit: sender.send,
      policy: () => config,
    });
    const cleanupConfig = installMainConfigReceiver({
      target: window,
      activate(next) {
        const nextMatcher = createEndpointMatcher(next);
        config = next;
        matcher = nextMatcher;
      },
    });
    window.addEventListener('pagehide', () => {
      cleanupConfig();
      cleanupCapture();
    }, { once: true });
  }
});
