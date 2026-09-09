import type { LocalConsent } from './system-config';

export const LOCAL_CONSENT_STORAGE_KEY = 'local-consent-v1';
const DEFAULT_CONSENT: LocalConsent = {
  deliveryEnabled: false,
};

export interface LocalConsentSource {
  load(): Promise<LocalConsent>;
}

export class ChromeLocalConsentSource implements LocalConsentSource {
  async load(): Promise<LocalConsent> {
    const result = await chrome.storage.local.get(LOCAL_CONSENT_STORAGE_KEY);
    const value = result[LOCAL_CONSENT_STORAGE_KEY];
    if (!isLocalConsent(value)) return DEFAULT_CONSENT;
    return { ...value };
  }
}

export async function setLocalConsent(consent: LocalConsent): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_CONSENT_STORAGE_KEY]: { ...consent } });
}

export async function toggleDeliveryConsent(): Promise<LocalConsent> {
  const source = new ChromeLocalConsentSource();
  const current = await source.load();
  const next = { ...current, deliveryEnabled: !current.deliveryEnabled };
  await setLocalConsent(next);
  return next;
}

function isLocalConsent(value: unknown): value is LocalConsent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.deliveryEnabled === 'boolean';
}