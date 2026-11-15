const DASH_TYPES = new Set(["application/dash+xml"]);

/** True when a response is an MPEG-DASH manifest (by MIME type or .mpd path). */
export function isDashResponse(uri: string, contentType: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const mime = contentType.split(";")[0].trim().toLowerCase();
    return DASH_TYPES.has(mime) || /\.mpd$/i.test(url.pathname);
  } catch {
    return false;
  }
}

/** True when manifest text is an MPEG-DASH MPD document rather than HLS. */
export function isDashManifestText(text: string): boolean {
  // Skip a BOM, the XML declaration and comments; the root element is <MPD>.
  return /^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:[\w-]+:)?MPD[\s>]/.test(
    text,
  );
}
