import { runtime, scripting, tabs } from "webextension-polyfill";
import { isBlocked } from "../blocklist";
import {
  CAPTURE_HOOK_SCRIPT_ID,
  CAPTURE_RELAY_SCRIPT_ID,
} from "../capture/protocol";
import {
  clearAllCaptures,
  deleteCaptureSession,
  readCaptureChunk,
  writeCaptureChunk,
} from "./opfs-storage";
import { PlayerCaptureService, type CapturePort } from "./player-capture";
import { readVideoTitle } from "./read-video-title";

function scriptingApi(): any {
  if (!scripting?.registerContentScripts) {
    throw new Error("the scripting API is not available");
  }
  return scripting;
}

/** Creates the player capture service and connects it to browser events. */
export function createPlayerCapture(): PlayerCaptureService {
  const service = new PlayerCaptureService({
    getTab: (tabId) => tabs.get(tabId),
    reloadTab: (tabId) => tabs.reload(tabId),
    registerScripts: (scripts) =>
      scriptingApi().registerContentScripts(scripts),
    unregisterScripts: (ids) =>
      scriptingApi().unregisterContentScripts({ ids }),
    getRegisteredScriptIds: async (ids) => {
      if (!scripting?.getRegisteredContentScripts) return [];
      const registered = await scripting.getRegisteredContentScripts({ ids });
      return registered.map((script) => script.id);
    },
    isBlocked,
    readVideoTitle,
    storage: {
      write: writeCaptureChunk,
      read: readCaptureChunk,
      deleteSession: deleteCaptureSession,
    },
  });

  runtime.onConnect.addListener((port) =>
    service.handleConnect(port as unknown as CapturePort),
  );
  tabs.onRemoved.addListener((tabId) => service.handleTabRemoved(tabId));

  // Nothing survives a restart of the background: drop leftovers.
  void clearAllCaptures().catch((error) =>
    console.warn("[player-capture] could not clear old captures", error),
  );
  void scripting
    ?.unregisterContentScripts?.({
      ids: [CAPTURE_RELAY_SCRIPT_ID, CAPTURE_HOOK_SCRIPT_ID],
    })
    .catch(() => undefined);

  return service;
}
