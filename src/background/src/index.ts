import { createStore } from "@hls-downloader/core/lib/store/configure-store";
import { createWrapStore } from "webext-redux";
import { subscribeListeners } from "./listeners";
import { getState, saveState } from "./persistState";
import { CryptoDecryptor } from "./services/crypto-decryptor";
import { FetchLoader } from "./services/fetch-loader";
import {
  DiskBackedFS,
  initializeDownloadTracking,
} from "./services/disk-backed-fs";
import { StreamParser } from "./services/stream-parser";

const wrapStore = createWrapStore();

(async () => {
  try {
    await initializeDownloadTracking();
  } catch (error) {
    console.warn("[downloads] failed to restore artifact tracking", error);
  }
  const state = await getState();
  const store = createStore(
    {
      decryptor: CryptoDecryptor,
      fs: DiskBackedFS,
      loader: FetchLoader,
      parser: StreamParser,
    },
    state,
  );

  wrapStore(store);

  store.subscribe(() => {
    saveState(store.getState());
  });

  subscribeListeners(store);
})();
