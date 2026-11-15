import { Level, LevelInspection } from "../entities";
import { ILoader, IParser } from "../services";
import { appendQueryParams } from "../utils/url";
import { getPlaylistDocumentFactory } from "./get-playlist-document";

const SUPPORTED_METHODS = ["AES-128"];

const DRM_METHOD = /^DRM-protected [^(]*\((.+)\)$/;

/** Explains, in plain words, why a stream with this method cannot be saved. */
export function describeUnsupportedEncryption(method: string | null): string {
  if (!method) return "Unsupported encryption method detected.";
  const drm = DRM_METHOD.exec(method);
  if (drm) {
    return (
      `Protected by ${drm[1]} DRM. The decryption key is only released to ` +
      "the browser's built-in DRM module, so this stream can be played but " +
      "not downloaded."
    );
  }
  return (
    `Unsupported encryption method: ${method}. ` +
    `Only ${SUPPORTED_METHODS.join(", ")} streams can be decrypted.`
  );
}

export const inspectLevelEncryptionFactory = (
  loader: ILoader,
  parser: IParser,
) => {
  const run = async (
    level: Level,
    fetchAttempts: number,
    options: { baseUri?: string } = {},
  ): Promise<LevelInspection> => {
    const {
      text: playlistText,
      uri: usedUri,
      baseUri,
    } = await getPlaylistDocumentFactory(loader)(level, fetchAttempts, options);
    const { methods, keyUris, iv } = parser.inspectLevelEncryption(
      playlistText,
      usedUri,
    );
    const method = methods.length > 0 ? methods[0] : null;
    const supported = method === null || SUPPORTED_METHODS.includes(method);
    const normalizedKeyUris = keyUris.map((uri) =>
      appendQueryParams(baseUri, uri),
    );

    return {
      levelId: level.id,
      playlistId: level.playlistID,
      method,
      keyUris: normalizedKeyUris,
      iv: iv ?? null,
      supported,
      message: supported ? undefined : describeUnsupportedEncryption(method),
    };
  };
  return run;
};
