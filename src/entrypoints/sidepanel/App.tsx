import { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  Edit2,
  Filter,
  Globe,
  Loader2,
  Plus,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  X
} from 'lucide-react';
import {
  clearAllSessions,
  deleteSession,
  getAllSessions,
  getFilterConfig,
  resetFilterConfig,
  saveFilterConfig
} from '@/utils/storage';
import { FilterConfig, FilterMode, ProviderRule, Session } from '@/types';
import { DEFAULT_FILTER_CONFIG } from '@/matcher/endpoint-matcher';

export default function SidePanel() {
  const [activeTab, setActiveTab] = useState<'inspector' | 'settings'>('inspector');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Filter Configuration State
  const [filterConfig, setFilterConfig] = useState<FilterConfig>(DEFAULT_FILTER_CONFIG);
  const [editingRule, setEditingRule] = useState<ProviderRule | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [formProvider, setFormProvider] = useState('');
  const [formUrlPattern, setFormUrlPattern] = useState('');
  const [formDescription, setFormDescription] = useState('');

  useEffect(() => {
    getAllSessions().then((stored) => {
      setSessions(stored);
      if (stored[0]) setSelectedId(stored[0].id);
    });

    getFilterConfig().then((config) => {
      setFilterConfig(config);
    });

    const listener = (message: any) => {
      if (message?.type === 'AI_HOOK_CONFIG_SYNC' && message.data) {
        setFilterConfig(message.data);
      }

      if (message?.type !== 'AI_HOOK_BROADCAST') return;
      const payload = message.data;
      setSessions((current) => {
        const index = current.findIndex((session) => session.id === payload.id);
        if (index < 0 && payload.type === 'AI_HOOK_START') {
          const next = [
            {
              id: payload.id,
              platform: payload.platform,
              model: payload.model,
              url: payload.url,
              timestamp: payload.timestamp,
              status: 'streaming' as const,
              prompts: payload.prompts || [],
              response: '',
              rawRequest: payload.rawRequest
            },
            ...current
          ];
          setSelectedId((selected) => selected || payload.id);
          return next;
        }
        if (index < 0) return current;
        const next = [...current];
        next[index] = {
          ...next[index],
          status:
            payload.type === 'AI_HOOK_END'
              ? payload.status || 'completed'
              : payload.type === 'AI_HOOK_ERROR'
                ? 'error'
                : 'streaming',
          response: payload.response ?? next[index].response,
          model: payload.model || next[index].model,
          error: payload.error || next[index].error
        };
        return next;
      });
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const updateAndBroadcastConfig = async (nextConfig: FilterConfig) => {
    setFilterConfig(nextConfig);
    await saveFilterConfig(nextConfig);
    chrome.runtime.sendMessage({ type: 'UPDATE_FILTER_CONFIG', data: nextConfig }).catch(() => {});
  };

  const handleToggleMode = async (mode: FilterMode) => {
    const nextConfig: FilterConfig = { ...filterConfig, mode };
    await updateAndBroadcastConfig(nextConfig);
  };

  const handleToggleRule = async (ruleId: string) => {
    const nextRules = filterConfig.rules.map((rule) =>
      rule.id === ruleId ? { ...rule, enabled: !rule.enabled } : rule
    );
    await updateAndBroadcastConfig({ ...filterConfig, rules: nextRules });
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm('确定删除该 Provider 拦截规则？')) return;
    const nextRules = filterConfig.rules.filter((rule) => rule.id !== ruleId);
    await updateAndBroadcastConfig({ ...filterConfig, rules: nextRules });
  };

  const handleResetConfig = async () => {
    if (!confirm('确定恢复所有 Provider 默认规则及白名单配置？')) return;
    const reset = await resetFilterConfig();
    setFilterConfig(reset);
    chrome.runtime.sendMessage({ type: 'RESET_FILTER_CONFIG' }).catch(() => {});
  };

  const openAddRuleModal = () => {
    setEditingRule(null);
    setFormProvider('');
    setFormUrlPattern('');
    setFormDescription('');
    setIsFormOpen(true);
  };

  const openEditRuleModal = (rule: ProviderRule) => {
    setEditingRule(rule);
    setFormProvider(rule.provider);
    setFormUrlPattern(rule.urlPattern);
    setFormDescription(rule.description || '');
    setIsFormOpen(true);
  };

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    const provider = formProvider.trim();
    const urlPattern = formUrlPattern.trim();
    if (!provider || !urlPattern) return;

    let nextRules: ProviderRule[];
    if (editingRule) {
      nextRules = filterConfig.rules.map((r) =>
        r.id === editingRule.id
          ? { ...r, provider, urlPattern, description: formDescription.trim() }
          : r
      );
    } else {
      const newRule: ProviderRule = {
        id: `rule_custom_${Date.now()}`,
        provider,
        urlPattern,
        enabled: true,
        description: formDescription.trim() || undefined
      };
      nextRules = [newRule, ...filterConfig.rules];
    }

    await updateAndBroadcastConfig({ ...filterConfig, rules: nextRules });
    setIsFormOpen(false);
  };

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1200);
  };

  const selected = sessions.find((session) => session.id === selectedId);

  return (
    <main className="flex h-screen flex-col bg-slate-950 text-slate-100 text-xs">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-slate-800 px-3 py-2.5">
        <div className="flex items-center gap-2 font-semibold">
          <Sparkles className="h-4 w-4 text-indigo-400" />
          <span>AI Hook Inspector</span>
          {activeTab === 'inspector' && (
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
              {sessions.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {activeTab === 'inspector' ? (
            <>
              <button
                title="Endpoint & Provider 过滤配置"
                onClick={() => setActiveTab('settings')}
                className="flex items-center gap-1 rounded bg-slate-900 border border-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-800 hover:text-indigo-300 transition-colors"
              >
                <Filter className="h-3.5 w-3.5 text-indigo-400" />
                <span>过滤规则</span>
              </button>
              <button
                title="Clear sessions"
                onClick={async () => {
                  if (confirm('Clear all sessions?')) {
                    await clearAllSessions();
                    setSessions([]);
                    setSelectedId(null);
                  }
                }}
                className="rounded p-1.5 text-slate-400 hover:bg-red-950/40 hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          ) : (
            <button
              onClick={() => setActiveTab('inspector')}
              className="flex items-center gap-1 rounded bg-indigo-600 px-2 py-1 text-white hover:bg-indigo-500 font-medium transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>返回捕获列表</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Tab Views */}
      {activeTab === 'inspector' ? (
        <div className="flex min-h-0 flex-1">
          {/* Session List */}
          <aside className="w-2/5 min-w-[140px] overflow-y-auto border-r border-slate-800">
            {sessions.length === 0 ? (
              <div className="p-4 text-center text-slate-500 space-y-2">
                <Globe className="mx-auto h-6 w-6 opacity-40 text-slate-400" />
                <p>暂无捕获数据</p>
                <p className="text-[10px] text-slate-600">
                  当前模式:{' '}
                  {filterConfig.mode === 'whitelist' ? '仅监控白名单 API' : '监控全部请求'}
                </p>
              </div>
            ) : (
              sessions.map((session) => (
                <button
                  key={session.id}
                  onClick={() => setSelectedId(session.id)}
                  className={`block w-full border-b border-slate-800 p-2 text-left hover:bg-slate-900 ${
                    selectedId === session.id ? 'border-l-2 border-indigo-500 bg-indigo-950/30' : ''
                  }`}
                >
                  <div className="mb-1 flex justify-between uppercase text-[10px] text-slate-400">
                    <span className="font-semibold text-indigo-300">{session.platform}</span>
                    {session.status === 'streaming' ? (
                      <Loader2 className="h-3 w-3 animate-spin text-indigo-400" />
                    ) : session.status === 'error' || session.status === 'unparsed' ? (
                      <AlertCircle className="h-3 w-3 text-amber-400" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                    )}
                  </div>
                  <div className="line-clamp-2 text-slate-200">
                    {session.prompts.at(-1)?.content || 'No prompt'}
                  </div>
                  <div className="mt-1 text-[10px] text-slate-500">
                    {new Date(session.timestamp).toLocaleTimeString()}
                  </div>
                </button>
              ))
            )}
          </aside>

          {/* Session Detail */}
          <section className="min-w-0 flex-1 overflow-y-auto p-3">
            {!selected ? (
              <div className="flex h-full items-center justify-center text-slate-500">
                Select a session
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="border-b border-slate-800 pb-3">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-indigo-950 border border-indigo-800/60 px-1.5 py-0.5 text-[10px] font-mono text-indigo-300">
                      {selected.platform}
                    </span>
                    <span className="font-semibold text-slate-100">
                      {selected.model || 'Unknown model'}
                    </span>
                  </div>
                  <div className="mt-1 break-all text-[10px] text-slate-500">
                    {selected.transport?.toUpperCase() || 'REQUEST'} · {selected.method || 'REQUEST'}{' '}
                    {selected.url}
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-500">
                    format: {selected.format || 'unknown'} · status: {selected.statusCode || 'pending'}
                  </div>
                </div>

                {/* Request */}
                <div>
                  <div className="mb-1 flex justify-between font-semibold text-indigo-300">
                    <span>Request / Prompt</span>
                    <button
                      title="Copy request"
                      onClick={() =>
                        copy(
                          JSON.stringify(selected.requestBody ?? selected.prompts, null, 2),
                          'prompt'
                        )
                      }
                      className="hover:text-white"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <pre className="whitespace-pre-wrap break-words rounded bg-slate-900 p-2 text-slate-300 border border-slate-800 max-h-56 overflow-y-auto">
                    {selected.requestBody
                      ? JSON.stringify(selected.requestBody, null, 2)
                      : selected.prompts.map((p) => `${p.role}: ${p.content}`).join('\n\n') ||
                        'Empty request'}
                  </pre>
                  {copied === 'prompt' && (
                    <span className="text-[10px] text-emerald-400">已复制请求内容</span>
                  )}
                </div>

                {/* Response */}
                <div>
                  <div className="mb-1 flex justify-between font-semibold text-emerald-400">
                    <span>Response</span>
                    <button
                      title="Copy response"
                      onClick={() => copy(selected.response, 'response')}
                      className="hover:text-white"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <pre className="min-h-24 whitespace-pre-wrap break-words rounded bg-slate-900 p-2 text-slate-200 border border-slate-800 max-h-72 overflow-y-auto">
                    {selected.response ||
                      (selected.status === 'streaming'
                        ? 'Waiting for response...'
                        : selected.status === 'unparsed'
                          ? 'Response could not be parsed.'
                          : selected.error || 'Empty response')}
                  </pre>
                  {copied === 'response' && (
                    <span className="text-[10px] text-emerald-400">已复制响应内容</span>
                  )}
                </div>

                <button
                  onClick={async () => {
                    await deleteSession(selected.id);
                    setSessions((current) => current.filter((s) => s.id !== selected.id));
                    setSelectedId(null);
                  }}
                  className="self-start rounded px-2.5 py-1 text-red-400 hover:bg-red-950/40 border border-red-900/40 transition-colors"
                >
                  Delete session
                </button>
              </div>
            )}
          </section>
        </div>
      ) : (
        /* Settings / Endpoint Mapping Tab */
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {/* Filter Mode Control */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-indigo-400" />
              <h2 className="font-semibold text-sm text-slate-100">监控过滤模式</h2>
            </div>
            <p className="text-[11px] text-slate-400">
              设置扩展如何判定是否拦截宿主页面的网络请求。
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
              <button
                onClick={() => handleToggleMode('whitelist')}
                className={`flex flex-col items-start p-2.5 rounded-lg border text-left transition-all ${
                  filterConfig.mode === 'whitelist'
                    ? 'border-indigo-500 bg-indigo-950/40 text-slate-100'
                    : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between w-full font-medium text-xs">
                  <span>白名单模式 (推荐)</span>
                  {filterConfig.mode === 'whitelist' && (
                    <Check className="h-3.5 w-3.5 text-indigo-400" />
                  )}
                </div>
                <span className="text-[10px] text-slate-400 mt-1">
                  仅拦截并解析下方已启用的 Provider 及 API Endpoint
                </span>
              </button>

              <button
                onClick={() => handleToggleMode('all')}
                className={`flex flex-col items-start p-2.5 rounded-lg border text-left transition-all ${
                  filterConfig.mode === 'all'
                    ? 'border-indigo-500 bg-indigo-950/40 text-slate-100'
                    : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between w-full font-medium text-xs">
                  <span>全量监控模式</span>
                  {filterConfig.mode === 'all' && <Check className="h-3.5 w-3.5 text-indigo-400" />}
                </div>
                <span className="text-[10px] text-slate-400 mt-1">
                  拦截所有网络流；匹配规则的附加 Provider 标签
                </span>
              </button>
            </div>
          </div>

          {/* Provider Mapping Rules */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Settings className="h-4 w-4 text-indigo-400" />
                <h2 className="font-semibold text-sm text-slate-100">
                  Provider 与 API Endpoints 映射
                </h2>
                <span className="rounded-full bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-400">
                  {filterConfig.rules.length}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  title="恢复系统预设规则"
                  onClick={handleResetConfig}
                  className="flex items-center gap-1 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-slate-400 hover:text-slate-200 hover:bg-slate-800 text-[11px]"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>重置默认</span>
                </button>
                <button
                  onClick={openAddRuleModal}
                  className="flex items-center gap-1 rounded bg-indigo-600 px-2.5 py-1 text-white hover:bg-indigo-500 font-medium text-[11px]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>添加规则</span>
                </button>
              </div>
            </div>

            {/* Rule List */}
            <div className="space-y-2">
              {filterConfig.rules.map((rule) => (
                <div
                  key={rule.id}
                  className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border p-3 transition-colors ${
                    rule.enabled
                      ? 'border-slate-800 bg-slate-900/70 text-slate-200'
                      : 'border-slate-800/40 bg-slate-950 text-slate-500 opacity-60'
                  }`}
                >
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    {/* Toggle Switch */}
                    <button
                      type="button"
                      onClick={() => handleToggleRule(rule.id)}
                      className={`relative mt-0.5 inline-flex h-4 w-8 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        rule.enabled ? 'bg-indigo-600' : 'bg-slate-700'
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          rule.enabled ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>

                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-slate-100 text-xs">
                          {rule.provider}
                        </span>
                        {rule.description && (
                          <span className="text-[10px] text-slate-400">· {rule.description}</span>
                        )}
                      </div>
                      <div className="font-mono text-[11px] text-indigo-300 break-all bg-slate-950/80 px-2 py-0.5 rounded border border-slate-800/80 inline-block max-w-full">
                        {rule.urlPattern}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 self-end sm:self-center">
                    <button
                      title="编辑规则"
                      onClick={() => openEditRuleModal(rule)}
                      className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      title="删除规则"
                      onClick={() => handleDeleteRule(rule.id)}
                      className="rounded p-1 text-slate-400 hover:bg-red-950/40 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Add/Edit Modal */}
          {isFormOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
              <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-2xl space-y-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
                  <h3 className="font-semibold text-slate-100">
                    {editingRule ? '编辑 Provider 映射规则' : '添加 Provider 映射规则'}
                  </h3>
                  <button
                    onClick={() => setIsFormOpen(false)}
                    className="text-slate-400 hover:text-white"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <form onSubmit={handleSaveRule} className="space-y-3">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-300 mb-1">
                      Provider 名称 (如 OpenAI, Claude, CustomBot)
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. OpenAI"
                      value={formProvider}
                      onChange={(e) => setFormProvider(e.target.value)}
                      className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-300 mb-1">
                      URL 匹配模式 (支持通配符 * 或 /regex/i)
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. */v1/chat/completions* or *myproxy.com/*"
                      value={formUrlPattern}
                      onChange={(e) => setFormUrlPattern(e.target.value)}
                      className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                    />
                    <p className="mt-1 text-[10px] text-slate-400">
                      例如：<code>*openai.com/v1/chat*</code>、<code>*/v1/chat/completions*</code> 或{' '}
                      <code>/api\/v1\/chat/i</code>
                    </p>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-300 mb-1">
                      备注说明 (可选)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 公司自建大模型网关"
                      value={formDescription}
                      onChange={(e) => setFormDescription(e.target.value)}
                      className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
                    <button
                      type="button"
                      onClick={() => setIsFormOpen(false)}
                      className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                    >
                      保存规则
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
