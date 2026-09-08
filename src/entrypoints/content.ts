import {
  AI_HOOK_CONFIG_SYNC_EVENT,
  AI_HOOK_EVENT_NAME,
  AI_HOOK_REQUEST_CONFIG_EVENT
} from '../interceptor';
import { HookEvent } from '../types';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main() {
    // 1. Establish persistent port to Background Service Worker
    let port: chrome.runtime.Port | null = null;

    function connectPort() {
      try {
        port = chrome.runtime.connect({ name: 'AI_HOOK_PORT' });
        port.onDisconnect.addListener(() => {
          port = null;
          // Reconnect after brief backoff
          setTimeout(connectPort, 1000);
        });
      } catch {
        port = null;
      }
    }

    connectPort();

    // 2. Fetch and propagate filter configuration to MAIN World
    function syncConfigToMainWorld() {
      chrome.runtime.sendMessage({ type: 'GET_FILTER_CONFIG' }, (response) => {
        if (response?.config) {
          window.dispatchEvent(
            new CustomEvent(AI_HOOK_CONFIG_SYNC_EVENT, { detail: response.config })
          );
        }
      });
    }

    // Initial sync
    syncConfigToMainWorld();

    // Respond when MAIN world explicitly requests config
    window.addEventListener(AI_HOOK_REQUEST_CONFIG_EVENT, () => {
      syncConfigToMainWorld();
    });

    // Listen for config sync from Background broadcast
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'AI_HOOK_CONFIG_SYNC' && message.data) {
        window.dispatchEvent(
          new CustomEvent(AI_HOOK_CONFIG_SYNC_EVENT, { detail: message.data })
        );
      }
    });

    // 3. Listen for CustomEvents dispatched from MAIN world and forward to background
    window.addEventListener(AI_HOOK_EVENT_NAME, (event: any) => {
      const payload: HookEvent = event.detail;
      if (!payload) return;

      if (port) {
        try {
          port.postMessage(payload);
        } catch {
          chrome.runtime.sendMessage(payload).catch(() => {});
        }
      } else {
        chrome.runtime.sendMessage(payload).catch(() => {});
      }
    });

    console.log('[AI Chatbox Hook] Content Script bridge loaded.');
  }
});
