/**
 * One media segment captured from a player's SourceBuffer. Times are in
 * seconds; they are missing when the segment carried no tfdt box.
 */
export type CapturedFragmentInfo = {
  id: number;
  initKey: string;
  start?: number;
  duration?: number;
  size: number;
};

export type CapturedGap = { start: number; end: number };

export type AssembledTrack = {
  /** Init segment every chosen fragment belongs to. */
  initKey: string;
  /** Fragment ids in playback order, without duplicates. */
  fragmentIds: number[];
  start?: number;
  end?: number;
  /** Seconds of media actually present (excludes gaps). */
  coveredSeconds: number;
  gaps: CapturedGap[];
  /** Segments left out because they belong to another init (quality). */
  otherQualitySegments: number;
  /** Segments left out because they repeat media already included. */
  duplicateSegments: number;
  bytes: number;
};

// Segments that start within this much of the previous one's end are
// treated as continuous; a larger jump is reported as a gap.
const GAP_TOLERANCE_SECONDS = 0.5;
// A segment that starts this far before the previous one ends repeats media
// that is already included (the player fetched it again after a seek).
const OVERLAP_TOLERANCE_SECONDS = 0.1;

function groupDuration(fragments: CapturedFragmentInfo[]): number {
  return fragments.reduce((sum, fragment) => sum + (fragment.duration ?? 0), 0);
}

/**
 * Turns the segments a player appended (in arrival order, possibly repeated
 * after seeks, possibly in several qualities) into one playable sequence:
 * keeps the quality with the most media, sorts by decode time, drops repeats,
 * and reports the gaps where nothing was captured.
 */
export function assembleCapturedTrack(
  fragments: CapturedFragmentInfo[],
): AssembledTrack | undefined {
  if (fragments.length === 0) return undefined;

  const groups = new Map<string, CapturedFragmentInfo[]>();
  for (const fragment of fragments) {
    const group = groups.get(fragment.initKey) ?? [];
    group.push(fragment);
    groups.set(fragment.initKey, group);
  }
  let [initKey, chosen] = [...groups.entries()][0];
  for (const [key, group] of groups) {
    const better =
      groupDuration(group) > groupDuration(chosen) ||
      (groupDuration(group) === groupDuration(chosen) &&
        group.length > chosen.length);
    if (better) [initKey, chosen] = [key, group];
  }
  const otherQualitySegments = fragments.length - chosen.length;

  // Without decode times there is nothing to sort by; keep arrival order.
  if (chosen.some((fragment) => fragment.start === undefined)) {
    return {
      initKey,
      fragmentIds: chosen.map((fragment) => fragment.id),
      coveredSeconds: groupDuration(chosen),
      gaps: [],
      otherQualitySegments,
      duplicateSegments: 0,
      bytes: chosen.reduce((sum, fragment) => sum + fragment.size, 0),
    };
  }

  const sorted = [...chosen].sort((a, b) => a.start! - b.start! || a.id - b.id);
  const kept: CapturedFragmentInfo[] = [];
  const gaps: CapturedGap[] = [];
  let duplicateSegments = 0;
  let previousEnd: number | undefined;
  let previous: CapturedFragmentInfo | undefined;
  for (const fragment of sorted) {
    const start = fragment.start!;
    const end = start + (fragment.duration ?? 0);
    if (previousEnd !== undefined && previous) {
      // Allow small rounding overlaps, but never more than half of either
      // segment, or a short segment fetched twice would be kept twice.
      const tolerance = Math.min(
        OVERLAP_TOLERANCE_SECONDS,
        (previous.duration ?? 0) / 2,
        (fragment.duration ?? 0) / 2,
      );
      if (start === previous.start || start < previousEnd - tolerance) {
        duplicateSegments++;
        continue;
      }
      if (start > previousEnd + GAP_TOLERANCE_SECONDS) {
        gaps.push({ start: previousEnd, end: start });
      }
    }
    kept.push(fragment);
    previous = fragment;
    previousEnd = fragment.duration === undefined ? start : end;
  }

  const first = kept[0];
  const last = kept[kept.length - 1];
  return {
    initKey,
    fragmentIds: kept.map((fragment) => fragment.id),
    start: first.start,
    end: last.start! + (last.duration ?? 0),
    coveredSeconds: groupDuration(kept),
    gaps,
    otherQualitySegments,
    duplicateSegments,
    bytes: kept.reduce((sum, fragment) => sum + fragment.size, 0),
  };
}
