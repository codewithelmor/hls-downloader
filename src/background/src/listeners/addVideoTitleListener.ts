import { createStore } from "@hls-downloader/core/lib/store/configure-store";
import { playlistsSlice } from "@hls-downloader/core/lib/store/slices";
import { selectorsForUrl } from "@hls-downloader/core/lib/use-cases";
import { tabs } from "webextension-polyfill";
import { readVideoTitle } from "../services/read-video-title";

/**
 * Names captured streams after the video title shown on the page (for sites
 * with a rule in VIDEO_TITLE_RULES). Runs only after a stream has been
 * captured and never affects capture: if the title cannot be read, the
 * stream keeps its page title.
 */
export function addVideoTitleListener(store: ReturnType<typeof createStore>) {
  const seen = new Set<string>();

  store.subscribe(() => {
    const playlists = store.getState().playlists.playlists;
    for (const playlist of Object.values(playlists)) {
      if (!playlist || seen.has(playlist.id)) continue;
      seen.add(playlist.id);
      if (playlist.videoTitle) continue;
      if (selectorsForUrl(playlist.initiator).length === 0) continue;
      void nameFromPage(store, playlist.id, playlist.initiator!);
    }
  });
}

async function nameFromPage(
  store: ReturnType<typeof createStore>,
  playlistID: string,
  pageUrl: string,
) {
  try {
    const openTabs = await tabs.query({});
    const tab = openTabs.find((t) => t.url === pageUrl);
    const videoTitle = await readVideoTitle(tab?.id, pageUrl);
    if (!videoTitle || !store.getState().playlists.playlists[playlistID]) {
      return;
    }
    store.dispatch(
      playlistsSlice.actions.setPlaylistVideoTitle({ playlistID, videoTitle }),
    );
  } catch (error) {
    console.warn("[capture] could not name the stream", error);
  }
}
