import { FilterConfig, HookEvent, Session } from '../types';
import { saveSession, getSession, getFilterConfig, saveFilterConfig, resetFilterConfig } from '../utils/storage';

export default defineBackground(() => {
  // Keep in-flight sessions until their final event arrives.
  const activeSessions = new Map<string, Session>();

  // Open side panel on action button click
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

  async function broadcastConfig(config: FilterConfig) {
    chrome.runtime.sendMessage({ type: 'AI_HOOK_CONFIG_SYNC', data: config }).catch(() => {});
    chrome.tabs?.query?.({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'AI_HOOK_CONFIG_SYNC', data: config }).catch(() => {});
        }
      }
    });
  }

  async function handleHookEvent(payload: HookEvent) {
    if (!payload || !payload.id) return;

    if (payload.type === 'AI_HOOK_START') {
      const newSession: Session = {
        id: payload.id,
        platform: payload.platform || 'generic-raw',
        model: payload.model,
        url: payload.url || '',
        timestamp: payload.timestamp || Date.now(),
        status: 'streaming',
        prompts: payload.prompts || [],
        response: '',
        rawRequest: payload.rawRequest,
        method: payload.method,
        requestBody: payload.rawRequest,
        requestContentType: payload.contentType,
        transport: payload.transport,
        format: payload.format
      };
      activeSessions.set(payload.id, newSession);
      await saveSession(newSession);
      broadcastUpdate(payload);
    } else if (payload.type === 'AI_HOOK_CHUNK') {
      const session = activeSessions.get(payload.id);
      if (session) {
        session.response = payload.response || session.response + (payload.delta || '');
        if (payload.model) session.model = payload.model;
        if (payload.contentType) session.responseContentType = payload.contentType;
        if (payload.statusCode) session.statusCode = payload.statusCode;
        if (payload.transport) session.transport = payload.transport;
        if (payload.format) session.format = payload.format;
        // Broadcast chunk to UI without saving to DB every chunk to optimize performance
        broadcastUpdate(payload);
      }
    } else if (payload.type === 'AI_HOOK_END') {
      let session = activeSessions.get(payload.id);
      if (!session) {
        session = await getSession(payload.id);
      }

      if (session) {
        session.status = payload.status || 'completed';
        session.response = payload.response || session.response;
        if (payload.model) session.model = payload.model;
        if (payload.contentType) session.responseContentType = payload.contentType;
        if (payload.statusCode) session.statusCode = payload.statusCode;
        if (payload.transport) session.transport = payload.transport;
        if (payload.format) session.format = payload.format;
        session.durationMs = Date.now() - session.timestamp;

        await saveSession(session);
        activeSessions.delete(payload.id);
        broadcastUpdate(payload);

      }
    } else if (payload.type === 'AI_HOOK_ERROR') {
      const session = activeSessions.get(payload.id);
      if (session) {
        session.status = 'error';
        session.error = payload.error;
        session.durationMs = Date.now() - session.timestamp;
        await saveSession(session);
        activeSessions.delete(payload.id);
        broadcastUpdate(payload);
      }
    }
  }

  function broadcastUpdate(payload: HookEvent) {
    chrome.runtime.sendMessage({ type: 'AI_HOOK_BROADCAST', data: payload }).catch(() => {
      // SidePanel / popup might not be open, safe to ignore
    });
  }

  // Handle Port connections from content script
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'AI_HOOK_PORT') {
      port.onMessage.addListener((msg: HookEvent) => {
        handleHookEvent(msg);
      });
    }
  });

  // Handle one-off messages (Hook events & Config management)
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return;

    if (message.type === 'GET_FILTER_CONFIG') {
      getFilterConfig().then((config) => {
        sendResponse({ config });
      });
      return true;
    }

    if (message.type === 'UPDATE_FILTER_CONFIG') {
      const newConfig = message.data as FilterConfig;
      saveFilterConfig(newConfig).then(async () => {
        await broadcastConfig(newConfig);
        sendResponse({ status: 'ok', config: newConfig });
      });
      return true;
    }

    if (message.type === 'RESET_FILTER_CONFIG') {
      resetFilterConfig().then(async (config) => {
        await broadcastConfig(config);
        sendResponse({ status: 'ok', config });
      });
      return true;
    }

    if (message?.type && message.type.startsWith('AI_HOOK_')) {
      handleHookEvent(message);
      sendResponse({ status: 'ok' });
      return true;
    }

    return true;
  });

  console.log('[AI Chatbox Hook] Background Service Worker ready.');
});
