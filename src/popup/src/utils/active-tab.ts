export type ActiveTab = { id?: number; url?: string; title?: string };

/**
 * The tab the popup was opened over. Uses the browser API directly (not
 * webextension-polyfill) so modules that need it still load outside an
 * extension, e.g. in tests and Storybook, where it resolves to undefined.
 */
export async function getActiveTab(): Promise<ActiveTab | undefined> {
  const api = (globalThis as any).browser ?? (globalThis as any).chrome;
  if (!api?.tabs?.query) return undefined;
  const query = { active: true, currentWindow: true };
  try {
    // Firefox's browser.* and Chrome MV3 return promises; Chrome MV2 only
    // takes a callback.
    const result = api.tabs.query(query);
    const tabs: ActiveTab[] =
      result && typeof result.then === "function"
        ? await result
        : await new Promise((resolve) => api.tabs.query(query, resolve));
    return tabs?.[0];
  } catch {
    return undefined;
  }
}
