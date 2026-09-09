export function getClientContext(): { extensionVersion: string; browser: 'chrome' } {
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    browser: 'chrome',
  };
}