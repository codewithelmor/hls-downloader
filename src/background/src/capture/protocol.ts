/**
 * Messages used by player capture.
 *
 * page (capture-hook, MAIN world)
 *   --MessageChannel--> capture-relay (content script, ISOLATED world)
 *   --runtime Port--> background (services/player-capture)
 *
 * The hook only sees the page; the relay is the only part that can talk to
 * the extension. Binary data crosses the runtime port as base64 because
 * Chromium serializes extension messages as JSON.
 */

/** window.postMessage marker used for the hook/relay handshake. */
export const CAPTURE_WINDOW_TAG = "__hlsdPlayerCapture";
export const CAPTURE_PORT_NAME = "hlsd-player-capture";

/** Content script ids passed to scripting.registerContentScripts. */
export const CAPTURE_HOOK_SCRIPT_ID = "hlsd-capture-hook";
export const CAPTURE_RELAY_SCRIPT_ID = "hlsd-capture-relay";
export const CAPTURE_HOOK_FILE = "capture-hook.js";
export const CAPTURE_RELAY_FILE = "capture-relay.js";

/** Largest raw chunk the relay puts in one runtime message. */
export const CAPTURE_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** Keeps the MV3 service worker alive while a paused video sends nothing. */
export const CAPTURE_PING_INTERVAL_MS = 20_000;

/** hook -> relay */
export type HookMessage =
  | {
      t: "sb";
      doc: string;
      ms: number;
      sb: number;
      mime: string;
      duration?: number;
    }
  | { t: "type"; doc: string; ms: number; sb: number; mime: string }
  | {
      t: "data";
      doc: string;
      ms: number;
      sb: number;
      duration?: number;
      data: ArrayBuffer;
    };

/** relay -> hook */
export type HookControl = { t: "ack" } | { t: "stop" };

/** relay -> background */
export type RelayMessage =
  | Exclude<HookMessage, { t: "data" }>
  | {
      t: "data";
      doc: string;
      ms: number;
      sb: number;
      duration?: number;
      b64: string;
    }
  | { t: "ping" };

/** background -> relay */
export type RelayControl = { t: "go" } | { t: "stop" };
