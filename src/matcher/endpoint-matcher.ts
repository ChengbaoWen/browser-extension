import { FilterConfig, ProviderRule } from '../types';

export interface MatchResult {
  matched: boolean;
  provider?: string;
  ruleId?: string;
}

export const DEFAULT_PROVIDER_RULES: ProviderRule[] = [
  {
    id: 'rule_chatgpt',
    provider: 'ChatGPT',
    urlPattern: '*chatgpt.com/backend-api/conversation*',
    enabled: true,
    description: 'ChatGPT Web 对话流'
  },
  {
    id: 'rule_openai',
    provider: 'OpenAI',
    urlPattern: '*/v1/chat/completions*',
    enabled: true,
    description: 'OpenAI 及兼容 WebUI (NextChat, LobeChat, etc.)'
  },
  {
    id: 'rule_claude',
    provider: 'Claude',
    urlPattern: '*claude.ai/api/organizations/*/chat_conversations*',
    enabled: true,
    description: 'Claude Web 对话接口'
  },
  {
    id: 'rule_deepseek',
    provider: 'DeepSeek',
    urlPattern: '*chat.deepseek.com/api/v0/chat/completion*',
    enabled: true,
    description: 'DeepSeek Web 对话流'
  },
  {
    id: 'rule_kimi',
    provider: 'Kimi',
    urlPattern: '*kimi.moonshot.cn/api/chat/*/completion/stream*',
    enabled: true,
    description: 'Kimi 智能助手流式接口'
  },
  {
    id: 'rule_qwen',
    provider: 'Qwen',
    urlPattern: '*tongyi.aliyun.com/api/v1/conversation*',
    enabled: true,
    description: '通义千问 Web 对话'
  },
  {
    id: 'rule_dashscope',
    provider: 'DashScope',
    urlPattern: '*dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation*',
    enabled: true,
    description: '通义百炼 DashScope 文本生成 API'
  },
  {
    id: 'rule_ollama',
    provider: 'Ollama',
    urlPattern: '*:11434/api/*',
    enabled: true,
    description: 'Ollama 本地大模型接口'
  },
  {
    id: 'rule_siliconflow',
    provider: 'SiliconFlow',
    urlPattern: '*api.siliconflow.cn/v1/chat/completions*',
    enabled: true,
    description: '硅基流动云端推理 API'
  },
  {
    id: 'rule_openrouter',
    provider: 'OpenRouter',
    urlPattern: '*openrouter.ai/api/v1/chat/completions*',
    enabled: true,
    description: 'OpenRouter 统一路由 API'
  }
];

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  mode: 'whitelist',
  rules: DEFAULT_PROVIDER_RULES
};

function patternToRegex(pattern: string): RegExp | null {
  const trimmed = pattern.trim();
  if (!trimmed) return null;

  // Custom regex format: /pattern/flags
  if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
    const lastSlash = trimmed.lastIndexOf('/');
    const body = trimmed.slice(1, lastSlash);
    const flags = trimmed.slice(lastSlash + 1);
    try {
      return new RegExp(body, flags.includes('i') ? flags : flags + 'i');
    } catch {
      // Invalid regex, fallback to wildcard
    }
  }

  // Convert wildcard pattern to RegExp
  // Escape special regex characters except '*'
  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');

  // If pattern starts with '/', match pathname or full URL
  if (trimmed.startsWith('/')) {
    return new RegExp(`(?:https?:\\/\\/[^/]+)?${escaped}`, 'i');
  }

  // If pattern has no scheme and doesn't start with wildcard/slash, match anywhere
  if (!trimmed.includes('://') && !trimmed.startsWith('*')) {
    return new RegExp(`.*${escaped}.*`, 'i');
  }

  return new RegExp(`^${escaped}$`, 'i');
}

export function matchEndpoint(url: string, rules: ProviderRule[]): MatchResult {
  if (!url) return { matched: false };

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const regex = patternToRegex(rule.urlPattern);
    if (regex && regex.test(url)) {
      return {
        matched: true,
        provider: rule.provider,
        ruleId: rule.id
      };
    }
  }

  return { matched: false };
}

export function shouldInterceptUrl(url: string, config: FilterConfig): { intercept: boolean; provider?: string } {
  const match = matchEndpoint(url, config.rules || []);

  if (config.mode === 'whitelist') {
    return {
      intercept: match.matched,
      provider: match.provider
    };
  }

  // mode === 'all': intercept everything, use matched provider or fallback to 'generic-raw'
  return {
    intercept: true,
    provider: match.provider || 'generic-raw'
  };
}
