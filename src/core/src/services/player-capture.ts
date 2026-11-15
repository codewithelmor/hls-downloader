import type { CapturedFragmentInfo } from "../use-cases/assemble-captured-track";

export type PlayerCaptureTrackKind = "video" | "audio";

/** Live summary of one SourceBuffer, for showing progress. */
export type PlayerCaptureTrackSummary = {
  kind: PlayerCaptureTrackKind;
  mime: string;
  segments: number;
  bytes: number;
  coveredSeconds: number;
  start?: number;
  end?: number;
  gaps: number;
  otherQualitySegments: number;
  width?: number;
  height?: number;
};

/** Live summary of one MediaSource (one video in the page). */
export type PlayerCaptureSourceSummary = {
  id: string;
  durationSeconds?: number;
  tracks: PlayerCaptureTrackSummary[];
};

export type PlayerCaptureLiveStatus =
  | "waiting"
  | "capturing"
  | "protected"
  | "unsupported";

export type PlayerCaptureUpdate = {
  status?: PlayerCaptureLiveStatus;
  sources?: PlayerCaptureSourceSummary[];
  message?: string;
};

/** Everything captured from one SourceBuffer, ready to be assembled. */
export type CapturedTrackData = {
  kind: PlayerCaptureTrackKind;
  mime: string;
  inits: Record<string, Uint8Array>;
  fragments: CapturedFragmentInfo[];
  width?: number;
  height?: number;
  readFragment(id: number): Promise<ArrayBuffer>;
};

/** Everything captured from one MediaSource. */
export type CapturedSource = {
  id: string;
  title?: string;
  pageUrl?: string;
  durationSeconds?: number;
  tracks: CapturedTrackData[];
};

/**
 * Records the media a page's own player loads through Media Source
 * Extensions. Only unencrypted fragmented-MP4 media is kept; encrypted media
 * stops the capture and nothing is stored.
 */
export interface IPlayerCapture {
  /**
   * Starts capturing in a tab. The page is reloaded so the capture sees the
   * player from its first byte. `onUpdate` receives progress until the
   * capture is finished or cancelled.
   */
  start(
    tabId: number,
    onUpdate: (update: PlayerCaptureUpdate) => void,
  ): Promise<{ pageUrl?: string; title?: string }>;
  /** Stops capturing and returns what was captured. Data stays stored. */
  finish(tabId: number): Promise<CapturedSource[]>;
  /** Deletes the stored data of a finished capture. */
  discard(tabId: number): Promise<void>;
  /** Stops capturing and deletes everything captured. */
  cancel(tabId: number): Promise<void>;
}
