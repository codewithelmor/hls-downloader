import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHlsServer, HlsServer } from "./helpers/hls-server";
import {
  FFmpegHostAdapter,
  ffprobe,
  isFFmpegAvailable,
} from "./helpers/ffmpeg-host-adapter";

vi.mock("@ffmpeg/ffmpeg", () => ({ FFmpeg: class {} }));

import {
  getFragmentsDetailsFactory,
  getLevelsFactory,
} from "@hls-downloader/core/lib/use-cases";
import { FetchLoader } from "../src/services/fetch-loader";
import { StreamParser } from "../src/services/stream-parser";
import { writeMediaToFFmpegFS, muxExec } from "../src/services/ffmpeg-muxer";

const ffmpegAvailable = isFFmpegAvailable();
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? "ffmpeg";
const FIXTURES_DIR = path.join(__dirname, "fixtures");

/**
 * Packages a muxed TS fixture as a real, unencrypted MPEG-DASH stream. ffmpeg
 * runs inside `dir` with a relative output name: given an absolute Windows
 * path, its DASH muxer writes segments to the working directory instead.
 */
function packageDash(dir: string) {
  execFileSync(
    FFMPEG_PATH,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path.join(FIXTURES_DIR, "video-audio-muxed.ts"),
      "-map",
      "0:v",
      "-map",
      "0:a",
      "-c",
      "copy",
      // Copying from MPEG-TS keeps TS codec tags, which MP4 rejects.
      "-tag:v",
      "avc1",
      "-tag:a",
      "mp4a",
      "-bsf:a",
      "aac_adtstoasc",
      "-f",
      "dash",
      "-seg_duration",
      "1",
      "-use_template",
      "1",
      // A SegmentTimeline lists the real segment lengths; with stream copy,
      // segments can only start on the source's keyframes.
      "-use_timeline",
      "1",
      "-adaptation_sets",
      "id=0,streams=v id=1,streams=a",
      "manifest.mpd",
    ],
    { cwd: dir },
  );
}

describe.skipIf(!ffmpegAvailable)("DASH download E2E (host ffmpeg)", () => {
  let dir: string;
  let server: HlsServer;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-e2e-"));
    packageDash(dir);
    server = await createHlsServer(dir);
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function downloadTrack(
    level: Parameters<ReturnType<typeof getFragmentsDetailsFactory>>[0],
  ) {
    const fragments = await getFragmentsDetailsFactory(
      FetchLoader,
      StreamParser,
    )(level, 1);
    expect(fragments.length).toBeGreaterThan(1);
    const parts: Uint8Array[] = [];
    for (const fragment of fragments) {
      parts.push(
        new Uint8Array(
          await FetchLoader.fetchArrayBuffer(
            fragment.uri,
            1,
            fragment.byteRange,
          ),
        ),
      );
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  it("downloads a captured DASH manifest into a playable MP4", async () => {
    const manifestUrl = `${server.baseUrl}/manifest.mpd`;
    const levels = await getLevelsFactory(FetchLoader, StreamParser)(
      manifestUrl,
      1,
    );

    const video = levels.find((l) => l.type === "stream")!;
    const audio = levels.find(
      (l) => l.type === "audio" && l.groupId === video.audioGroupId,
    )!;
    expect(video).toBeDefined();
    expect(audio).toBeDefined();
    expect(video.height).toBeGreaterThan(0);

    const adapter = await FFmpegHostAdapter.create();
    try {
      await writeMediaToFFmpegFS(
        adapter as any,
        "video.mp4",
        await downloadTrack(video),
      );
      await writeMediaToFFmpegFS(
        adapter as any,
        "audio.mp4",
        await downloadTrack(audio),
      );
      const result = await muxExec({
        ffmpeg: adapter as any,
        outputFileName: "output.mp4",
        hasVideo: true,
        hasAudio: true,
        videoFileName: "video.mp4",
        audioFileName: "audio.mp4",
      });

      const file = path.join(dir, "output.mp4");
      fs.writeFileSync(file, new Uint8Array(await result.blob.arrayBuffer()));
      const probe = await ffprobe(file);

      expect(probe.streams.map((s) => s.codec_type).sort()).toEqual([
        "audio",
        "video",
      ]);
      expect(probe.streams.find((s) => s.codec_type === "video")).toMatchObject(
        { codec_name: "h264", height: video.height },
      );
      expect(Number(probe.duration)).toBeGreaterThan(1);
    } finally {
      await adapter.cleanup();
    }
  }, 60_000);
});
