import { initMainWorldInterceptor } from '../interceptor';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    initMainWorldInterceptor();
  }
});
