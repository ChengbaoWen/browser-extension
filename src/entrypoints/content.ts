import { installIsolatedChannel } from '../channel/isolated-channel';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main() {
    const cleanup = installIsolatedChannel();
    window.addEventListener('pagehide', cleanup, { once: true });
  }
});
