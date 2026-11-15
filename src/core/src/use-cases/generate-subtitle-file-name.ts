import { Level, Playlist } from "../entities";
import { sanitizeFilename } from "./sanitize-filename";

export const generateSubtitleFileName = () => {
  const run = (playlist: Playlist, level: Level): string => {
    const title = playlist.videoTitle?.trim() || playlist.pageTitle?.trim();
    const sanitizedTitle = title ? sanitizeFilename(title) : "";
    const baseTitle = sanitizedTitle || "subtitle";

    const language = level.language || level.name || level.id || "track";
    const sanitizedLanguage = `${language}`.replace(/\s+/g, "-");

    const filename = `${baseTitle}-${sanitizedLanguage}.vtt`;
    return filename.normalize("NFC");
  };
  return run;
};
