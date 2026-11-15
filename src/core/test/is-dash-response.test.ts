import { describe, expect, it } from "vitest";
import {
  isDashManifestText,
  isDashResponse,
} from "../src/use-cases/is-dash-response.ts";
import { getPlaylistDocumentFactory } from "../src/use-cases/get-playlist-document.ts";

describe("isDashResponse", () => {
  it.each([
    ["https://cdn.example.com/a/manifest.mpd", ""],
    ["https://cdn.example.com/a/MANIFEST.MPD?token=1", "text/plain"],
    ["https://cdn.example.com/a/manifest", "application/dash+xml"],
    [
      "https://cdn.example.com/a/manifest",
      "Application/DASH+XML; charset=utf-8",
    ],
  ])("accepts %s (%s)", (uri, type) => {
    expect(isDashResponse(uri, type)).toBe(true);
  });

  it.each([
    ["https://cdn.example.com/a/master.m3u8", "application/x-mpegurl"],
    ["https://cdn.example.com/a/mpd.js", "text/javascript"],
    ["blob:https://example.com/123", "application/dash+xml"],
  ])("rejects %s (%s)", (uri, type) => {
    expect(isDashResponse(uri, type)).toBe(false);
  });
});

describe("isDashManifestText", () => {
  it.each([
    '<?xml version="1.0" encoding="UTF-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">',
    '﻿<MPD type="static">',
    "<!-- generated -->\n<MPD>",
    '<dash:MPD xmlns:dash="urn:mpeg:dash:schema:mpd:2011">',
  ])("recognises %j", (text) => {
    expect(isDashManifestText(text)).toBe(true);
  });

  it.each(["#EXTM3U\n#EXT-X-VERSION:3", "WEBVTT\n", "<html><MPD>"])(
    "rejects %j",
    (text) => {
      expect(isDashManifestText(text)).toBe(false);
    },
  );
});

describe("getPlaylistDocument with a DASH track fragment", () => {
  const level = {
    type: "stream" as const,
    id: "v",
    playlistID: "https://cdn.example.com/m.mpd",
    uri: "https://cdn.example.com/m.mpd#hlsd-dash-track=x",
  };

  it("keeps the track fragment on the fetched document's URI", async () => {
    const loader = {
      fetchText: async () => "",
      fetchArrayBuffer: async () => new Uint8Array(),
      // Real fetch responses report the URL without its fragment.
      fetchTextResponse: async () => ({
        text: "<MPD/>",
        uri: "https://cdn.example.com/m.mpd",
      }),
    };
    const document = await getPlaylistDocumentFactory(loader as any)(level, 1);
    expect(document.uri).toBe(level.uri);
    expect(document.baseUri).toBe(level.playlistID);
  });

  it("keeps the fragment across a redirect and uses the new base", async () => {
    const loader = {
      fetchText: async () => "",
      fetchArrayBuffer: async () => new Uint8Array(),
      fetchTextResponse: async () => ({
        text: "<MPD/>",
        uri: "https://edge.example.com/m.mpd?sig=2",
      }),
    };
    const document = await getPlaylistDocumentFactory(loader as any)(level, 1);
    expect(document.uri).toBe(
      "https://edge.example.com/m.mpd?sig=2#hlsd-dash-track=x",
    );
    expect(document.baseUri).toBe("https://edge.example.com/m.mpd?sig=2");
  });
});
