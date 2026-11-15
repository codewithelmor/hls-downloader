import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  FFmpegHostAdapter,
  ffprobe,
  isFFmpegAvailable,
} from "./helpers/ffmpeg-host-adapter";

vi.mock("@ffmpeg/ffmpeg", () => ({ FFmpeg: class {} }));

import {
  Fmp4StreamSplitter,
  saveCapturedSourceFactory,
} from "@hls-downloader/core/lib/use-cases";
import { PlayerCaptureService } from "../src/services/player-capture";
import { CAPTURE_PORT_NAME } from "../src/capture/protocol";
import { muxExec, writeMediaToFFmpegFS } from "../src/services/ffmpeg-muxer";

const ffmpegAvailable = isFFmpegAvailable();
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? "ffmpeg";
const FIXTURE = path.join(__dirname, "fixtures", "video-audio-muxed.ts");

/** Packages one track as fragmented MP4, the way players append it to MSE. */
function fragmentedTrack(dir: string, track: "v" | "a"): Uint8Array {
  const name = `${track}.mp4`;
  execFileSync(
    FFMPEG_PATH,
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      FIXTURE,
      "-map",
      `0:${track}`,
      "-c",
      "copy",
      ...(track === "v" ? ["-tag:v", "avc1"] : ["-bsf:a", "aac_adtstoasc"]),
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-frag_duration",
      "500000",
      name,
    ],
    { cwd: dir },
  );
  return new Uint8Array(fs.readFileSync(path.join(dir, name)));
}

/**
 * Plays a track the way a player with seeks would: the init segment first,
 * then media segments out of order with some fetched twice, each split into
 * appends of uneven sizes.
 */
function playerAppends(file: Uint8Array): Uint8Array[] {
  const segments = new Fmp4StreamSplitter().push(file);
  const [init, ...media] = segments.map((segment) => segment.bytes);
  expect(media.length).toBeGreaterThan(3);
  const order = [
    ...media.slice(2),
    ...media.slice(0, 3), // seek back to the start: segment 2 again
    media[media.length - 1], // and the last one again
  ];
  const appends: Uint8Array[] = [];
  let cut = 0;
  for (const bytes of [init, ...order]) {
    const at = Math.min(bytes.length - 1, 11 + (cut++ % 5) * 97);
    appends.push(bytes.slice(0, at), bytes.slice(at));
  }
  return appends;
}

function memoryEnvironment() {
  const stored = new Map<string, Uint8Array>();
  return new PlayerCaptureService({
    getTab: async () => ({ url: "https://example.com/watch", title: "Clip" }),
    reloadTab: async () => undefined,
    registerScripts: async () => undefined,
    unregisterScripts: async () => undefined,
    getRegisteredScriptIds: async () => [],
    isBlocked: () => false,
    readVideoTitle: async () => undefined,
    storage: {
      write: async (session, id, data) => {
        stored.set(`${session}/${id}`, data.slice());
      },
      read: async (session, id) =>
        stored.get(`${session}/${id}`)!.slice().buffer,
      deleteSession: async () => undefined,
    },
  });
}

function memoryFs() {
  const buckets = new Map<string, Map<number, Uint8Array>>();
  const lengths = new Map<string, [number, number]>();
  return {
    fs: {
      createBucket: async (id: string, video: number, audio: number) => {
        buckets.set(id, new Map());
        lengths.set(id, [video, audio]);
      },
      getBucket: async (id: string) => ({
        write: async (index: number, data: ArrayBuffer) => {
          buckets.get(id)!.set(index, new Uint8Array(data));
        },
      }),
      deleteBucket: async () => undefined,
    } as any,
    /** Joins a track's chunks the way the disk muxer's concat input does. */
    track(id: string, kind: "video" | "audio"): Uint8Array {
      const [video, audio] = lengths.get(id)!;
      const [from, to] = kind === "video" ? [0, video] : [video, video + audio];
      const parts: Uint8Array[] = [];
      for (let i = from; i < to; i++) parts.push(buckets.get(id)!.get(i)!);
      return Buffer.concat(parts);
    },
  };
}

describe.skipIf(!ffmpegAvailable)("player capture E2E (host ffmpeg)", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "player-capture-e2e-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("turns out-of-order player appends into a playable MP4", async () => {
    const service = memoryEnvironment();
    await service.start(1, () => undefined);
    const listeners: ((message: unknown) => void)[] = [];
    service.handleConnect({
      name: CAPTURE_PORT_NAME,
      sender: { tab: { id: 1 } },
      postMessage: () => undefined,
      disconnect: () => undefined,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      onDisconnect: { addListener: () => undefined },
    });
    const send = (message: unknown) => listeners.forEach((l) => l(message));

    const tracks = [
      {
        sb: 1,
        mime: 'video/mp4; codecs="avc1.42c01e"',
        file: fragmentedTrack(dir, "v"),
      },
      {
        sb: 2,
        mime: 'audio/mp4; codecs="mp4a.40.2"',
        file: fragmentedTrack(dir, "a"),
      },
    ];
    for (const { sb, mime } of tracks) {
      send({ t: "sb", doc: "page", ms: 1, sb, mime });
    }
    for (const { sb, file } of tracks) {
      for (const bytes of playerAppends(file)) {
        send({
          t: "data",
          doc: "page",
          ms: 1,
          sb,
          b64: Buffer.from(bytes).toString("base64"),
        });
      }
    }

    const [source] = await service.finish(1);
    const memory = memoryFs();
    const job = await saveCapturedSourceFactory(memory.fs)(source, {
      jobId: "job",
      filename: "Clip.mp4",
      createdAt: Date.now(),
    });
    expect(job).toBeDefined();

    const adapter = await FFmpegHostAdapter.create();
    try {
      await writeMediaToFFmpegFS(
        adapter as any,
        "video.mp4",
        memory.track("job", "video"),
      );
      await writeMediaToFFmpegFS(
        adapter as any,
        "audio.mp4",
        memory.track("job", "audio"),
      );
      const result = await muxExec({
        ffmpeg: adapter as any,
        outputFileName: "output.mp4",
        hasVideo: true,
        hasAudio: true,
        videoFileName: "video.mp4",
        audioFileName: "audio.mp4",
      });
      const output = path.join(dir, "output.mp4");
      fs.writeFileSync(output, new Uint8Array(await result.blob.arrayBuffer()));

      const probe = await ffprobe(output);
      const original = await ffprobe(FIXTURE);
      expect(probe.streams.map((s) => s.codec_type).sort()).toEqual([
        "audio",
        "video",
      ]);
      expect(probe.streams.find((s) => s.codec_type === "video")).toMatchObject(
        {
          codec_name: "h264",
        },
      );
      // Every segment present once: same length as the source.
      expect(Number(probe.duration)).toBeCloseTo(Number(original.duration), 0);

      // The file decodes from start to end without errors or warnings
      // (a segment kept twice shows up as non-monotonic timestamps).
      const decode = spawnSync(
        FFMPEG_PATH,
        ["-v", "warning", "-i", output, "-f", "null", "-"],
        { encoding: "utf8" },
      );
      expect(decode.status).toBe(0);
      expect(decode.stderr.trim()).toBe("");
    } finally {
      await adapter.cleanup();
    }
  }, 60_000);
});
