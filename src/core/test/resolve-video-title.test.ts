import { describe, expect, it } from "vitest";
import {
  cleanVideoTitle,
  selectorsForUrl,
} from "../src/use-cases/resolve-video-title";
import { generateFileName } from "../src/use-cases/generate-file-name";
import { generateSubtitleFileName } from "../src/use-cases/generate-subtitle-file-name";
import { Level, Playlist } from "../src/entities";

describe("selectorsForUrl", () => {
  it.each([
    "https://www.udemy.com/course/js/learn/lecture/40101198",
    "https://udemy.com/course/js/learn/lecture/1",
    "https://acme.udemy.com/course/js/learn/lecture/1",
  ])("returns the lecture title selectors for %s", (url) => {
    expect(selectorsForUrl(url)).toContain(
      'li[aria-current="true"] [data-purpose="item-title"]',
    );
  });

  it.each([
    "https://example.com/video",
    "https://notudemy.com/course",
    "https://udemy.com.evil.test/course",
    "not a url",
    undefined,
  ])("returns no selectors for %s", (url) => {
    expect(selectorsForUrl(url)).toEqual([]);
  });
});

describe("cleanVideoTitle", () => {
  it("trims and collapses whitespace", () => {
    expect(cleanVideoTitle("  23. Introducing\n   the Modulo ")).toBe(
      "23. Introducing the Modulo",
    );
  });

  it.each([null, undefined, "", "   \n"])("returns undefined for %j", (v) => {
    expect(cleanVideoTitle(v)).toBeUndefined();
  });
});

describe("file names with a captured video title", () => {
  const level = new Level("stream", "English", "1", "uri");
  const playlist = new Playlist(
    "1",
    "https://cdn.example.com/a/index.m3u8?token=x",
    0,
    "JavaScript Course | Udemy",
    "https://www.udemy.com/course/js/learn/lecture/1",
    3,
    "23. Introducing the Modulo",
  );

  it("names the video after the captured title", () => {
    expect(generateFileName()(playlist, level)).toBe(
      "23. Introducing the Modulo.mp4",
    );
    expect(generateFileName()(playlist, level, { container: "mkv" })).toBe(
      "23. Introducing the Modulo.mkv",
    );
  });

  it("names subtitles after the captured title", () => {
    expect(generateSubtitleFileName()(playlist, level)).toBe(
      "23. Introducing the Modulo-English.vtt",
    );
  });

  it("falls back to the page title when the captured title sanitizes to nothing", () => {
    const blank = new Playlist(
      "1",
      "https://cdn.example.com/a/index.m3u8",
      0,
      "Course",
      undefined,
      undefined,
      "\u200d",
    );
    expect(generateFileName()(blank, level)).toBe("Course-index.mp4");
  });
});
