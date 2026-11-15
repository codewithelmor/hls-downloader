import type {
  CapturedSource,
  CapturedTrackData,
  IPlayerCapture,
  PlayerCaptureLiveStatus,
  PlayerCaptureSourceSummary,
  PlayerCaptureTrackSummary,
  PlayerCaptureUpdate,
} from "@hls-downloader/core/lib/services";
import {
  assembleCapturedTrack,
  Fmp4StreamSplitter,
  initSegmentKey,
  inspectInitSegment,
  inspectMediaSegment,
  looksLikeIsoBmff,
  primaryTrack,
  type CapturedFragmentInfo,
  type InitSegmentInfo,
} from "@hls-downloader/core/lib/use-cases";
import {
  CAPTURE_HOOK_FILE,
  CAPTURE_HOOK_SCRIPT_ID,
  CAPTURE_PORT_NAME,
  CAPTURE_RELAY_FILE,
  CAPTURE_RELAY_SCRIPT_ID,
  type RelayControl,
  type RelayMessage,
} from "../capture/protocol";

export const PROTECTED_MESSAGE =
  "This video is encrypted (DRM). Its media can only be decoded inside the browser's DRM module, so it cannot be captured. Nothing was saved.";
const UPDATE_INTERVAL_MS = 1000;
const PAGE_MATCHES = ["http://*/*", "https://*/*"];

/** The parts of a runtime.Port the service uses. */
export type CapturePort = {
  name: string;
  sender?: { tab?: { id?: number }; url?: string };
  postMessage(message: RelayControl): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};

export type PlayerCaptureEnvironment = {
  getTab(tabId: number): Promise<{ url?: string; title?: string }>;
  reloadTab(tabId: number): Promise<void>;
  registerScripts(scripts: unknown[]): Promise<void>;
  unregisterScripts(ids: string[]): Promise<void>;
  getRegisteredScriptIds(ids: string[]): Promise<string[]>;
  isBlocked(url: string): boolean;
  readVideoTitle(tabId: number, url?: string): Promise<string | undefined>;
  storage: {
    write(sessionId: string, id: number, data: Uint8Array): Promise<void>;
    read(sessionId: string, id: number): Promise<ArrayBuffer>;
    deleteSession(sessionId: string): Promise<void>;
  };
};

type TrackState = {
  id: number;
  kind: "video" | "audio";
  mime: string;
  splitter: Fmp4StreamSplitter;
  unsupported?: string;
  inits: Record<string, Uint8Array>;
  initInfo: Map<string, InitSegmentInfo>;
  currentInit?: string;
  fragments: CapturedFragmentInfo[];
  bytes: number;
  sawData: boolean;
  width?: number;
  height?: number;
};

type SourceState = {
  id: string;
  durationSeconds?: number;
  tracks: Map<number, TrackState>;
};

type Session = {
  tabId: number;
  sessionId: string;
  pageUrl?: string;
  title?: string;
  capturing: boolean;
  protected: boolean;
  message?: string;
  ports: Set<CapturePort>;
  sources: Map<string, SourceState>;
  nextChunkId: number;
  writes: Promise<void>;
  onUpdate: (update: PlayerCaptureUpdate) => void;
  updateTimer?: ReturnType<typeof setTimeout>;
};

function randomId(): string {
  return (
    (crypto as any)?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function trackKind(mime: string): "video" | "audio" {
  return /^\s*audio\//i.test(mime) ? "audio" : "video";
}

function unsupportedReason(mime: string): string | undefined {
  if (/mp4/i.test(mime)) return undefined;
  const format = /webm/i.test(mime)
    ? "WebM"
    : /mp2t/i.test(mime)
      ? "MPEG-TS"
      : mime.split(";")[0].trim() || "an unknown format";
  return `The player sends ${format} media, which capture does not support yet (only fragmented MP4).`;
}

function summarizeTrack(track: TrackState): PlayerCaptureTrackSummary {
  const assembled = assembleCapturedTrack(track.fragments);
  return {
    kind: track.kind,
    mime: track.mime,
    segments: assembled?.fragmentIds.length ?? 0,
    bytes: assembled?.bytes ?? 0,
    coveredSeconds: assembled?.coveredSeconds ?? 0,
    start: assembled?.start,
    end: assembled?.end,
    gaps: assembled?.gaps.length ?? 0,
    otherQualitySegments: assembled?.otherQualitySegments ?? 0,
    width: track.width,
    height: track.height,
  };
}

/**
 * Records what a tab's player appends to its SourceBuffers (see
 * capture/capture-hook.ts), stores media segments on disk, and refuses
 * encrypted media without storing it.
 */
export class PlayerCaptureService implements IPlayerCapture {
  private sessions = new Map<number, Session>();

  constructor(private readonly env: PlayerCaptureEnvironment) {}

  async start(
    tabId: number,
    onUpdate: (update: PlayerCaptureUpdate) => void,
  ): Promise<{ pageUrl?: string; title?: string }> {
    const tab = await this.env.getTab(tabId);
    const url = tab.url ?? "";
    if (!/^https?:/i.test(url)) {
      throw new Error(
        "Open the page that plays the video first. Capture works on http and https pages only.",
      );
    }
    if (this.env.isBlocked(url)) {
      throw new Error(
        "This site is on the blocklist, so it cannot be captured.",
      );
    }
    if (this.sessions.has(tabId)) await this.cancel(tabId);

    const session: Session = {
      tabId,
      sessionId: randomId(),
      pageUrl: url,
      title: tab.title,
      capturing: true,
      protected: false,
      ports: new Set(),
      sources: new Map(),
      nextChunkId: 0,
      writes: Promise.resolve(),
      onUpdate,
    };
    this.sessions.set(tabId, session);
    try {
      await this.ensureScriptsRegistered();
      // Reload so the hook is in place before the player creates its
      // MediaSource and appends the init segment.
      await this.env.reloadTab(tabId);
    } catch (error) {
      this.sessions.delete(tabId);
      await this.unregisterIfIdle().catch(() => undefined);
      throw new Error(
        `Could not start capturing in this tab: ${(error as Error)?.message ?? error}. Player capture needs Chrome 111+ or Firefox 128+.`,
      );
    }
    return { pageUrl: url, title: tab.title };
  }

  async finish(tabId: number): Promise<CapturedSource[]> {
    const session = this.sessions.get(tabId);
    if (!session) throw new Error("No capture is running in this tab.");
    this.stopReceiving(session);
    await session.writes;
    await this.unregisterIfIdle().catch(() => undefined);
    if (session.protected) throw new Error(PROTECTED_MESSAGE);

    const tab = await this.env.getTab(tabId).catch(() => undefined);
    const videoTitle = await this.env
      .readVideoTitle(tabId, tab?.url)
      .catch(() => undefined);
    const title = videoTitle ?? tab?.title ?? session.title;

    const sources: CapturedSource[] = [];
    for (const source of session.sources.values()) {
      const tracks: CapturedTrackData[] = [];
      for (const track of source.tracks.values()) {
        if (track.unsupported || track.fragments.length === 0) continue;
        tracks.push({
          kind: track.kind,
          mime: track.mime,
          inits: { ...track.inits },
          fragments: [...track.fragments],
          width: track.width,
          height: track.height,
          readFragment: (id) => this.env.storage.read(session.sessionId, id),
        });
      }
      if (tracks.length > 0) {
        sources.push({
          id: source.id,
          title,
          pageUrl: session.pageUrl,
          durationSeconds: source.durationSeconds,
          tracks,
        });
      }
    }
    return sources;
  }

  async discard(tabId: number): Promise<void> {
    const session = this.sessions.get(tabId);
    if (!session) return;
    this.sessions.delete(tabId);
    this.stopReceiving(session);
    await session.writes;
    await this.env.storage.deleteSession(session.sessionId);
    await this.unregisterIfIdle().catch(() => undefined);
  }

  async cancel(tabId: number): Promise<void> {
    await this.discard(tabId);
  }

  /** The tab is gone: stop listening but keep what was captured. */
  handleTabRemoved(tabId: number): void {
    const session = this.sessions.get(tabId);
    if (!session || !session.capturing) return;
    this.stopReceiving(session);
    session.message =
      "The tab was closed. Save what was captured or discard it.";
    this.emitUpdate(session);
    void this.unregisterIfIdle().catch(() => undefined);
  }

  handleConnect(port: CapturePort): void {
    if (port.name !== CAPTURE_PORT_NAME) return;
    const tabId = port.sender?.tab?.id;
    const session = tabId === undefined ? undefined : this.sessions.get(tabId);
    const frameUrl = port.sender?.url;
    if (
      !session ||
      !session.capturing ||
      (frameUrl && this.env.isBlocked(frameUrl))
    ) {
      port.postMessage({ t: "stop" });
      port.disconnect();
      return;
    }
    session.ports.add(port);
    port.onDisconnect.addListener(() => session.ports.delete(port));
    port.onMessage.addListener((message) =>
      this.handleMessage(session, message as RelayMessage),
    );
    port.postMessage({ t: "go" });
  }

  private handleMessage(session: Session, message: RelayMessage) {
    if (!session.capturing || !message || message.t === "ping") return;
    const key = `${message.doc}:${message.ms}`;
    let source = session.sources.get(key);
    if (!source) {
      source = { id: key, tracks: new Map() };
      session.sources.set(key, source);
    }
    if ("duration" in message && message.duration) {
      source.durationSeconds = message.duration;
    }

    if (message.t === "sb") {
      source.tracks.set(message.sb, {
        id: message.sb,
        kind: trackKind(message.mime),
        mime: message.mime,
        splitter: new Fmp4StreamSplitter(),
        unsupported: unsupportedReason(message.mime),
        inits: {},
        initInfo: new Map(),
        fragments: [],
        bytes: 0,
        sawData: false,
      });
    } else if (message.t === "type") {
      const track = source.tracks.get(message.sb);
      if (track) {
        track.mime = message.mime;
        track.unsupported ??= unsupportedReason(message.mime);
      }
    } else if (message.t === "data") {
      const track = source.tracks.get(message.sb);
      if (!track || track.unsupported) return;
      this.receiveData(session, track, fromBase64(message.b64));
    }
    this.scheduleUpdate(session);
  }

  private receiveData(session: Session, track: TrackState, bytes: Uint8Array) {
    if (!track.sawData) {
      track.sawData = true;
      if (!looksLikeIsoBmff(bytes)) {
        track.unsupported =
          "The player sends media that is not fragmented MP4, which capture does not support yet.";
        return;
      }
    }
    const segments = track.splitter.push(bytes);
    for (const segment of segments) {
      if (segment.type === "init") {
        const info = inspectInitSegment(segment.bytes);
        if (info.encrypted) return this.markProtected(session);
        const key = initSegmentKey(segment.bytes);
        track.inits[key] = segment.bytes;
        track.initInfo.set(key, info);
        track.currentInit = key;
        const video = info.tracks.find((t) => t.handler === "vide");
        if (video?.width && video.height) {
          track.width = video.width;
          track.height = video.height;
        }
        continue;
      }
      const initKey = track.currentInit;
      if (!initKey) continue;
      const initInfo = track.initInfo.get(initKey)!;
      const media = inspectMediaSegment(segment.bytes, initInfo);
      if (media.encrypted) return this.markProtected(session);
      const primary = primaryTrack(initInfo);
      const timing =
        media.tracks.find((t) => t.trackId === primary?.trackId) ??
        media.tracks[0];
      const timescale = primary?.timescale || undefined;
      const fragment: CapturedFragmentInfo = {
        id: session.nextChunkId++,
        initKey,
        start:
          timing?.decodeTime !== undefined && timescale
            ? timing.decodeTime / timescale
            : undefined,
        duration:
          timing?.duration !== undefined && timescale
            ? timing.duration / timescale
            : undefined,
        size: segment.bytes.byteLength,
      };
      track.fragments.push(fragment);
      track.bytes += fragment.size;
      this.store(session, track, fragment, segment.bytes);
    }
    if (track.splitter.failed) {
      track.unsupported =
        "The player's media could not be read as fragmented MP4.";
    }
  }

  private store(
    session: Session,
    track: TrackState,
    fragment: CapturedFragmentInfo,
    bytes: Uint8Array,
  ) {
    session.writes = session.writes.then(async () => {
      if (session.protected) return;
      try {
        await this.env.storage.write(session.sessionId, fragment.id, bytes);
      } catch (error) {
        track.fragments = track.fragments.filter((f) => f.id !== fragment.id);
        track.bytes -= fragment.size;
        if (!session.capturing) return;
        this.stopReceiving(session);
        session.message =
          (error as DOMException)?.name === "QuotaExceededError"
            ? "Stopped: not enough disk space. Save what was captured or discard it."
            : `Stopped: could not store the captured media (${(error as Error)?.message ?? error}).`;
        this.emitUpdate(session);
        void this.unregisterIfIdle().catch(() => undefined);
      }
    });
  }

  private markProtected(session: Session) {
    if (session.protected) return;
    session.protected = true;
    this.stopReceiving(session);
    session.sources.clear();
    session.message = PROTECTED_MESSAGE;
    // Encrypted media is never kept, including segments stored before the
    // encryption was recognised.
    session.writes = session.writes.then(() =>
      this.env.storage.deleteSession(session.sessionId).catch(() => undefined),
    );
    this.emitUpdate(session);
    void this.unregisterIfIdle().catch(() => undefined);
  }

  private stopReceiving(session: Session) {
    session.capturing = false;
    if (session.updateTimer !== undefined) {
      clearTimeout(session.updateTimer);
      session.updateTimer = undefined;
    }
    for (const port of session.ports) {
      try {
        port.postMessage({ t: "stop" });
        port.disconnect();
      } catch {
        // Already gone.
      }
    }
    session.ports.clear();
  }

  private scheduleUpdate(session: Session) {
    if (session.updateTimer !== undefined) return;
    session.updateTimer = setTimeout(() => {
      session.updateTimer = undefined;
      if (this.sessions.get(session.tabId) === session) {
        this.emitUpdate(session);
      }
    }, UPDATE_INTERVAL_MS);
  }

  private emitUpdate(session: Session) {
    if (session.protected) {
      session.onUpdate({
        status: "protected",
        sources: [],
        message: session.message,
      });
      return;
    }
    const sources: PlayerCaptureSourceSummary[] = [];
    const unsupported: string[] = [];
    for (const source of session.sources.values()) {
      const tracks: PlayerCaptureTrackSummary[] = [];
      for (const track of source.tracks.values()) {
        if (track.unsupported) unsupported.push(track.unsupported);
        else if (track.fragments.length > 0) tracks.push(summarizeTrack(track));
      }
      if (tracks.length > 0) {
        sources.push({
          id: source.id,
          durationSeconds: source.durationSeconds,
          tracks,
        });
      }
    }
    let status: PlayerCaptureLiveStatus = sources.length
      ? "capturing"
      : "waiting";
    let message = session.message;
    if (!sources.length && unsupported.length) {
      status = "unsupported";
      message ??= unsupported[0];
    }
    session.onUpdate({ status, sources, message });
  }

  private async ensureScriptsRegistered() {
    const ids = [CAPTURE_RELAY_SCRIPT_ID, CAPTURE_HOOK_SCRIPT_ID];
    const registered = await this.env.getRegisteredScriptIds(ids);
    if (registered.length === ids.length) return;
    if (registered.length) await this.env.unregisterScripts(registered);
    const common = {
      matches: PAGE_MATCHES,
      allFrames: true,
      runAt: "document_start",
      persistAcrossSessions: false,
    };
    await this.env.registerScripts([
      { id: CAPTURE_RELAY_SCRIPT_ID, js: [CAPTURE_RELAY_FILE], ...common },
      {
        id: CAPTURE_HOOK_SCRIPT_ID,
        js: [CAPTURE_HOOK_FILE],
        world: "MAIN",
        ...common,
      },
    ]);
  }

  private async unregisterIfIdle() {
    for (const session of this.sessions.values()) {
      if (session.capturing) return;
    }
    const ids = await this.env.getRegisteredScriptIds([
      CAPTURE_RELAY_SCRIPT_ID,
      CAPTURE_HOOK_SCRIPT_ID,
    ]);
    if (ids.length) await this.env.unregisterScripts(ids);
  }
}
