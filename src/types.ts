export type Prompt = { role: string; content: string };

export type SessionStatus = 'streaming' | 'completed' | 'unparsed' | 'error';
export type TransportType = 'fetch' | 'xhr';
export type ResponseFormat = 'sse' | 'json' | 'text' | 'unknown';

export interface ProviderRule {
  id: string;
  provider: string;
  urlPattern: string;
  enabled: boolean;
  description?: string;
}

export type FilterMode = 'whitelist' | 'all';

export interface FilterConfig {
  mode: FilterMode;
  rules: ProviderRule[];
}

export type Session = {
  id: string;
  platform: string;
  model?: string;
  url: string;
  timestamp: number;
  status: SessionStatus;
  prompts: Prompt[];
  response: string;
  transport?: TransportType;
  format?: ResponseFormat;
  method?: string;
  requestBody?: unknown;
  requestContentType?: string;
  responseContentType?: string;
  statusCode?: number;
  rawRequest?: unknown;
  durationMs?: number;
  error?: string;
};

export type HookEvent = {
  type: 'AI_HOOK_START' | 'AI_HOOK_CHUNK' | 'AI_HOOK_END' | 'AI_HOOK_ERROR';
  id: string;
  platform?: string;
  model?: string;
  url?: string;
  timestamp?: number;
  prompts?: Prompt[];
  response?: string;
  rawRequest?: unknown;
  delta?: string;
  status?: SessionStatus;
  error?: string;
  dataType?: 'request' | 'response';
  transport?: TransportType;
  format?: ResponseFormat;
  method?: string;
  contentType?: string;
  statusCode?: number;
};
