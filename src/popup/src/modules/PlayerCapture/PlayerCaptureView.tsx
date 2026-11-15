import type { PlayerCaptureSession } from "@hls-downloader/core/lib/store/slices";
import type {
  PlayerCaptureSourceSummary,
  PlayerCaptureTrackSummary,
} from "@hls-downloader/core/lib/services";
import { Button, Card } from "@hls-downloader/design-system";
import {
  CircleDot,
  Loader2,
  MonitorPlay,
  Save,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import React from "react";
import { formatBytes } from "../../utils/format-bytes";
import { formatClock } from "../../utils/format-clock";

interface Props {
  canStart: boolean;
  current?: PlayerCaptureSession;
  others: PlayerCaptureSession[];
  start: () => void;
  save: (tabId: number) => void;
  discard: (tabId: number) => void;
}

/** The source with the most captured media, which is the one worth showing. */
function mainSource(
  session: PlayerCaptureSession,
): PlayerCaptureSourceSummary | undefined {
  const covered = (source: PlayerCaptureSourceSummary) =>
    Math.max(0, ...source.tracks.map((track) => track.coveredSeconds));
  return [...session.sources].sort((a, b) => covered(b) - covered(a))[0];
}

function primary(
  source?: PlayerCaptureSourceSummary,
): PlayerCaptureTrackSummary | undefined {
  return (
    source?.tracks.find((track) => track.kind === "video") ?? source?.tracks[0]
  );
}

export function describeProgress(session: PlayerCaptureSession): string[] {
  const source = mainSource(session);
  const track = primary(source);
  if (!source || !track) return [];
  const bytes = source.tracks.reduce((sum, t) => sum + t.bytes, 0);
  const lines = [
    [
      source.durationSeconds
        ? `${formatClock(track.coveredSeconds)} of ${formatClock(source.durationSeconds)}`
        : formatClock(track.coveredSeconds),
      formatBytes(bytes),
      track.height ? `${track.height}p` : undefined,
      source.tracks.some((t) => t.kind === "audio")
        ? "separate audio"
        : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  ];
  const gaps = Math.max(...source.tracks.map((t) => t.gaps));
  if (gaps > 0) {
    lines.push(
      `${gaps} gap${gaps === 1 ? "" : "s"}: parts you skipped were not loaded by the player and will be missing.`,
    );
  }
  const otherQuality = Math.max(
    ...source.tracks.map((t) => t.otherQualitySegments),
  );
  if (otherQuality > 0) {
    lines.push(
      `${otherQuality} segment${otherQuality === 1 ? "" : "s"} in another quality will be left out. Fix the quality in the player's settings to avoid this.`,
    );
  }
  if (session.sources.length > 1) {
    lines.push(
      `${session.sources.length} videos captured; each is saved as its own file.`,
    );
  }
  return lines;
}

const STATUS_TEXT: Record<PlayerCaptureSession["status"], string> = {
  starting: "Reloading the page…",
  waiting: "Waiting for the player. Play the video from the start.",
  capturing: "Recording what the player loads",
  protected: "Encrypted video",
  unsupported: "Format not supported",
  saving: "Saving…",
  error: "Capture problem",
};

const SessionCard = ({
  session,
  showTitle,
  save,
  discard,
}: {
  session: PlayerCaptureSession;
  showTitle: boolean;
  save: (tabId: number) => void;
  discard: (tabId: number) => void;
}) => {
  const { status } = session;
  const blocked = status === "protected" || status === "unsupported";
  const busy = status === "saving" || status === "starting";
  const hasMedia = session.sources.length > 0;
  const progress = describeProgress(session);

  return (
    <Card
      data-player-capture
      className={`gap-2 rounded-[11px] p-3 text-left ${blocked || status === "error" ? "border-destructive/40" : ""}`}
    >
      <div className="flex items-center gap-2">
        {blocked ? (
          <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" />
        ) : busy ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        ) : (
          <CircleDot
            className={`h-4 w-4 shrink-0 ${status === "capturing" ? "animate-pulse text-red-500" : "text-primary"}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-bold leading-tight">
            {STATUS_TEXT[status]}
          </div>
          {showTitle && (session.title || session.pageUrl) && (
            <div className="truncate text-[10px] text-muted-foreground">
              {session.title || session.pageUrl}
            </div>
          )}
        </div>
      </div>

      {progress.length > 0 && !blocked && (
        <div className="space-y-0.5 text-[11px] leading-snug text-muted-foreground">
          {progress.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      {session.message && (
        <p
          className={`text-[11px] leading-snug ${blocked || status === "error" ? "text-destructive" : "text-muted-foreground"}`}
          role={blocked || status === "error" ? "alert" : undefined}
        >
          {session.message}
        </p>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        {!blocked && hasMedia && (
          <Button
            size="sm"
            className="h-8 gap-1.5 text-[11px]"
            onClick={() => save(session.tabId)}
            disabled={busy}
          >
            <Save className="h-3.5 w-3.5" />
            {status === "error" ? "Try saving again" : "Stop and save"}
          </Button>
        )}
        <Button
          size="sm"
          variant={blocked || !hasMedia ? "outline" : "ghost"}
          className="h-8 gap-1.5 text-[11px]"
          onClick={() => discard(session.tabId)}
          disabled={status === "saving"}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {blocked ? "Dismiss" : hasMedia ? "Discard" : "Stop"}
        </Button>
      </div>
    </Card>
  );
};

const PlayerCaptureView = ({
  canStart,
  current,
  others,
  start,
  save,
  discard,
}: Props) => (
  <div className="flex shrink-0 flex-col gap-2">
    {current ? (
      <SessionCard
        session={current}
        showTitle={false}
        save={save}
        discard={discard}
      />
    ) : (
      <Card className="flex-row items-center gap-3 rounded-[11px] p-3 text-left">
        <MonitorPlay className="h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-bold leading-tight">
            Capture from the player
          </div>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            Records what this page's player loads, then saves it as MP4. Reloads
            the page. Not for DRM-protected video.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0 px-2.5 text-[10px]"
          onClick={start}
          disabled={!canStart}
          title={
            canStart ? undefined : "Open a web page with a video player first"
          }
        >
          Start capture
        </Button>
      </Card>
    )}
    {others.map((session) => (
      <SessionCard
        key={session.tabId}
        session={session}
        showTitle
        save={save}
        discard={discard}
      />
    ))}
  </div>
);

export default PlayerCaptureView;
