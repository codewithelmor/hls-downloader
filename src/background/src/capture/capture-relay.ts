/**
 * Content script (ISOLATED world, document_start) registered only while a
 * player capture is active. Takes the MessageChannel offered by
 * capture-hook, asks the background whether this tab is being captured, and
 * then forwards the hook's messages over a runtime port, or tells the hook
 * to stop.
 *
 * Built as a standalone IIFE: it must not import runtime code from the
 * extension, only constants and types.
 */
import {
  CAPTURE_MAX_CHUNK_BYTES,
  CAPTURE_PING_INTERVAL_MS,
  CAPTURE_PORT_NAME,
  CAPTURE_WINDOW_TAG,
  type HookControl,
  type HookMessage,
  type RelayControl,
  type RelayMessage,
} from "./protocol";

type ExtensionPort = {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};

(() => {
  const api = (globalThis as any).browser ?? (globalThis as any).chrome;
  if (!api?.runtime?.connect) return;

  let state: "pending" | "go" | "stop" = "pending";
  let hookPort: MessagePort | null = null;
  let pending: RelayMessage[] = [];
  let chain: Promise<void> = Promise.resolve();
  let ping: ReturnType<typeof setInterval> | undefined;

  const background: ExtensionPort = api.runtime.connect({
    name: CAPTURE_PORT_NAME,
  });

  function tellHook(message: HookControl) {
    hookPort?.postMessage(message);
  }

  function stop() {
    if (state === "stop") return;
    state = "stop";
    pending = [];
    if (ping !== undefined) clearInterval(ping);
    tellHook({ t: "stop" });
    hookPort?.close();
    hookPort = null;
    try {
      background.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  function deliver(message: RelayMessage) {
    if (state === "stop") return;
    if (state === "pending") {
      pending.push(message);
      return;
    }
    try {
      background.postMessage(message);
    } catch {
      stop();
    }
  }

  background.onMessage.addListener((raw) => {
    const message = raw as RelayControl;
    if (message?.t === "go" && state === "pending") {
      state = "go";
      for (const item of pending) background.postMessage(item);
      pending = [];
      ping = setInterval(
        () => deliver({ t: "ping" }),
        CAPTURE_PING_INTERVAL_MS,
      );
    } else if (message?.t === "stop") {
      stop();
    }
  });
  background.onDisconnect.addListener(stop);

  function toBase64(bytes: Uint8Array): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        resolve(url.slice(url.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(new Blob([bytes as BlobPart]));
    });
  }

  function onHookMessage(event: MessageEvent<HookMessage>) {
    const message = event.data;
    if (!message || state === "stop") return;
    if (message.t !== "data") {
      // Keep order with data messages that are still being encoded.
      chain = chain.then(() => deliver(message));
      return;
    }
    const bytes = new Uint8Array(message.data);
    const { doc, ms, sb, duration } = message;
    chain = chain
      .then(async () => {
        for (
          let offset = 0;
          offset < bytes.byteLength && state !== "stop";
          offset += CAPTURE_MAX_CHUNK_BYTES
        ) {
          const b64 = await toBase64(
            bytes.subarray(offset, offset + CAPTURE_MAX_CHUNK_BYTES),
          );
          deliver({ t: "data", doc, ms, sb, duration, b64 });
        }
      })
      .catch(() => stop());
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data as Record<string, unknown> | null;
    if (data?.[CAPTURE_WINDOW_TAG] !== "hello" || !event.ports[0]) return;
    // The newest channel wins: the hook replaces its channel when it sees
    // relay-ready before our ack.
    hookPort?.close();
    hookPort = event.ports[0];
    hookPort.onmessage = onHookMessage;
    if (state === "stop") {
      tellHook({ t: "stop" });
      return;
    }
    tellHook({ t: "ack" });
  });
  window.postMessage({ [CAPTURE_WINDOW_TAG]: "relay-ready" }, "*");
})();
