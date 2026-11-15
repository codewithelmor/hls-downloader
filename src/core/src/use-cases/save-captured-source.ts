import { Fragment, Job } from "../entities";
import { CapturedSource, CapturedTrackData, IFS } from "../services";
import {
  AssembledTrack,
  assembleCapturedTrack,
} from "./assemble-captured-track";
import { sanitizeFilename } from "./sanitize-filename";

type Assembled = { track: CapturedTrackData; assembled: AssembledTrack };

function bestTrack(
  tracks: CapturedTrackData[],
  kind: CapturedTrackData["kind"],
): Assembled | undefined {
  let best: Assembled | undefined;
  for (const track of tracks) {
    if (track.kind !== kind) continue;
    const assembled = assembleCapturedTrack(track.fragments);
    if (!assembled || !track.inits[assembled.initKey]) continue;
    if (!best || assembled.coveredSeconds > best.assembled.coveredSeconds) {
      best = { track, assembled };
    }
  }
  return best;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function placeholderFragments(count: number, jobId: string): Fragment[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    uri: `player-capture:${jobId}/${index}`,
    key: { uri: null, iv: null },
  }));
}

export function capturedFileName(title: string | undefined, suffix = "") {
  const base = sanitizeFilename(title ?? "") || "Captured video";
  return `${base}${suffix}.mp4`.normalize("NFC");
}

/**
 * Writes one captured MediaSource into a download bucket, in the layout the
 * normal download pipeline produces (init segment first, then media segments
 * in playback order, video before audio), and returns the job that saves it.
 * Returns undefined when the source holds no usable media.
 */
export const saveCapturedSourceFactory = (fs: IFS) => {
  const run = async (
    source: CapturedSource,
    options: { jobId: string; filename: string; createdAt: number },
  ): Promise<Job | undefined> => {
    let video = bestTrack(source.tracks, "video");
    let audio = bestTrack(source.tracks, "audio");
    // A lone audio track goes in the primary slot, which is stream-copied;
    // the secondary audio slot is re-encoded by the muxer.
    if (!video && audio) {
      video = audio;
      audio = undefined;
    }
    if (!video) return undefined;

    const videoLength = video.assembled.fragmentIds.length + 1;
    const audioLength = audio ? audio.assembled.fragmentIds.length + 1 : 0;
    await fs.createBucket(options.jobId, videoLength, audioLength);
    const bucket = await fs.getBucket(options.jobId);
    if (!bucket) {
      throw new Error(`Download data for ${options.jobId} was not found`);
    }

    const writeTrack = async ({ track, assembled }: Assembled, base: number) => {
      await bucket.write(base, toArrayBuffer(track.inits[assembled.initKey]));
      let index = base + 1;
      for (const id of assembled.fragmentIds) {
        await bucket.write(index++, await track.readFragment(id));
      }
    };
    try {
      await writeTrack(video, 0);
      if (audio) await writeTrack(audio, videoLength);
    } catch (error) {
      await fs.deleteBucket(options.jobId).catch(() => undefined);
      throw error;
    }

    return {
      id: options.jobId,
      playlistId: undefined,
      videoFragments: placeholderFragments(videoLength, options.jobId),
      audioFragments: placeholderFragments(audioLength, options.jobId),
      filename: options.filename,
      createdAt: options.createdAt,
      width: video.track.width,
      height: video.track.height,
      link: source.pageUrl,
      outputContainer: "mp4",
      capturedFromPlayer: true,
    };
  };
  return run;
};
