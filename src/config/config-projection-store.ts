import type { DebugUiConfig } from './config-projections';

const DEBUG_UI_CONFIG_KEY = 'debug-ui-config-v1';

export async function saveDebugUiConfig(config: DebugUiConfig): Promise<void> {
  await chrome.storage.local.set({ [DEBUG_UI_CONFIG_KEY]: config });
}

export async function loadDebugUiConfig(): Promise<DebugUiConfig | null> {
  const result = await chrome.storage.local.get(DEBUG_UI_CONFIG_KEY);
  const value = result[DEBUG_UI_CONFIG_KEY];
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.revision !== 'string' ||
    typeof candidate.refreshIntervalMs !== 'number' ||
    typeof candidate.pageSize !== 'number' ||
    typeof candidate.defaultBodyView !== 'string' ||
    !['hex', 'base64', 'text'].includes(candidate.defaultBodyView)
  ) {
    return null;
  }
  return candidate as unknown as DebugUiConfig;
}