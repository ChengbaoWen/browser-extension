import { HookEvent, Prompt, ResponseFormat, TransportType } from '../types';

export interface RequestMetadata {
  id?: string;
  url: string;
  method: string;
  transport: TransportType;
  provider?: string;
  requestContentType?: string;
  requestBodyText?: string;
  timestamp?: number;
}

export interface StreamParser {
  readonly startEvent: HookEvent;
  setResponseMeta(contentType: string, statusCode?: number): void;
  feed(chunk: string): HookEvent[];
  feedJson(json: unknown): void;
  flush(): HookEvent[];
  fail(error: unknown): HookEvent;
}

class SSELineBuffer {
  private buffer = '';

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    return lines
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
  }

  flush(): string[] {
    const line = this.buffer.trim();
    this.buffer = '';
    return line.startsWith('data:') && line.slice(5).trim() ? [line.slice(5).trim()] : [];
  }
}

function normalizeContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          return part.text || part.content || '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, any>;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
  }
  return value == null ? '' : JSON.stringify(value);
}

function extractPromptMessages(request: any): Prompt[] {
  if (!request) return [];

  const messages = request.messages || request.input?.messages;
  if (Array.isArray(messages)) {
    return messages.map((msg) => ({
      role: String(msg?.role || 'user'),
      content: normalizeContent(msg?.content ?? msg)
    }));
  }

  const prompt = request.prompt ?? request.input?.prompt;
  if (typeof prompt === 'string') {
    return [{ role: 'user', content: prompt }];
  }

  if (Array.isArray(prompt)) {
    return prompt.map((item) => ({
      role: 'user',
      content: normalizeContent(item)
    }));
  }

  return [];
}

function extractResponseDelta(json: any): { text: string; model?: string } {
  if (!json || typeof json !== 'object') return { text: '' };

  const model = json.model || json.model_name;

  // 1. OpenAI / Generic choices delta
  const choice = json.choices?.[0];
  if (choice) {
    if (typeof choice.delta?.content === 'string') {
      return { text: choice.delta.content, model };
    }
    if (typeof choice.delta?.text === 'string') {
      return { text: choice.delta.text, model };
    }
    if (typeof choice.message?.content === 'string') {
      return { text: choice.message.content, model };
    }
    if (typeof choice.text === 'string') {
      return { text: choice.text, model };
    }
  }

  // 2. Claude stream content_block_delta / completion
  if (json.type === 'content_block_delta' && json.delta?.text) {
    return { text: json.delta.text, model };
  }
  if (typeof json.completion === 'string') {
    return { text: json.completion, model };
  }

  // 3. ChatGPT internal backend-api conversation format
  if (json.message?.content?.parts && Array.isArray(json.message.content.parts)) {
    const text = json.message.content.parts.join('');
    return { text, model };
  }

  // 4. Dashscope / 通义千问 / Kimi / Ollama
  if (json.output?.text) {
    return { text: json.output.text, model };
  }
  if (json.output?.choices?.[0]?.delta?.content) {
    return { text: json.output.choices[0].delta.content, model };
  }
  if (typeof json.response === 'string') {
    return { text: json.response, model };
  }
  if (typeof json.text === 'string') {
    return { text: json.text, model };
  }

  return { text: '', model };
}

function detectResponseFormat(contentType: string): ResponseFormat {
  const lower = contentType.toLowerCase();
  if (lower.includes('text/event-stream')) return 'sse';
  if (lower.includes('json') || lower.includes('ndjson')) return 'json';
  if (lower.startsWith('text/') || lower === '') return 'text';
  return 'unknown';
}

export function createStreamParser(meta: RequestMetadata): StreamParser {
  const id = meta.id || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = meta.timestamp || Date.now();
  const transport = meta.transport;
  const url = meta.url;
  const method = meta.method;
  const requestContentType = meta.requestContentType || '';

  let requestJson: any = null;
  if (meta.requestBodyText) {
    try {
      requestJson = JSON.parse(meta.requestBodyText);
    } catch {
      // Body is not JSON
    }
  }

  const prompts = extractPromptMessages(requestJson);
  let model: string | undefined = requestJson?.model || requestJson?.input?.model;
  let responseContentType = '';
  let statusCode: number | undefined;
  let format: ResponseFormat = 'unknown';
  let isRawStream = false;
  let accumulatedResponse = '';

  const sseBuffer = new SSELineBuffer();

  const baseEvent = {
    id,
    platform: meta.provider || 'generic-raw',
    url,
    timestamp
  };

  const startEvent: HookEvent = {
    ...baseEvent,
    type: 'AI_HOOK_START',
    dataType: 'request',
    transport,
    format: 'unknown',
    model,
    method,
    contentType: requestContentType,
    prompts,
    rawRequest: requestJson || meta.requestBodyText
  };

  const setResponseMeta = (contentType: string, status?: number) => {
    responseContentType = contentType;
    statusCode = status;
    format = detectResponseFormat(contentType);
    isRawStream = format !== 'sse' && format !== 'json';
  };

  const feed = (chunk: string): HookEvent[] => {
    if (!chunk) return [];

    if (isRawStream) {
      accumulatedResponse += chunk;
      return [
        {
          ...baseEvent,
          type: 'AI_HOOK_CHUNK',
          dataType: 'response',
          transport,
          format,
          contentType: responseContentType,
          statusCode,
          delta: chunk,
          response: accumulatedResponse
        }
      ];
    }

    const events: HookEvent[] = [];
    const lines = sseBuffer.feed(chunk);

    for (const data of lines) {
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const { text, model: chunkModel } = extractResponseDelta(json);
        if (chunkModel) model = chunkModel;

        const delta = text || (typeof json === 'string' ? json : '');
        if (delta) {
          accumulatedResponse += delta;
          events.push({
            ...baseEvent,
            type: 'AI_HOOK_CHUNK',
            dataType: 'response',
            transport,
            format,
            model,
            contentType: responseContentType,
            statusCode,
            delta,
            response: accumulatedResponse
          });
        }
      } catch {
        // Fallback for non-JSON SSE data
        accumulatedResponse += data;
        events.push({
          ...baseEvent,
          type: 'AI_HOOK_CHUNK',
          dataType: 'response',
          transport,
          format,
          model,
          contentType: responseContentType,
          statusCode,
          delta: data,
          response: accumulatedResponse
        });
      }
    }

    return events;
  };

  const feedJson = (json: unknown) => {
    if (!json) return;
    const { text, model: jsonModel } = extractResponseDelta(json);
    if (jsonModel) model = jsonModel;
    accumulatedResponse = text || (typeof json === 'string' ? json : JSON.stringify(json, null, 2));
  };

  const flush = (): HookEvent[] => {
    const trailingEvents: HookEvent[] = [];
    const remainingLines = sseBuffer.flush();
    for (const line of remainingLines) {
      trailingEvents.push(...feed(`data: ${line}\n`));
    }

    const endEvent: HookEvent = {
      ...baseEvent,
      type: 'AI_HOOK_END',
      dataType: 'response',
      transport,
      format,
      status: accumulatedResponse ? 'completed' : 'unparsed',
      model,
      contentType: responseContentType,
      statusCode,
      response: accumulatedResponse
    };

    return [...trailingEvents, endEvent];
  };

  const fail = (error: unknown): HookEvent => {
    const errorMsg = error instanceof Error ? error.message : String(error || 'Unknown error');
    return {
      ...baseEvent,
      type: 'AI_HOOK_ERROR',
      dataType: 'response',
      transport,
      format,
      status: 'error',
      model,
      contentType: responseContentType,
      statusCode,
      error: errorMsg
    };
  };

  return {
    startEvent,
    setResponseMeta,
    feed,
    feedJson,
    flush,
    fail
  };
}
