import { describe, expect, it } from "vitest";
import { MpdParser } from "../src/services/mpd-parser";
import { StreamParser } from "../src/services/stream-parser";

const MANIFEST = "https://cdn.example.com/x/manifest.mpd?auth=abc";

const templateMpd = (protection = "") => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S" minBufferTime="PT2S">
 <Period id="p0">
  <AdaptationSet mimeType="video/mp4" contentType="video">
   ${protection}
   <SegmentTemplate timescale="1000" duration="4000" startNumber="1" initialization="v/$RepresentationID$/init.mp4" media="v/$RepresentationID$/seg-$Number$.m4s"/>
   <Representation id="720p" bandwidth="2000000" width="1280" height="720" frameRate="30"/>
   <Representation id="360p" bandwidth="600000" width="640" height="360"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en">
   <SegmentTemplate timescale="1000" duration="4000" startNumber="1" initialization="a/init.mp4" media="a/seg-$Number$.m4s"/>
   <Representation id="aud" bandwidth="128000"/>
  </AdaptationSet>
  <AdaptationSet mimeType="text/vtt" contentType="text" lang="en">
   <Representation id="sub" bandwidth="1"><BaseURL>subs/en.vtt</BaseURL></Representation>
  </AdaptationSet>
 </Period>
</MPD>`;

const segmentBaseMpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S" minBufferTime="PT2S">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <Representation id="v" bandwidth="900000" width="854" height="480">
    <BaseURL>video-480.mp4</BaseURL>
    <SegmentBase indexRange="800-1200"><Initialization range="0-799"/></SegmentBase>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`;

const segmentListMpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT8S" minBufferTime="PT2S">
 <Period>
  <AdaptationSet mimeType="video/mp4">
   <Representation id="v" bandwidth="500000" width="640" height="360">
    <BaseURL>media.mp4</BaseURL>
    <SegmentList timescale="1000" duration="4000">
     <Initialization range="0-499"/>
     <SegmentURL mediaRange="500-999"/>
     <SegmentURL mediaRange="1000-1499"/>
    </SegmentList>
   </Representation>
  </AdaptationSet>
 </Period>
</MPD>`;

const levels = MpdParser.parseMasterPlaylist(templateMpd(), MANIFEST);
const byType = (type: string) => levels.filter((l) => l.type === type);
const fragmentsFor = (text: string, uri: string) =>
  MpdParser.parseLevelPlaylist(text, uri).map((f) => [
    f.index,
    f.uri,
    f.byteRange,
  ]);

describe("MpdParser.parseMasterPlaylist", () => {
  it("lists each video representation with its quality", () => {
    expect(byType("stream")).toEqual([
      expect.objectContaining({
        width: 1280,
        height: 720,
        bitrate: 2000000,
        fps: 30,
        audioGroupId: "audio",
        playlistID: MANIFEST,
      }),
      expect.objectContaining({ width: 640, height: 360, bitrate: 600000 }),
    ]);
  });

  it("links audio tracks to video through the audio group", () => {
    const [audio] = byType("audio");
    expect(audio).toMatchObject({ groupId: "audio", language: "en" });
    expect(byType("stream")[0].audioGroupId).toBe(audio.groupId);
  });

  it("lists WebVTT subtitles", () => {
    expect(byType("subtitle")).toEqual([
      expect.objectContaining({ language: "en" }),
    ]);
  });

  it("gives every track a distinct, stable id and a manifest URI", () => {
    const ids = levels.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(MpdParser.parseMasterPlaylist(templateMpd(), MANIFEST)).toEqual(
      levels,
    );
    for (const level of levels) {
      expect(level.uri.startsWith(`${MANIFEST}#`)).toBe(true);
    }
  });
});

describe("MpdParser.parseLevelPlaylist", () => {
  it("returns the init segment followed by the selected video's segments", () => {
    const [, low] = byType("stream");
    expect(fragmentsFor(templateMpd(), low.uri)).toEqual([
      [0, "https://cdn.example.com/x/v/360p/init.mp4", null],
      [1, "https://cdn.example.com/x/v/360p/seg-1.m4s", null],
      [2, "https://cdn.example.com/x/v/360p/seg-2.m4s", null],
      [3, "https://cdn.example.com/x/v/360p/seg-3.m4s", null],
    ]);
  });

  it("returns the audio track's segments", () => {
    const [audio] = byType("audio");
    expect(fragmentsFor(templateMpd(), audio.uri)).toEqual([
      [0, "https://cdn.example.com/x/a/init.mp4", null],
      [1, "https://cdn.example.com/x/a/seg-1.m4s", null],
      [2, "https://cdn.example.com/x/a/seg-2.m4s", null],
      [3, "https://cdn.example.com/x/a/seg-3.m4s", null],
    ]);
  });

  it("downloads a single-file (SegmentBase) representation whole", () => {
    const [level] = MpdParser.parseMasterPlaylist(segmentBaseMpd, MANIFEST);
    expect(fragmentsFor(segmentBaseMpd, level.uri)).toEqual([
      [0, "https://cdn.example.com/x/video-480.mp4", null],
    ]);
  });

  it("keeps SegmentList byte ranges", () => {
    const [level] = MpdParser.parseMasterPlaylist(segmentListMpd, MANIFEST);
    expect(fragmentsFor(segmentListMpd, level.uri)).toEqual([
      [0, "https://cdn.example.com/x/media.mp4", { offset: 0, length: 500 }],
      [1, "https://cdn.example.com/x/media.mp4", { offset: 500, length: 500 }],
      [2, "https://cdn.example.com/x/media.mp4", { offset: 1000, length: 500 }],
    ]);
  });

  it("uses the first video track when the manifest is opened directly", () => {
    expect(fragmentsFor(templateMpd(), MANIFEST)[0]).toEqual([
      0,
      "https://cdn.example.com/x/v/720p/init.mp4",
      null,
    ]);
  });

  it("returns nothing for a track that is not in the manifest", () => {
    const missing = `${MANIFEST}#hlsd-dash-track=${encodeURIComponent('["video",9]')}`;
    expect(MpdParser.parseLevelPlaylist(templateMpd(), missing)).toEqual([]);
  });
});

describe("MpdParser.inspectLevelEncryption", () => {
  const widevine =
    '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>';

  it("reports no encryption for clear media", () => {
    const [video] = byType("stream");
    expect(
      MpdParser.inspectLevelEncryption(templateMpd(), video.uri).methods,
    ).toEqual([]);
  });

  it("reports DRM with the key system name", () => {
    const text = templateMpd(widevine);
    const [video] = MpdParser.parseMasterPlaylist(text, MANIFEST);
    expect(MpdParser.inspectLevelEncryption(text, video.uri).methods).toEqual([
      "DRM-protected DASH (Widevine)",
    ]);
  });

  it("reports encryption the parser cannot name", () => {
    const text = templateMpd(
      '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>',
    );
    const [video] = MpdParser.parseMasterPlaylist(text, MANIFEST);
    expect(MpdParser.inspectLevelEncryption(text, video.uri).methods).toEqual([
      "DRM-protected DASH (CENC)",
    ]);
  });

  it("names the DRM system when the generic scheme is also listed", () => {
    const text = templateMpd(
      '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>' +
        widevine,
    );
    const [video] = MpdParser.parseMasterPlaylist(text, MANIFEST);
    expect(MpdParser.inspectLevelEncryption(text, video.uri).methods).toEqual([
      "DRM-protected DASH (Widevine)",
    ]);
  });

  it("does not flag clear audio next to protected video", () => {
    const text = templateMpd(widevine);
    const audio = MpdParser.parseMasterPlaylist(text, MANIFEST).find(
      (l) => l.type === "audio",
    )!;
    expect(MpdParser.inspectLevelEncryption(text, audio.uri).methods).toEqual(
      [],
    );
  });
});

describe("StreamParser", () => {
  const hls = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow.m3u8\n";

  it("reads DASH manifests with the DASH parser", () => {
    expect(StreamParser.parseMasterPlaylist(templateMpd(), MANIFEST)).toEqual(
      levels,
    );
  });

  it("still reads HLS playlists with the HLS parser", () => {
    const [level] = StreamParser.parseMasterPlaylist(
      hls,
      "https://cdn.example.com/master.m3u8",
    );
    expect(level).toMatchObject({
      type: "stream",
      uri: "https://cdn.example.com/low.m3u8",
      bitrate: 1000,
    });
  });
});
