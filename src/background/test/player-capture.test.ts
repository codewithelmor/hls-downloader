import { describe, expect, it, vi } from "vitest";
import {
  PlayerCaptureService,
  PROTECTED_MESSAGE,
  type CapturePort,
  type PlayerCaptureEnvironment,
} from "../src/services/player-capture";
import {
  CAPTURE_HOOK_SCRIPT_ID,
  CAPTURE_PORT_NAME,
  CAPTURE_RELAY_SCRIPT_ID,
} from "../src/capture/protocol";
import {
  concat,
  initSegment,
  mediaSegment,
} from "../../core/test/fmp4-fixtures";

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function createEnv(url = "https://videos.example.com/watch/1") {
  const stored = new Map<string, Uint8Array>();
  let registered: string[] = [];
  const env: PlayerCaptureEnvironment = {
    getTab: vi.fn(async () => ({ url, title: "Watch page" })),
    reloadTab: vi.fn(async () => undefined),
    registerScripts: vi.fn(async (scripts: any[]) => {
      registered = scripts.map((script) => script.id);
    }),
    unregisterScripts: vi.fn(async (ids: string[]) => {
      registered = registered.filter((id) => !ids.includes(id));
    }),
    getRegisteredScriptIds: vi.fn(async (ids: string[]) =>
      registered.filter((id) => ids.includes(id)),
    ),
    isBlocked: (target) => target.includes("blocked.example"),
    readVideoTitle: vi.fn(async () => "Lecture 3"),
    storage: {
      write: vi.fn(async (session, id, data) => {
        stored.set(`${session}/${id}`, data.slice());
      }),
      read: vi.fn(async (session, id) => {
        const data = stored.get(`${session}/${id}`);
        if (!data) throw new Error("missing");
        return data.slice().buffer;
      }),
      deleteSession: vi.fn(async (session) => {
        for (const key of [...stored.keys()]) {
          if (key.startsWith(`${session}/`)) stored.delete(key);
        }
      }),
    },
  };
  return { env, stored, registered: () => registered };
}

function createPort(tabId: number, url = "https://videos.example.com/watch/1") {
  const listeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const sent: unknown[] = [];
  const port: CapturePort = {
    name: CAPTURE_PORT_NAME,
    sender: { tab: { id: tabId }, url },
    postMessage: (message) => sent.push(message),
    disconnect: vi.fn(),
    onMessage: { addListener: (listener) => listeners.push(listener) },
    onDisconnect: {
      addListener: (listener) => disconnectListeners.push(listener),
    },
  };
  return {
    port,
    sent,
    send: (message: unknown) =>
      listeners.forEach((listener) => listener(message)),
  };
}

const VIDEO = 'video/mp4; codecs="avc1.64001f"';

describe("PlayerCaptureService", () => {
  it("registers the page scripts and reloads the tab", async () => {
    const { env, registered } = createEnv();
    const service = new PlayerCaptureService(env);
    const info = await service.start(1, () => undefined);
    expect(info).toEqual({
      pageUrl: "https://videos.example.com/watch/1",
      title: "Watch page",
    });
    expect(registered()).toEqual([
      CAPTURE_RELAY_SCRIPT_ID,
      CAPTURE_HOOK_SCRIPT_ID,
    ]);
    const [scripts] = (env.registerScripts as any).mock.calls[0];
    expect(scripts[1]).toMatchObject({
      world: "MAIN",
      runAt: "document_start",
    });
    expect(env.reloadTab).toHaveBeenCalledWith(1);
  });

  it("refuses pages that are not web pages or are blocklisted", async () => {
    await expect(
      new PlayerCaptureService(createEnv("chrome://newtab").env).start(
        1,
        () => undefined,
      ),
    ).rejects.toThrow(/http and https/);
    await expect(
      new PlayerCaptureService(
        createEnv("https://blocked.example/x").env,
      ).start(1, () => undefined),
    ).rejects.toThrow(/blocklist/);
  });

  it("tells relays in tabs that are not being captured to stop", () => {
    const service = new PlayerCaptureService(createEnv().env);
    const { port, sent } = createPort(9);
    service.handleConnect(port);
    expect(sent).toEqual([{ t: "stop" }]);
    expect(port.disconnect).toHaveBeenCalled();
  });

  it("records segments in playback order and returns them on finish", async () => {
    vi.useFakeTimers();
    const { env, registered } = createEnv();
    const service = new PlayerCaptureService(env);
    const updates: any[] = [];
    await service.start(1, (update) => updates.push(update));
    const { port, sent, send } = createPort(1);
    service.handleConnect(port);
    expect(sent).toEqual([{ t: "go" }]);

    const init = initSegment({ defaultSampleDuration: 3000 });
    const segA = mediaSegment({ decodeTime: 0, samples: 60 }); // 0-2s
    const segB = mediaSegment({ decodeTime: 180000, samples: 60 }); // 2-4s
    send({ t: "sb", doc: "d", ms: 1, sb: 1, mime: VIDEO, duration: 600 });
    // The player appends B before A (e.g. after a seek), with the init cut
    // across two appends.
    send({ t: "data", doc: "d", ms: 1, sb: 1, b64: b64(init.slice(0, 50)) });
    send({
      t: "data",
      doc: "d",
      ms: 1,
      sb: 1,
      b64: b64(concat(init.slice(50), segB)),
    });
    send({ t: "data", doc: "d", ms: 1, sb: 1, b64: b64(segA) });
    send({ t: "ping" });

    await vi.advanceTimersByTimeAsync(1000);
    expect(updates.at(-1)).toMatchObject({
      status: "capturing",
      sources: [
        {
          id: "d:1",
          durationSeconds: 600,
          tracks: [
            {
              kind: "video",
              segments: 2,
              coveredSeconds: 4,
              gaps: 0,
              width: 1280,
              height: 720,
            },
          ],
        },
      ],
    });
    vi.useRealTimers();

    const [source] = await service.finish(1);
    expect(sent.at(-1)).toEqual({ t: "stop" });
    expect(registered()).toEqual([]);
    expect(source.title).toBe("Lecture 3");
    const [track] = source.tracks;
    expect(Object.values(track.inits)).toEqual([init]);
    const byStart = [...track.fragments].sort((a, b) => a.start! - b.start!);
    expect(new Uint8Array(await track.readFragment(byStart[0].id))).toEqual(
      segA,
    );
    expect(new Uint8Array(await track.readFragment(byStart[1].id))).toEqual(
      segB,
    );

    await service.discard(1);
    expect(env.storage.deleteSession).toHaveBeenCalled();
  });

  it("stops and stores nothing once the media turns out to be encrypted", async () => {
    const { env, stored } = createEnv();
    const service = new PlayerCaptureService(env);
    const updates: any[] = [];
    await service.start(1, (update) => updates.push(update));
    const { port, sent, send } = createPort(1);
    service.handleConnect(port);
    send({ t: "sb", doc: "d", ms: 1, sb: 1, mime: VIDEO });
    send({
      t: "data",
      doc: "d",
      ms: 1,
      sb: 1,
      b64: b64(
        concat(initSegment(), mediaSegment({ decodeTime: 0, samples: 1 })),
      ),
    });
    send({
      t: "data",
      doc: "d",
      ms: 1,
      sb: 1,
      b64: b64(mediaSegment({ decodeTime: 3000, samples: 1, encrypted: true })),
    });

    expect(updates.at(-1)).toEqual({
      status: "protected",
      sources: [],
      message: PROTECTED_MESSAGE,
    });
    expect(sent.at(-1)).toEqual({ t: "stop" });
    await expect(service.finish(1)).rejects.toThrow(PROTECTED_MESSAGE);
    expect(stored.size).toBe(0);
  });

  it("refuses encrypted init segments before storing any media", async () => {
    const { env } = createEnv();
    const service = new PlayerCaptureService(env);
    await service.start(1, () => undefined);
    const { port, send } = createPort(1);
    service.handleConnect(port);
    send({ t: "sb", doc: "d", ms: 1, sb: 1, mime: VIDEO });
    send({
      t: "data",
      doc: "d",
      ms: 1,
      sb: 1,
      b64: b64(
        concat(
          initSegment({ sampleEntry: "encv" }),
          mediaSegment({ decodeTime: 0, samples: 1 }),
        ),
      ),
    });
    await expect(service.finish(1)).rejects.toThrow(PROTECTED_MESSAGE);
    expect(env.storage.write).not.toHaveBeenCalled();
  });

  it("explains formats it cannot capture", async () => {
    vi.useFakeTimers();
    const { env } = createEnv();
    const service = new PlayerCaptureService(env);
    const updates: any[] = [];
    await service.start(1, (update) => updates.push(update));
    const { port, send } = createPort(1);
    service.handleConnect(port);
    send({ t: "sb", doc: "d", ms: 1, sb: 1, mime: 'video/webm; codecs="vp9"' });
    send({
      t: "data",
      doc: "d",
      ms: 1,
      sb: 1,
      b64: b64(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])),
    });
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    expect(updates.at(-1)).toMatchObject({ status: "unsupported" });
    expect(updates.at(-1).message).toMatch(/WebM/);
    expect(env.storage.write).not.toHaveBeenCalled();
  });

  it("keeps the data when the tab is closed, until it is saved or discarded", async () => {
    const { env, registered } = createEnv();
    const service = new PlayerCaptureService(env);
    const updates: any[] = [];
    await service.start(1, (update) => updates.push(update));
    const { port, send } = createPort(1);
    service.handleConnect(port);
    send({ t: "sb", doc: "d", ms: 1, sb: 1, mime: VIDEO });
    send({
      t: "data",
      doc: "d",
      ms: 1,
      sb: 1,
      b64: b64(
        concat(initSegment(), mediaSegment({ decodeTime: 0, samples: 1 })),
      ),
    });
    service.handleTabRemoved(1);
    expect(updates.at(-1).message).toMatch(/tab was closed/);
    await vi.waitFor(() => expect(registered()).toEqual([]));
    const sources = await service.finish(1);
    expect(sources[0].tracks[0].fragments).toHaveLength(1);
  });
});
