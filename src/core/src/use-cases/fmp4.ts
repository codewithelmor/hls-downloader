/**
 * Minimal fragmented-MP4 (ISO BMFF) reading used by player capture: splitting
 * the byte stream a player appends to a SourceBuffer into initialization and
 * media segments, and reading the timing and encryption facts needed to put
 * captured segments back together.
 */

type BoxHeader = { type: string; size: number; headerSize: number };

/** Boxes whose children are plain boxes (no fields before the children). */
const CONTAINER_BOXES = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "mvex",
  "moof",
  "traf",
  "edts",
  "dinf",
]);

/** Box types that only appear in encrypted (Common Encryption) media. */
const ENCRYPTION_BOXES = new Set([
  "encv",
  "enca",
  "enct",
  "encs",
  "sinf",
  "tenc",
  "pssh",
  "senc",
]);

function fourCC(data: Uint8Array, offset: number): string {
  return String.fromCharCode(
    data[offset],
    data[offset + 1],
    data[offset + 2],
    data[offset + 3],
  );
}

function isBoxType(type: string): boolean {
  return /^[\x20-\x7e]{4}$/.test(type);
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function readUint64(dv: DataView, offset: number): number {
  return dv.getUint32(offset) * 2 ** 32 + dv.getUint32(offset + 4);
}

/**
 * Reads the box header at `offset`. Returns null when more bytes are needed
 * and "invalid" when the bytes cannot be a box (so the stream is not MP4, or
 * is corrupt). A size of 0 ("box runs to end of file") cannot be resolved in
 * a stream and is treated as invalid.
 */
function readBoxHeader(
  data: Uint8Array,
  offset: number,
): BoxHeader | null | "invalid" {
  if (data.byteLength - offset < 8) return null;
  const dv = view(data);
  const size32 = dv.getUint32(offset);
  const type = fourCC(data, offset + 4);
  if (!isBoxType(type)) return "invalid";
  if (size32 === 1) {
    if (data.byteLength - offset < 16) return null;
    const size = readUint64(dv, offset + 8);
    return size < 16 ? "invalid" : { type, size, headerSize: 16 };
  }
  if (size32 < 8) return "invalid";
  return { type, size: size32, headerSize: 8 };
}

type Box = { type: string; start: number; end: number; payload: number };

/** Lists the complete boxes inside data[start, end). Stops at bad data. */
function childBoxes(data: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset < end) {
    const header = readBoxHeader(data.subarray(0, end), offset);
    if (!header || header === "invalid") break;
    const boxEnd = offset + header.size;
    if (boxEnd > end) break;
    boxes.push({
      type: header.type,
      start: offset,
      end: boxEnd,
      payload: offset + header.headerSize,
    });
    offset = boxEnd;
  }
  return boxes;
}

function findChild(
  data: Uint8Array,
  parent: Box,
  type: string,
): Box | undefined {
  return childBoxes(data, parent.payload, parent.end).find(
    (box) => box.type === type,
  );
}

/** Sample entry types inside an `stsd` box (after version/flags and count). */
function sampleEntryTypes(data: Uint8Array, stsd: Box): string[] {
  return childBoxes(data, stsd.payload + 8, stsd.end).map((box) => box.type);
}

function containsEncryption(data: Uint8Array, start: number, end: number) {
  for (const box of childBoxes(data, start, end)) {
    if (ENCRYPTION_BOXES.has(box.type)) return true;
    if (box.type === "stsd") {
      if (sampleEntryTypes(data, box).some((t) => ENCRYPTION_BOXES.has(t)))
        return true;
    } else if (CONTAINER_BOXES.has(box.type)) {
      if (containsEncryption(data, box.payload, box.end)) return true;
    }
  }
  return false;
}

// A minimal `ftyp` for init segments that arrive without one, so the joined
// file still starts like an MP4 file.
const FALLBACK_FTYP = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x36,
  0x00, 0x00, 0x00, 0x00, 0x69, 0x73, 0x6f, 0x36, 0x6d, 0x70, 0x34, 0x31,
]);

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** A byte queue that avoids re-copying everything on each append. */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  length = 0;

  push(chunk: Uint8Array) {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.byteLength;
  }

  /** Returns the first n bytes (or fewer if not available) without removing. */
  peek(n: number): Uint8Array {
    const parts: Uint8Array[] = [];
    let needed = Math.min(n, this.length);
    for (const chunk of this.chunks) {
      if (needed <= 0) break;
      const part = chunk.subarray(0, needed);
      parts.push(part);
      needed -= part.byteLength;
    }
    return parts.length === 1 ? parts[0] : concatBytes(parts);
  }

  take(n: number): Uint8Array {
    const out = this.peek(n);
    let remaining = n;
    while (remaining > 0 && this.chunks.length) {
      const first = this.chunks[0];
      if (first.byteLength <= remaining) {
        remaining -= first.byteLength;
        this.chunks.shift();
      } else {
        this.chunks[0] = first.subarray(remaining);
        remaining = 0;
      }
    }
    this.length -= n;
    // peek may return a view of a chunk the caller could keep; copy it so the
    // result does not pin or alias a larger buffer.
    return out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
      ? out
      : out.slice();
  }

  clear() {
    this.chunks = [];
    this.length = 0;
  }
}

export type Fmp4Segment =
  | { type: "init"; bytes: Uint8Array }
  | { type: "media"; bytes: Uint8Array };

/**
 * Splits a SourceBuffer's appended bytes into init segments (ftyp + moov) and
 * media segments (one moof + mdat pair each). Appends may cut boxes anywhere;
 * incomplete boxes wait for the next push. Other top-level boxes (styp, sidx,
 * emsg, prft, free) are dropped. After invalid data, `failed` is set and all
 * later input is ignored, since the stream position can no longer be trusted.
 */
export class Fmp4StreamSplitter {
  private queue = new ByteQueue();
  private pendingFtyp: Uint8Array | null = null;
  private pendingMoof: Uint8Array | null = null;
  failed = false;

  push(chunk: Uint8Array): Fmp4Segment[] {
    if (this.failed) return [];
    this.queue.push(chunk);
    const out: Fmp4Segment[] = [];
    while (this.queue.length >= 8) {
      const header = readBoxHeader(this.queue.peek(16), 0);
      if (header === "invalid") {
        this.failed = true;
        this.queue.clear();
        break;
      }
      if (!header || this.queue.length < header.size) break;
      const box = this.queue.take(header.size);
      switch (header.type) {
        case "ftyp":
          this.pendingFtyp = box;
          break;
        case "moov":
          out.push({
            type: "init",
            bytes: concatBytes([this.pendingFtyp ?? FALLBACK_FTYP, box]),
          });
          this.pendingFtyp = null;
          this.pendingMoof = null;
          break;
        case "moof":
          this.pendingMoof = box;
          break;
        case "mdat":
          if (this.pendingMoof) {
            out.push({
              type: "media",
              bytes: concatBytes([this.pendingMoof, box]),
            });
            this.pendingMoof = null;
          }
          break;
        default:
          break;
      }
    }
    return out;
  }
}

/** True when the bytes start with an ISO BMFF box (as fMP4 appends do). */
export function looksLikeIsoBmff(data: Uint8Array): boolean {
  const header = readBoxHeader(data, 0);
  return header !== null && header !== "invalid";
}

export type InitTrackInfo = {
  trackId: number;
  handler: string;
  timescale: number;
  defaultSampleDuration?: number;
  width?: number;
  height?: number;
};

export type InitSegmentInfo = {
  encrypted: boolean;
  tracks: InitTrackInfo[];
};

/** Reads track ids, timescales and encryption from an init segment. */
export function inspectInitSegment(bytes: Uint8Array): InitSegmentInfo {
  const top = childBoxes(bytes, 0, bytes.byteLength);
  const moov = top.find((box) => box.type === "moov");
  if (!moov) return { encrypted: false, tracks: [] };
  const dv = view(bytes);
  const encrypted = containsEncryption(bytes, moov.payload, moov.end);

  const trexDefaults = new Map<number, number>();
  const mvex = findChild(bytes, moov, "mvex");
  if (mvex) {
    for (const trex of childBoxes(bytes, mvex.payload, mvex.end)) {
      if (trex.type !== "trex" || trex.end - trex.payload < 20) continue;
      trexDefaults.set(
        dv.getUint32(trex.payload + 4),
        dv.getUint32(trex.payload + 12),
      );
    }
  }

  const tracks: InitTrackInfo[] = [];
  for (const trak of childBoxes(bytes, moov.payload, moov.end)) {
    if (trak.type !== "trak") continue;
    const tkhd = findChild(bytes, trak, "tkhd");
    const mdia = findChild(bytes, trak, "mdia");
    if (!tkhd || !mdia) continue;
    const tkhdVersion = bytes[tkhd.payload];
    const idOffset = tkhd.payload + (tkhdVersion === 1 ? 20 : 12);
    if (idOffset + 4 > tkhd.end) continue;
    const trackId = dv.getUint32(idOffset);
    // width/height are the last 8 bytes of tkhd, as 16.16 fixed point.
    const width =
      tkhd.end - 8 >= idOffset ? dv.getUint32(tkhd.end - 8) / 65536 : 0;
    const height =
      tkhd.end - 4 >= idOffset ? dv.getUint32(tkhd.end - 4) / 65536 : 0;

    const mdhd = findChild(bytes, mdia, "mdhd");
    const hdlr = findChild(bytes, mdia, "hdlr");
    if (!mdhd) continue;
    const mdhdVersion = bytes[mdhd.payload];
    const timescaleOffset = mdhd.payload + (mdhdVersion === 1 ? 20 : 12);
    if (timescaleOffset + 4 > mdhd.end) continue;
    const timescale = dv.getUint32(timescaleOffset);
    const handler =
      hdlr && hdlr.payload + 12 <= hdlr.end
        ? fourCC(bytes, hdlr.payload + 8)
        : "";

    tracks.push({
      trackId,
      handler,
      timescale,
      defaultSampleDuration: trexDefaults.get(trackId),
      ...(width > 0 && height > 0
        ? { width: Math.round(width), height: Math.round(height) }
        : {}),
    });
  }
  return { encrypted, tracks };
}

export type MediaTrackTiming = {
  trackId: number;
  decodeTime?: number;
  duration?: number;
  sampleCount: number;
};

export type MediaSegmentInfo = {
  encrypted: boolean;
  tracks: MediaTrackTiming[];
};

/**
 * Reads, for each track fragment in a media segment, its decode start time
 * (tfdt) and total duration (from trun sample durations, or the tfhd / trex
 * defaults), in the track's timescale.
 */
export function inspectMediaSegment(
  bytes: Uint8Array,
  init?: InitSegmentInfo,
): MediaSegmentInfo {
  const dv = view(bytes);
  let encrypted = false;
  const tracks: MediaTrackTiming[] = [];
  for (const moof of childBoxes(bytes, 0, bytes.byteLength)) {
    if (moof.type === "pssh") encrypted = true;
    if (moof.type !== "moof") continue;
    if (containsEncryption(bytes, moof.payload, moof.end)) encrypted = true;
    for (const traf of childBoxes(bytes, moof.payload, moof.end)) {
      if (traf.type !== "traf") continue;
      const children = childBoxes(bytes, traf.payload, traf.end);
      const tfhd = children.find((box) => box.type === "tfhd");
      if (!tfhd || tfhd.payload + 8 > tfhd.end) continue;
      const tfhdFlags = dv.getUint32(tfhd.payload) & 0xffffff;
      const trackId = dv.getUint32(tfhd.payload + 4);
      let cursor = tfhd.payload + 8;
      if (tfhdFlags & 0x1) cursor += 8;
      if (tfhdFlags & 0x2) cursor += 4;
      let defaultDuration: number | undefined;
      if (tfhdFlags & 0x8 && cursor + 4 <= tfhd.end) {
        defaultDuration = dv.getUint32(cursor);
      }
      defaultDuration ??= init?.tracks.find(
        (track) => track.trackId === trackId,
      )?.defaultSampleDuration;

      let decodeTime: number | undefined;
      const tfdt = children.find((box) => box.type === "tfdt");
      if (tfdt) {
        const version = bytes[tfdt.payload];
        if (version === 1 && tfdt.payload + 12 <= tfdt.end) {
          decodeTime = readUint64(dv, tfdt.payload + 4);
        } else if (tfdt.payload + 8 <= tfdt.end) {
          decodeTime = dv.getUint32(tfdt.payload + 4);
        }
      }

      let sampleCount = 0;
      let duration = 0;
      let durationKnown = true;
      for (const trun of children.filter((box) => box.type === "trun")) {
        if (trun.payload + 8 > trun.end) continue;
        const flags = dv.getUint32(trun.payload) & 0xffffff;
        const count = dv.getUint32(trun.payload + 4);
        sampleCount += count;
        let offset = trun.payload + 8;
        if (flags & 0x1) offset += 4;
        if (flags & 0x4) offset += 4;
        const perSample =
          (flags & 0x100 ? 4 : 0) +
          (flags & 0x200 ? 4 : 0) +
          (flags & 0x400 ? 4 : 0) +
          (flags & 0x800 ? 4 : 0);
        if (flags & 0x100) {
          for (let i = 0; i < count; i++) {
            const at = offset + i * perSample;
            if (at + 4 > trun.end) {
              durationKnown = false;
              break;
            }
            duration += dv.getUint32(at);
          }
        } else if (defaultDuration !== undefined) {
          duration += count * defaultDuration;
        } else {
          durationKnown = false;
        }
      }
      tracks.push({
        trackId,
        decodeTime,
        duration: durationKnown ? duration : undefined,
        sampleCount,
      });
    }
  }
  return { encrypted, tracks };
}

/** Picks the track to time a buffer by: video if present, else the first. */
export function primaryTrack(init: InitSegmentInfo): InitTrackInfo | undefined {
  return (
    init.tracks.find((track) => track.handler === "vide") ?? init.tracks[0]
  );
}

/** A short, stable key for an init segment, used to group media segments. */
export function initSegmentKey(bytes: Uint8Array): string {
  // FNV-1a over the bytes, plus the length to make collisions even rarer.
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.byteLength; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return `${bytes.byteLength.toString(36)}-${(hash >>> 0).toString(36)}`;
}
