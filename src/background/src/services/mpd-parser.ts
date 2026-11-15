import { Fragment, Level } from "@hls-downloader/core/lib/entities";
import { IParser, ParsedEncryption } from "@hls-downloader/core/lib/services";
import { generateTrackId } from "@hls-downloader/core/lib/use-cases";
import { parse } from "mpd-parser";

// A DASH manifest describes every track in one document, so each Level points
// at the manifest itself plus a URL fragment naming its track. Fragments are
// never sent to the server; the parser reads it back to pick the track.
const TRACK_PARAM = "hlsd-dash-track=";

type TrackKind = "video" | "audio" | "subtitle";
type TrackRef =
  ["video", number] | ["audio" | "subtitle", string, string, number];

type ByteRange = { offset: number; length: number };
type MpdSegment = {
  resolvedUri: string;
  byterange?: ByteRange;
  map?: { resolvedUri: string; byterange?: ByteRange };
};
type MpdPlaylist = {
  attributes: {
    NAME?: string;
    BANDWIDTH?: number;
    RESOLUTION?: { width?: number; height?: number };
    "FRAME-RATE"?: number;
    AUDIO?: string;
  };
  resolvedUri?: string;
  segments?: MpdSegment[];
  sidx?: { resolvedUri: string } | null;
  contentProtection?: Record<string, unknown>;
};
type MpdGroupEntry = {
  language?: string;
  default?: boolean;
  autoselect?: boolean;
  playlists: MpdPlaylist[];
};
type MpdManifest = {
  playlists?: MpdPlaylist[];
  mediaGroups?: {
    AUDIO?: Record<string, Record<string, MpdGroupEntry>>;
    SUBTITLES?: Record<string, Record<string, MpdGroupEntry>>;
  };
};

const KEY_SYSTEM_NAMES: Record<string, string> = {
  "com.widevine.alpha": "Widevine",
  "com.microsoft.playready": "PlayReady",
  "com.apple.fps": "FairPlay",
  "com.apple.fps.1_0": "FairPlay",
  "org.w3.clearkey": "ClearKey",
};

function splitTrack(uri: string): { manifestUri: string; track?: TrackRef } {
  const hash = uri.indexOf("#");
  if (hash === -1) return { manifestUri: uri };
  const manifestUri = uri.slice(0, hash);
  const fragment = uri.slice(hash + 1);
  if (!fragment.startsWith(TRACK_PARAM)) return { manifestUri };
  try {
    const track = JSON.parse(
      decodeURIComponent(fragment.slice(TRACK_PARAM.length)),
    ) as TrackRef;
    return { manifestUri, track };
  } catch {
    return { manifestUri };
  }
}

function trackUri(manifestUri: string, track: TrackRef): string {
  return `${manifestUri}#${TRACK_PARAM}${encodeURIComponent(JSON.stringify(track))}`;
}

function parseManifest(text: string, manifestUri: string): MpdManifest {
  return parse(text, { manifestUri }) as unknown as MpdManifest;
}

function groupEntries(
  manifest: MpdManifest,
  kind: Exclude<TrackKind, "video">,
) {
  const groups =
    (kind === "audio"
      ? manifest.mediaGroups?.AUDIO
      : manifest.mediaGroups?.SUBTITLES) ?? {};
  return Object.entries(groups).flatMap(([groupId, entries]) =>
    Object.entries(entries).map(([label, entry]) => ({
      groupId,
      label,
      entry,
    })),
  );
}

function findPlaylist(
  manifest: MpdManifest,
  track: TrackRef,
): MpdPlaylist | undefined {
  if (track[0] === "video") return manifest.playlists?.[track[1]];
  const [kind, groupId, label, index] = track;
  const groups =
    kind === "audio"
      ? manifest.mediaGroups?.AUDIO
      : manifest.mediaGroups?.SUBTITLES;
  return groups?.[groupId]?.[label]?.playlists?.[index];
}

function allPlaylists(manifest: MpdManifest): MpdPlaylist[] {
  return [
    ...(manifest.playlists ?? []),
    ...groupEntries(manifest, "audio").flatMap(({ entry }) => entry.playlists),
  ];
}

function emptyKey() {
  return { uri: null, iv: null };
}

// The generic scheme only says "common encryption"; prefer the DRM system.
const GENERIC_SCHEME = "mp4protection";

function protectionNames(playlist: MpdPlaylist | undefined): string[] {
  const systems = Object.keys(playlist?.contentProtection ?? {});
  const specific = systems.filter((system) => system !== GENERIC_SCHEME);
  return specific.length > 0
    ? specific.map((system) => KEY_SYSTEM_NAMES[system] ?? system)
    : systems.map(() => "CENC");
}

export const MpdParser: IParser = {
  parseMasterPlaylist(
    text: string,
    baseurl: string,
    playlistID = baseurl,
  ): Level[] {
    const { manifestUri } = splitTrack(baseurl);
    const manifest = parseManifest(text, manifestUri);

    const video: Level[] = (manifest.playlists ?? []).map(
      (playlist, index) => ({
        type: "stream",
        id: JSON.stringify([playlistID, "dash-video", index]),
        playlistID,
        uri: trackUri(manifestUri, ["video", index]),
        bitrate: playlist.attributes.BANDWIDTH,
        fps: playlist.attributes["FRAME-RATE"],
        width: playlist.attributes.RESOLUTION?.width,
        height: playlist.attributes.RESOLUTION?.height,
        name: playlist.attributes.NAME,
        audioGroupId: playlist.attributes.AUDIO,
      }),
    );

    const media = (kind: "audio" | "subtitle"): Level[] =>
      groupEntries(manifest, kind).flatMap(({ groupId, label, entry }) =>
        entry.playlists.map((playlist, index) => {
          // A language can carry several bitrates; keep each one selectable.
          const name =
            entry.playlists.length > 1
              ? `${label} (${Math.round((playlist.attributes.BANDWIDTH ?? 0) / 1000)} kbps)`
              : label;
          return {
            type: kind,
            id: generateTrackId(playlistID, kind, groupId, `${label}#${index}`),
            playlistID,
            uri: trackUri(manifestUri, [kind, groupId, label, index]),
            bitrate: playlist.attributes.BANDWIDTH,
            language: entry.language,
            name,
            isDefault: entry.default,
            autoSelect: entry.autoselect,
            groupId,
          } satisfies Level;
        }),
      );

    return [...video, ...media("audio"), ...media("subtitle")];
  },

  parseLevelPlaylist(text: string, baseurl: string): Fragment[] {
    const { manifestUri, track } = splitTrack(baseurl);
    const manifest = parseManifest(text, manifestUri);
    // Without a track reference (the MPD was opened directly), use the first
    // video representation, like a media playlist entry point.
    const playlist = findPlaylist(manifest, track ?? ["video", 0]);
    if (!playlist) return [];

    const segments = playlist.segments ?? [];
    if (segments.length === 0) {
      // SegmentBase: the representation is a single fMP4 file. Download it
      // whole; it already contains its initialization data and index.
      const fileUri = playlist.sidx?.resolvedUri ?? playlist.resolvedUri;
      return fileUri && fileUri !== manifestUri
        ? [{ index: 0, key: emptyKey(), uri: fileUri, byteRange: null }]
        : [];
    }

    const fragments: Fragment[] = [];
    let index = 0;
    let currentMap: string | null = null;
    for (const segment of segments) {
      if (segment.map?.resolvedUri) {
        const mapId = `${segment.map.resolvedUri}|${segment.map.byterange?.offset}`;
        if (mapId !== currentMap) {
          fragments.push({
            index: index++,
            key: emptyKey(),
            uri: segment.map.resolvedUri,
            byteRange: segment.map.byterange ?? null,
          });
          currentMap = mapId;
        }
      }
      fragments.push({
        index: index++,
        key: emptyKey(),
        uri: segment.resolvedUri,
        byteRange: segment.byterange ?? null,
      });
    }
    return fragments;
  },

  inspectLevelEncryption(text: string, baseurl: string): ParsedEncryption {
    const { manifestUri, track } = splitTrack(baseurl);
    const manifest = parseManifest(text, manifestUri);
    const playlist = track ? findPlaylist(manifest, track) : undefined;

    let names = track
      ? protectionNames(playlist)
      : allPlaylists(manifest).flatMap(protectionNames);
    // mpd-parser only reports key systems it recognises. A ContentProtection
    // element it could not attribute still means the media is encrypted.
    if (
      names.length === 0 &&
      track?.[0] !== "subtitle" &&
      /<(?:[\w-]+:)?ContentProtection[\s>/]/.test(text) &&
      allPlaylists(manifest).every((p) => protectionNames(p).length === 0)
    ) {
      names = ["CENC"];
    }

    return {
      methods:
        names.length > 0
          ? [`DRM-protected DASH (${[...new Set(names)].join(", ")})`]
          : [],
      keyUris: [],
      iv: null,
    };
  },
};
