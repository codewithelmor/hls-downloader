import {
  cleanVideoTitle,
  selectorsForUrl,
} from "@hls-downloader/core/lib/use-cases";
import { scripting, tabs } from "webextension-polyfill";

// Runs inside the page. Must stay self-contained: it is serialized and
// injected, so it cannot reference anything from this module.
function findTitleText(selectors: string[]): string | null {
  for (const selector of selectors) {
    const text = document.querySelector(selector)?.textContent;
    if (text && text.trim()) {
      return text;
    }
  }
  return null;
}

const READ_TIMEOUT_MS = 3000;

async function runInTab(tabId: number, selectors: string[]): Promise<unknown> {
  if (scripting?.executeScript) {
    const [result] = await scripting.executeScript({
      target: { tabId },
      func: findTitleText,
      args: [selectors],
      // Without this Chrome waits for document_idle, which can take long
      // enough on busy pages for the service worker to be shut down.
      injectImmediately: true,
    });
    return result?.result;
  }
  const [result] = await tabs.executeScript(tabId, {
    code: `(${findTitleText.toString()})(${JSON.stringify(selectors)});`,
    runAt: "document_start",
  });
  return result;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Reads the title of the video playing in a tab from a site-specific element
 * (see VIDEO_TITLE_RULES in core). Returns undefined when the site has no
 * rule, the element is missing, or the page cannot be scripted.
 */
export async function readVideoTitle(
  tabId: number | undefined,
  url: string | undefined,
): Promise<string | undefined> {
  if (tabId === undefined || tabId < 0) return undefined;
  const selectors = selectorsForUrl(url);
  if (selectors.length === 0) return undefined;
  try {
    const result = await withTimeout(
      runInTab(tabId, selectors),
      READ_TIMEOUT_MS,
    );
    return cleanVideoTitle(typeof result === "string" ? result : undefined);
  } catch (error) {
    console.warn("[capture] could not read the video title", error);
    return undefined;
  }
}
