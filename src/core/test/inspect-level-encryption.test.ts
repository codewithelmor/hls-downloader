import { describe, it, expect, vi } from "vitest";
import { Level } from "../src/entities";
import {
  describeUnsupportedEncryption,
  inspectLevelEncryptionFactory,
} from "../src/use-cases";
import type { ILoader, IParser } from "../src/services";

describe("inspectLevelEncryptionFactory", () => {
  const level = new Level(
    "stream",
    "level-1",
    "playlist-1",
    "http://example.com/level.m3u8",
  );

  it("marks AES-128 as supported", async () => {
    const loader: ILoader = {
      fetchText: vi.fn().mockResolvedValue("#EXTM3U"),
      fetchArrayBuffer: vi.fn(),
    };
    const parser: IParser = {
      parseMasterPlaylist: vi.fn(),
      parseLevelPlaylist: vi.fn(),
      inspectLevelEncryption: vi.fn().mockReturnValue({
        methods: ["AES-128"],
        keyUris: ["http://example.com/key"],
        iv: "0x1",
      }),
    };

    const run = inspectLevelEncryptionFactory(loader, parser);
    const result = await run(level, 2);

    expect(loader.fetchText).toHaveBeenCalledWith(
      "http://example.com/level.m3u8",
      2,
    );
    expect(parser.inspectLevelEncryption).toHaveBeenCalled();
    expect(result).toMatchObject({
      levelId: "level-1",
      playlistId: "playlist-1",
      method: "AES-128",
      supported: true,
      keyUris: ["http://example.com/key"],
      iv: "0x1",
    });
    expect(result.message).toBeUndefined();
  });

  it("returns unsupported when method is not allowed", async () => {
    const loader: ILoader = {
      fetchText: vi.fn().mockResolvedValue("#EXTM3U"),
      fetchArrayBuffer: vi.fn(),
    };
    const parser: IParser = {
      parseMasterPlaylist: vi.fn(),
      parseLevelPlaylist: vi.fn(),
      inspectLevelEncryption: vi.fn().mockReturnValue({
        methods: ["SAMPLE-AES"],
        keyUris: [],
        iv: null,
      }),
    };

    const run = inspectLevelEncryptionFactory(loader, parser);
    const result = await run(level, 1);

    expect(result.supported).toBe(false);
    expect(result.method).toBe("SAMPLE-AES");
    expect(result.message).toContain("Unsupported encryption method");
    expect(result.message).toContain("Only AES-128");
  });
});

describe("describeUnsupportedEncryption", () => {
  it("names the DRM system and explains why it blocks the download", () => {
    const message = describeUnsupportedEncryption(
      "DRM-protected DASH (Widevine, PlayReady)",
    );
    expect(message).toContain("Protected by Widevine, PlayReady DRM");
    expect(message).toContain("played but not downloaded");
  });

  it("names an unsupported HLS method", () => {
    expect(describeUnsupportedEncryption("SAMPLE-AES")).toBe(
      "Unsupported encryption method: SAMPLE-AES. Only AES-128 streams can be decrypted.",
    );
  });

  it("handles an unknown method", () => {
    expect(describeUnsupportedEncryption(null)).toBe(
      "Unsupported encryption method detected.",
    );
  });
});
