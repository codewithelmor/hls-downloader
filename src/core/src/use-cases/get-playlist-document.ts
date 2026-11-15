import { Level } from "../entities";
import { ILoader, LoadedText } from "../services";
import { fetchWithFallback } from "../utils/fetch";
import { appendQueryParams } from "../utils/url";

export interface PlaylistDocument extends LoadedText {
  baseUri: string;
}

export async function loadPlaylistText(
  loader: ILoader,
  uri: string,
  attempts: number,
): Promise<LoadedText> {
  return loader.fetchTextResponse
    ? loader.fetchTextResponse(uri, attempts)
    : { text: await loader.fetchText(uri, attempts), uri };
}

function stripFragment(uri: string): string {
  const hash = uri.indexOf("#");
  return hash === -1 ? uri : uri.slice(0, hash);
}

function withFragmentOf(requestedURI: string, responseURI: string): string {
  const hash = requestedURI.indexOf("#");
  if (hash === -1 || responseURI.includes("#")) return responseURI;
  return responseURI + requestedURI.slice(hash);
}

export const getPlaylistDocumentFactory = (loader: ILoader) => {
  return async (
    level: Level,
    attempts: number,
    options: { baseUri?: string } = {},
  ): Promise<PlaylistDocument> => {
    const baseUri =
      level.baseUri ?? options.baseUri ?? level.playlistID ?? level.uri;
    const primary = appendQueryParams(baseUri, level.uri);
    const { uri: requestedURI, data } = await fetchWithFallback(
      primary,
      primary !== level.uri ? level.uri : null,
      attempts,
      (uri, count) => loadPlaylistText(loader, uri, count),
    );
    // Response URLs never carry a fragment, but a DASH level uses one to name
    // its track inside the shared manifest. Restore it, as a redirect would.
    const document = { ...data, uri: withFragmentOf(requestedURI, data.uri) };
    // A redirected CDN URL can replace expired authentication parameters. Use
    // that response's context for its segments, initialization maps, and keys.
    return {
      ...document,
      baseUri: data.uri !== stripFragment(requestedURI) ? data.uri : baseUri,
    };
  };
};
