import { FilterConfig, HookEvent } from './types';
import { createStreamParser } from './parser/stream-parser';
import { DEFAULT_FILTER_CONFIG, shouldInterceptUrl } from './matcher/endpoint-matcher';

export const AI_HOOK_EVENT_NAME = '__AI_CHATBOX_HOOK_EVENT__';
export const AI_HOOK_CONFIG_SYNC_EVENT = '__AI_HOOK_CONFIG_SYNC__';
export const AI_HOOK_REQUEST_CONFIG_EVENT = '__AI_HOOK_REQUEST_CONFIG__';

let activeConfig: FilterConfig = DEFAULT_FILTER_CONFIG;

function dispatch(event: HookEvent) {
  try {
    window.dispatchEvent(new CustomEvent(AI_HOOK_EVENT_NAME, { detail: event }));
  } catch (error) {
    console.warn('[AI Hook] Event dispatch failed:', error);
  }
}

function normalizeUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl, window.location.href).href;
  } catch {
    return rawUrl;
  }
}

function hookFetch() {
  const originalFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = normalizeUrl(rawUrl);

    const { intercept, provider } = shouldInterceptUrl(url, activeConfig);
    if (!intercept) {
      return originalFetch.apply(this, [input, init]);
    }

    const method = init?.method || (input instanceof Request ? input.method : 'GET');

    let body = typeof init?.body === 'string' ? init.body : '';
    if (!body && input instanceof Request) {
      try {
        body = await input.clone().text();
      } catch {
        // Keep empty if unreadable
      }
    }
    const requestHeaders = init?.headers || (input instanceof Request ? input.headers : undefined);
    const requestContentType = requestHeaders ? new Headers(requestHeaders).get('content-type') || '' : '';

    const parser = createStreamParser({
      url,
      method,
      transport: 'fetch',
      provider,
      requestContentType,
      requestBodyText: body,
      timestamp: Date.now()
    });

    dispatch(parser.startEvent);

    try {
      const response = await originalFetch.apply(this, [input, init]);
      const contentType = response.headers.get('content-type') || '';
      parser.setResponseMeta(contentType, response.status);

      if (!response.body) {
        for (const event of parser.flush()) dispatch(event);
        return response;
      }

      if (!contentType.includes('text/event-stream') && contentType.includes('application/json')) {
        response
          .clone()
          .text()
          .then((text) => {
            try {
              parser.feedJson(JSON.parse(text));
            } catch {
              for (const event of parser.feed(text)) dispatch(event);
            }
            for (const event of parser.flush()) dispatch(event);
          })
          .catch((error) => dispatch(parser.fail(error)));
        return response;
      }

      const [pageStream, hookStream] = response.body.tee();
      (async () => {
        const reader = hookStream.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            for (const event of parser.feed(chunk)) dispatch(event);
          }
          for (const event of parser.flush()) dispatch(event);
        } catch (error) {
          dispatch(parser.fail(error));
        } finally {
          reader.releaseLock();
        }
      })();

      return new Response(pageStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (error) {
      dispatch(parser.fail(error));
      throw error;
    }
  };
}

function hookXHR() {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async = true,
    user?: string | null,
    password?: string | null
  ) {
    (this as any).__ai_hook_method = method;
    (this as any).__ai_hook_url = normalizeUrl(typeof url === 'string' ? url : url.href);
    return originalOpen.apply(this, [method, url, async as boolean, user, password]);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const method = (this as any).__ai_hook_method || 'GET';
    const url = (this as any).__ai_hook_url || '';

    const { intercept, provider } = shouldInterceptUrl(url, activeConfig);
    if (!intercept) {
      return originalSend.apply(this, [body]);
    }

    const requestBody = typeof body === 'string' ? body : '';

    const parser = createStreamParser({
      url,
      method,
      transport: 'xhr',
      provider,
      requestBodyText: requestBody,
      timestamp: Date.now()
    });

    dispatch(parser.startEvent);

    this.addEventListener('load', () => {
      try {
        const contentType = this.getResponseHeader('content-type') || '';
        parser.setResponseMeta(contentType, this.status);
        const text = this.responseText || '';

        if (contentType.includes('json')) {
          try {
            parser.feedJson(JSON.parse(text));
          } catch {
            for (const event of parser.feed(text)) dispatch(event);
          }
        } else {
          for (const event of parser.feed(text)) dispatch(event);
        }

        for (const event of parser.flush()) dispatch(event);
      } catch (error) {
        dispatch(parser.fail(error));
      }
    });

    this.addEventListener('error', () => dispatch(parser.fail('XHR network error')));
    return originalSend.apply(this, [body]);
  };
}

export function initMainWorldInterceptor() {
  if ((window as any).__AI_CHATBOX_HOOK_INSTALLED__) return;
  (window as any).__AI_CHATBOX_HOOK_INSTALLED__ = true;

  window.addEventListener(AI_HOOK_CONFIG_SYNC_EVENT, (event: any) => {
    if (event.detail && Array.isArray(event.detail.rules)) {
      activeConfig = event.detail;
    }
  });

  // Request initial config from isolated world
  window.dispatchEvent(new CustomEvent(AI_HOOK_REQUEST_CONFIG_EVENT));

  hookFetch();
  hookXHR();
  console.log('[AI Hook] Fetch and XHR interceptors active with endpoint filtering.');
}
