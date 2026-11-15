import { describe, expect, it } from "vitest";
import { describeBlockedTracks } from "./PlaylistView";

const summary = (
  label: string,
  method: string | null,
  supported: boolean,
  message?: string,
) => ({ label, method, supported, message, keyUris: [], pending: false });

describe("describeBlockedTracks", () => {
  it("names the DRM system and merges tracks that share a reason", () => {
    const drm =
      "Protected by Widevine DRM. The decryption key is only released to the browser's built-in DRM module, so this stream can be played but not downloaded.";
    const result = describeBlockedTracks([
      summary("Video", "DRM-protected DASH (Widevine)", false, drm),
      summary("Audio", "DRM-protected DASH (Widevine)", false, drm),
    ]);

    expect(result.headline).toBe("Download blocked by Widevine DRM.");
    expect(result.reasons).toEqual([
      { tracks: "Video and Audio", message: drm },
    ]);
  });

  it("names an unsupported HLS method and ignores supported tracks", () => {
    const result = describeBlockedTracks([
      summary(
        "Video",
        "SAMPLE-AES",
        false,
        "Unsupported encryption method: SAMPLE-AES.",
      ),
      summary("Audio", "AES-128", true),
    ]);

    expect(result.headline).toBe("Download blocked by SAMPLE-AES encryption.");
    expect(result.reasons).toEqual([
      {
        tracks: "Video",
        message: "Unsupported encryption method: SAMPLE-AES.",
      },
    ]);
  });

  it("falls back when the method is unknown", () => {
    const result = describeBlockedTracks([summary("Video", null, false)]);

    expect(result.headline).toBe("Download blocked by unsupported encryption.");
    expect(result.reasons[0].message).toBe("Unsupported encryption.");
  });
});
