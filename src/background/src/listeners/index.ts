import { createStore } from "@hls-downloader/core/lib/store/configure-store";
import { addPlaylistListener } from "./addPlaylistListener";
import { addVideoTitleListener } from "./addVideoTitleListener";
import { setTabListener } from "./setTabListener";

export function subscribeListeners(store: ReturnType<typeof createStore>) {
  setTabListener(store);
  addPlaylistListener(store);
  addVideoTitleListener(store);
}
