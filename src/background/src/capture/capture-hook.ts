/**
 * Runs in the page's MAIN world at document_start, only while a player
 * capture is active. Wraps MediaSource.addSourceBuffer and
 * SourceBuffer.appendBuffer so a copy of every byte the page's player hands
 * to the browser is passed to the relay. The player's own calls always run
 * unchanged, even if copying fails.
 *
 * Built as a standalone IIFE: it must not import runtime code from the
 * extension, only constants and types.
 */
import {
  CAPTURE_WINDOW_TAG,
  type HookControl,
  type HookMessage,
} from "./protocol";

type SourceBufferInfo = { ms: number; sb: number; source: MediaSource };

(() => {
  const win = window as unknown as Record<string, unknown>;
  const MediaSourceCtor = window.MediaSource;
  const SourceBufferCtor = window.SourceBuffer;
  if (win[CAPTURE_WINDOW_TAG] || !MediaSourceCtor || !SourceBufferCtor) return;
  win[CAPTURE_WINDOW_TAG] = true;

  const doc = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let enabled = true;
  let acked = false;
  let port: MessagePort | null = null;
  // Messages wait here until the relay has taken the channel.
  let queue: { message: HookMessage; transfer: Transferable[] }[] = [];

  const sourceIds = new WeakMap<MediaSource, number>();
  const buffers = new WeakMap<SourceBuffer, SourceBufferInfo>();
  let nextSourceId = 1;
  let nextBufferId = 1;

  function stop() {
    enabled = false;
    queue = [];
    port?.close();
    port = null;
  }

  function send(message: HookMessage, transfer: Transferable[] = []) {
    if (!enabled) return;
    if (acked && port) port.postMessage(message, transfer);
    else queue.push({ message, transfer });
  }

  function connect() {
    if (!enabled || acked) return;
    port?.close();
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (event: MessageEvent<HookControl>) => {
      if (event.data?.t === "ack") {
        acked = true;
        for (const item of queue)
          port?.postMessage(item.message, item.transfer);
        queue = [];
      } else if (event.data?.t === "stop") {
        stop();
      }
    };
    window.postMessage({ [CAPTURE_WINDOW_TAG]: "hello", doc }, "*", [
      channel.port2,
    ]);
  }

  // The relay may start after this script; it announces itself so the
  // handshake can be repeated.
  window.addEventListener("message", (event) => {
    if (
      event.source === window &&
      (event.data as Record<string, unknown> | null)?.[CAPTURE_WINDOW_TAG] ===
        "relay-ready"
    ) {
      connect();
    }
  });
  connect();

  function durationOf(source: MediaSource): number | undefined {
    const duration = source.duration;
    return Number.isFinite(duration) && duration > 0 ? duration : undefined;
  }

  function copyBytes(data: BufferSource): ArrayBuffer {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(
            (data as ArrayBufferView).buffer,
            (data as ArrayBufferView).byteOffset,
            (data as ArrayBufferView).byteLength,
          );
    return bytes.slice().buffer;
  }

  const addSourceBuffer = MediaSourceCtor.prototype.addSourceBuffer;
  MediaSourceCtor.prototype.addSourceBuffer = function (
    this: MediaSource,
    type: string,
  ) {
    const buffer = addSourceBuffer.call(this, type);
    if (enabled) {
      try {
        let ms = sourceIds.get(this);
        if (ms === undefined) {
          ms = nextSourceId++;
          sourceIds.set(this, ms);
        }
        const sb = nextBufferId++;
        buffers.set(buffer, { ms, sb, source: this });
        send({ t: "sb", doc, ms, sb, mime: type, duration: durationOf(this) });
      } catch {
        // Never let capture break the player.
      }
    }
    return buffer;
  };

  const appendBuffer = SourceBufferCtor.prototype.appendBuffer;
  SourceBufferCtor.prototype.appendBuffer = function (
    this: SourceBuffer,
    data: BufferSource,
  ) {
    if (enabled) {
      try {
        const info = buffers.get(this);
        if (info) {
          const copy = copyBytes(data);
          send(
            {
              t: "data",
              doc,
              ms: info.ms,
              sb: info.sb,
              duration: durationOf(info.source),
              data: copy,
            },
            [copy],
          );
        }
      } catch {
        // Never let capture break the player.
      }
    }
    return appendBuffer.call(this, data);
  };

  const changeType = SourceBufferCtor.prototype.changeType;
  if (changeType) {
    SourceBufferCtor.prototype.changeType = function (
      this: SourceBuffer,
      type: string,
    ) {
      const result = changeType.call(this, type);
      if (enabled) {
        try {
          const info = buffers.get(this);
          if (info)
            send({ t: "type", doc, ms: info.ms, sb: info.sb, mime: type });
        } catch {
          // Never let capture break the player.
        }
      }
      return result;
    };
  }
})();
