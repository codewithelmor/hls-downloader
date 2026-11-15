import { createStore } from "@hls-downloader/core/lib/store/configure-store";
import { playlistsSlice } from "@hls-downloader/core/lib/store/slices";
import {
  isDashResponse,
  isHlsResponse,
} from "@hls-downloader/core/lib/use-cases";
import {
  webRequest,
  tabs,
  browserAction as actiobV2,
  action as actiobV3,
} from "webextension-polyfill";
import { isBlocked } from "../blocklist";

const LOG_PREFIX = "[HLS Downloader]";

// Only requests that look like video are logged, so the console is not
// flooded with every image and script on the page.
function looksLikeVideo(url: string, contentType: string): boolean {
  return (
    /\.(m3u8?|mpd)(\?|#|$)/i.test(url) ||
    /mpegurl|dash\+xml|mp2t|video\//i.test(contentType)
  );
}

function logSkipped(reason: string, details: unknown) {
  console.info(`${LOG_PREFIX} stream not captured: ${reason}`, details);
}

export function addPlaylistListener(store: ReturnType<typeof createStore>) {
  console.info(`${LOG_PREFIX} listening for HLS and DASH streams`);
  webRequest.onCompleted.addListener(
    async (details) => {
      const contentTypeHeader = details.responseHeaders?.find(
        (h) => h.name.toLowerCase() === "content-type",
      );

      const contentType = contentTypeHeader?.value?.toLowerCase() || "";

      const info = {
        url: details.url,
        type: details.type,
        tabId: details.tabId,
        frameId: details.frameId,
        initiator: details.initiator,
        statusCode: details.statusCode,
        contentType,
      };
      // Requests the extension makes itself (fetching playlist levels) are not
      // page streams, so they are never interesting here.
      const fromExtension = /^(chrome|moz)-extension:/.test(
        details.initiator ?? "",
      );
      const verbose =
        !fromExtension && looksLikeVideo(details.url, contentType);

      if (details.tabId < 0) {
        if (verbose) {
          logSkipped(
            "request is not tied to a tab (tabId -1), e.g. it came from the site's service worker",
            info,
          );
        }
        return;
      }

      // Check if the request initiator is blocked
      if (details.initiator && isBlocked(details.initiator)) {
        if (verbose) {
          logSkipped("the page's site is on the blocklist", info);
        }
        return;
      }

      if (
        !isHlsResponse(details.url, contentType) &&
        !isDashResponse(details.url, contentType)
      ) {
        if (verbose) {
          logSkipped(
            "response is not an HLS playlist or DASH manifest (URL or Content-Type did not match)",
            info,
          );
        }
        return;
      }

      if (
        details.statusCode &&
        (details.statusCode < 200 || details.statusCode >= 300)
      ) {
        logSkipped(`server answered HTTP ${details.statusCode}`, info);
        return;
      }

      const playlistExists =
        !!store.getState().playlists.playlists[details.url];

      if (playlistExists) {
        console.debug(`${LOG_PREFIX} stream already captured`, info);
        return;
      }
      const tab = await tabs.get(details.tabId).catch((error) => {
        logSkipped(`could not look up tab ${details.tabId}: ${error}`, info);
        return null;
      });
      if (!tab) return;

      console.info(`${LOG_PREFIX} stream captured`, {
        ...info,
        pageUrl: tab.url,
        pageTitle: tab.title,
      });

      store.dispatch(
        playlistsSlice.actions.addPlaylist({
          id: details.url,
          uri: details.url,
          initiator: tab.url,
          pageTitle: tab.title,
          createdAt: Date.now(),
        }),
      );

      const unsubscribe = store.subscribe(() => {
        const status =
          store.getState().playlists.playlistsStatus[details.url]?.status;
        if (status === "ready") {
          const action = actiobV2 || actiobV3;
          void action.setIcon({
            tabId: tab.id,
            path: {
              "16": "assets/icons/16-new.png",
              "48": "assets/icons/48-new.png",
              "128": "assets/icons/128-new.png",
              "256": "assets/icons/256-new.png",
            },
          });
          unsubscribe();
        } else if (status === "error") {
          unsubscribe();
        }
      });
    },
    {
      types: ["xmlhttprequest", "media"],
      urls: ["http://*/*", "https://*/*"],
    },
    ["responseHeaders"],
  );
}
