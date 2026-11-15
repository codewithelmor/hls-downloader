import { describe, expect, it, vi } from "vitest";
import { firstValueFrom, of, Subject, toArray } from "rxjs";
import { assembleCapturedTrack } from "../src/use-cases/assemble-captured-track.ts";
import {
  capturedFileName,
  saveCapturedSourceFactory,
} from "../src/use-cases/save-captured-source.ts";
import { playerCaptureEpic } from "../src/controllers/player-capture-epic.ts";
import { downloadJobEpic } from "../src/controllers/download-job-epic.ts";
import { jobsSlice, playerCaptureSlice } from "../src/store/slices/index.ts";
import type { CapturedSource } from "../src/services/index.ts";

const frag = (id: number, start: number, duration = 4, initKey = "a") => ({
  id,
  initKey,
  start,
  duration,
  size: 100,
});

describe("assembleCapturedTrack", () => {
  it("sorts by time and drops segments fetched twice", () => {
    const result = assembleCapturedTrack([
      frag(0, 0),
      frag(1, 8),
      frag(2, 4),
      frag(3, 8), // re-fetched after a seek back
    ]);
    expect(result?.fragmentIds).toEqual([0, 2, 1]);
    expect(result?.duplicateSegments).toBe(1);
    expect(result?.gaps).toEqual([]);
    expect(result?.coveredSeconds).toBe(12);
    expect(result?.end).toBe(12);
  });

  it("drops a repeated segment shorter than the overlap tolerance", () => {
    // A one-frame last segment (1/60 s) fetched twice.
    const result = assembleCapturedTrack([
      frag(0, 0, 3),
      frag(1, 3, 1 / 60),
      frag(2, 3, 1 / 60),
    ]);
    expect(result?.fragmentIds).toEqual([0, 1]);
    expect(result?.duplicateSegments).toBe(1);
  });

  it("keeps segments that overlap only by rounding", () => {
    const result = assembleCapturedTrack([frag(0, 0, 2), frag(1, 1.999, 2)]);
    expect(result?.fragmentIds).toEqual([0, 1]);
  });

  it("reports the parts that were skipped", () => {
    const result = assembleCapturedTrack([frag(0, 0), frag(1, 20), frag(2, 4)]);
    expect(result?.gaps).toEqual([{ start: 8, end: 20 }]);
    expect(result?.coveredSeconds).toBe(12);
  });

  it("keeps the quality with the most media", () => {
    const result = assembleCapturedTrack([
      frag(0, 0, 4, "720p"),
      frag(1, 4, 4, "1080p"),
      frag(2, 8, 4, "1080p"),
    ]);
    expect(result?.initKey).toBe("1080p");
    expect(result?.fragmentIds).toEqual([1, 2]);
    expect(result?.otherQualitySegments).toBe(1);
  });

  it("keeps arrival order when segments have no timing", () => {
    const result = assembleCapturedTrack([
      { id: 5, initKey: "a", size: 1 },
      { id: 2, initKey: "a", size: 1 },
    ]);
    expect(result?.fragmentIds).toEqual([5, 2]);
  });

  it("returns undefined for nothing", () => {
    expect(assembleCapturedTrack([])).toBeUndefined();
  });
});

function fakeFs() {
  const written: Record<string, Map<number, Uint8Array>> = {};
  const fs = {
    createBucket: vi.fn(async (id: string) => {
      written[id] = new Map();
    }),
    getBucket: vi.fn(async (id: string) => ({
      write: async (index: number, data: ArrayBuffer) => {
        written[id].set(index, new Uint8Array(data));
      },
      prepareDownload: vi.fn(),
    })),
    deleteBucket: vi.fn(async () => undefined),
  };
  return { fs: fs as any, written };
}

function source(): CapturedSource {
  const read = (id: number) => Promise.resolve(new Uint8Array([id]).buffer);
  return {
    id: "doc:1",
    title: "Lecture 1",
    pageUrl: "https://example.com/watch",
    tracks: [
      {
        kind: "video",
        mime: 'video/mp4; codecs="avc1.64001f"',
        inits: { v: new Uint8Array([0xaa]) },
        fragments: [frag(1, 4, 4, "v"), frag(0, 0, 4, "v")],
        width: 1280,
        height: 720,
        readFragment: read,
      },
      {
        kind: "audio",
        mime: 'audio/mp4; codecs="mp4a.40.2"',
        inits: { s: new Uint8Array([0xbb]) },
        fragments: [frag(2, 0, 8, "s")],
        readFragment: read,
      },
    ],
  };
}

describe("saveCapturedSourceFactory", () => {
  it("writes init + ordered segments, video before audio", async () => {
    const { fs, written } = fakeFs();
    const job = await saveCapturedSourceFactory(fs)(source(), {
      jobId: "j1",
      filename: "Lecture 1.mp4",
      createdAt: 1,
    });
    expect(fs.createBucket).toHaveBeenCalledWith("j1", 3, 2);
    expect([...written.j1.entries()]).toEqual([
      [0, new Uint8Array([0xaa])],
      [1, new Uint8Array([0])],
      [2, new Uint8Array([1])],
      [3, new Uint8Array([0xbb])],
      [4, new Uint8Array([2])],
    ]);
    expect(job).toMatchObject({
      id: "j1",
      filename: "Lecture 1.mp4",
      outputContainer: "mp4",
      capturedFromPlayer: true,
      width: 1280,
      height: 720,
    });
    expect(job!.videoFragments).toHaveLength(3);
    expect(job!.audioFragments).toHaveLength(2);
  });

  it("puts a lone audio track in the primary slot", async () => {
    const { fs } = fakeFs();
    const audioOnly = { ...source(), tracks: [source().tracks[1]] };
    await saveCapturedSourceFactory(fs)(audioOnly, {
      jobId: "j2",
      filename: "a.mp4",
      createdAt: 1,
    });
    expect(fs.createBucket).toHaveBeenCalledWith("j2", 2, 0);
  });

  it("removes the bucket when reading captured data fails", async () => {
    const { fs } = fakeFs();
    const broken = source();
    broken.tracks[0].readFragment = () => Promise.reject(new Error("gone"));
    await expect(
      saveCapturedSourceFactory(fs)(broken, {
        jobId: "j3",
        filename: "x.mp4",
        createdAt: 1,
      }),
    ).rejects.toThrow("gone");
    expect(fs.deleteBucket).toHaveBeenCalledWith("j3");
  });

  it("names files after the video title", () => {
    expect(capturedFileName('A: "B"')).toBe("A_ _B_.mp4");
    expect(capturedFileName(undefined, " (2)")).toBe("Captured video (2).mp4");
  });
});

describe("playerCaptureSlice", () => {
  const reduce = (actions: any[]) =>
    actions.reduce(
      (state, action) => playerCaptureSlice.reducer(state, action),
      undefined,
    );

  it("tracks a capture from start to save", () => {
    let state = reduce([
      playerCaptureSlice.actions.start({ tabId: 3 }),
      playerCaptureSlice.actions.started({ tabId: 3, title: "T" }),
    ]);
    expect(state.sessions[3]).toMatchObject({ status: "waiting", title: "T" });
    state = playerCaptureSlice.reducer(
      state,
      playerCaptureSlice.actions.update({ tabId: 3, status: "capturing" }),
    );
    expect(state.sessions[3].status).toBe("capturing");
    state = playerCaptureSlice.reducer(
      state,
      playerCaptureSlice.actions.finish({ tabId: 3 }),
    );
    expect(state.sessions[3].status).toBe("saving");
    // Late progress from the stopped capture must not undo "saving".
    state = playerCaptureSlice.reducer(
      state,
      playerCaptureSlice.actions.update({ tabId: 3, status: "capturing" }),
    );
    expect(state.sessions[3].status).toBe("saving");
    state = playerCaptureSlice.reducer(
      state,
      playerCaptureSlice.actions.finished({ tabId: 3, jobIds: ["j"] }),
    );
    expect(state.sessions[3]).toBeUndefined();
  });

  it("keeps a protected capture stopped", () => {
    const state = reduce([
      playerCaptureSlice.actions.start({ tabId: 1 }),
      playerCaptureSlice.actions.update({
        tabId: 1,
        status: "protected",
        message: "DRM",
      }),
      playerCaptureSlice.actions.update({ tabId: 1, status: "capturing" }),
    ]);
    expect(state.sessions[1]).toMatchObject({
      status: "protected",
      message: "DRM",
    });
  });
});

const jobsState = { jobs: { jobs: {}, jobsStatus: {} } };

describe("playerCaptureEpic", () => {
  it("fails clearly when the browser cannot capture", async () => {
    const actions = await firstValueFrom(
      playerCaptureEpic(
        of(playerCaptureSlice.actions.start({ tabId: 1 })),
        { value: jobsState } as any,
        {} as any,
      ).pipe(toArray()),
    );
    expect(actions).toEqual([
      playerCaptureSlice.actions.failed({
        tabId: 1,
        message: "Capturing from the player is not available in this browser.",
      }),
    ]);
  });

  it("forwards progress until the capture is finished", async () => {
    let push: (update: any) => void = () => undefined;
    const playerCapture = {
      start: vi.fn(async (_tabId: number, onUpdate: any) => {
        push = onUpdate;
        return { pageUrl: "https://e.com", title: "T" };
      }),
      finish: vi.fn(async () => [source()]),
      discard: vi.fn(async () => undefined),
      cancel: vi.fn(),
    };
    const { fs } = fakeFs();
    const action$ = new Subject<any>();
    const state = {
      value: {
        ...jobsState,
        playerCapture: { sessions: { 1: { title: "Fallback" } } },
      },
    };
    const out: any[] = [];
    playerCaptureEpic(
      action$ as any,
      state as any,
      {
        playerCapture,
        fs,
      } as any,
    ).subscribe((action) => out.push(action));

    action$.next(playerCaptureSlice.actions.start({ tabId: 1 }));
    await Promise.resolve();
    await Promise.resolve();
    push({ status: "capturing" });
    action$.next(playerCaptureSlice.actions.finish({ tabId: 1 }));
    await vi.waitFor(() =>
      expect(out.at(-1)?.type).toBe(playerCaptureSlice.actions.finished.type),
    );
    push({ status: "capturing" }); // after finish: ignored

    expect(out.map((action) => action.type)).toEqual([
      playerCaptureSlice.actions.started.type,
      playerCaptureSlice.actions.update.type,
      jobsSlice.actions.addCaptured.type,
      playerCaptureSlice.actions.finished.type,
    ]);
    expect(out[2].payload.job).toMatchObject({
      filename: "Lecture 1.mp4",
      capturedFromPlayer: true,
    });
    expect(playerCapture.discard).toHaveBeenCalledWith(1);
  });

  it("keeps the captured data when nothing usable was captured", async () => {
    const playerCapture = {
      start: vi.fn(),
      finish: vi.fn(async () => []),
      discard: vi.fn(),
      cancel: vi.fn(),
    };
    const actions = await firstValueFrom(
      playerCaptureEpic(
        of(playerCaptureSlice.actions.finish({ tabId: 2 })),
        { value: { playerCapture: { sessions: {} } } } as any,
        { playerCapture, fs: fakeFs().fs } as any,
      ).pipe(toArray()),
    );
    expect(actions[0].type).toBe(playerCaptureSlice.actions.failed.type);
    expect(actions[0].payload.message).toMatch(/Nothing was captured/);
    expect(playerCapture.discard).not.toHaveBeenCalled();
  });

  it("cancels and clears the session", async () => {
    const playerCapture = { cancel: vi.fn(async () => undefined) };
    const actions = await firstValueFrom(
      playerCaptureEpic(
        of(playerCaptureSlice.actions.cancel({ tabId: 4 })),
        { value: {} } as any,
        { playerCapture } as any,
      ).pipe(toArray()),
    );
    expect(playerCapture.cancel).toHaveBeenCalledWith(4);
    expect(actions).toEqual([
      playerCaptureSlice.actions.cancelled({ tabId: 4 }),
    ]);
  });
});

describe("jobs recorded from a player", () => {
  it("are ready to save as soon as they are added", () => {
    const job = {
      id: "c",
      playlistId: undefined,
      videoFragments: [{}, {}],
      audioFragments: [{}],
      filename: "x.mp4",
      createdAt: 1,
      capturedFromPlayer: true,
    } as any;
    const state = jobsSlice.reducer(
      undefined,
      jobsSlice.actions.addCaptured({ job }),
    );
    expect(state.jobsStatus.c).toMatchObject({
      status: "ready",
      done: 3,
      total: 3,
    });
  });

  it("are never downloaded again from URLs", async () => {
    const job = {
      id: "c",
      capturedFromPlayer: true,
      videoFragments: [],
      audioFragments: [],
    };
    const action = await firstValueFrom(
      downloadJobEpic(
        of(jobsSlice.actions.download({ jobId: "c" })),
        { value: { jobs: { jobs: { c: job } } } } as any,
        {} as any,
      ),
    );
    expect(action.type).toBe(jobsSlice.actions.downloadFailed.type);
  });
});
