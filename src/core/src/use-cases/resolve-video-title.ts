export type VideoTitleRule = {
  hostPattern: RegExp;
  selectors: string[];
};

// Sites whose page title is too generic to name a download. Each rule lists
// CSS selectors, in order, for the element that holds the playing video's
// title. The background script reads the first match when a stream is captured.
export const VIDEO_TITLE_RULES: VideoTitleRule[] = [
  {
    hostPattern: /(^|\.)udemy\.com$/i,
    selectors: [
      'li[aria-current="true"] [data-purpose="item-title"]',
      '[aria-current="true"] [data-purpose="item-title"]',
    ],
  },
];

export const selectorsForUrl = (url: string | undefined): string[] => {
  if (!url) return [];
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return [];
  }
  const rule = VIDEO_TITLE_RULES.find((r) => r.hostPattern.test(hostname));
  return rule ? [...rule.selectors] : [];
};

export const cleanVideoTitle = (
  text: string | null | undefined
): string | undefined => {
  if (typeof text !== "string") return undefined;
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : undefined;
};
