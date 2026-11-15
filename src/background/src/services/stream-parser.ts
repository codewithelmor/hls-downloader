import { IParser } from "@hls-downloader/core/lib/services";
import { isDashManifestText } from "@hls-downloader/core/lib/use-cases";
import { M3u8Parser } from "./m3u8-parser";
import { MpdParser } from "./mpd-parser";

const parserFor = (text: string): IParser =>
  isDashManifestText(text) ? MpdParser : M3u8Parser;

/** Parses HLS playlists and MPEG-DASH manifests, chosen by document content. */
export const StreamParser: IParser = {
  parseMasterPlaylist: (text, baseurl, playlistID) =>
    parserFor(text).parseMasterPlaylist(text, baseurl, playlistID),
  parseLevelPlaylist: (text, baseurl) =>
    parserFor(text).parseLevelPlaylist(text, baseurl),
  inspectLevelEncryption: (text, baseurl) =>
    parserFor(text).inspectLevelEncryption(text, baseurl),
};
