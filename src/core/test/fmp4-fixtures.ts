// Builds small but structurally valid fragmented-MP4 boxes for tests.

export function u32(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

export function u64(value: number): number[] {
  return [...u32(Math.floor(value / 2 ** 32)), ...u32(value >>> 0)];
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

export function box(type: string, ...children: (number[] | Uint8Array)[]) {
  const payload = children.flatMap((child) => [...child]);
  return new Uint8Array([
    ...u32(8 + payload.length),
    ...ascii(type),
    ...payload,
  ]);
}

function fullBox(
  type: string,
  version: number,
  flags: number,
  ...fields: (number[] | Uint8Array)[]
) {
  return box(
    type,
    [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff],
    ...fields,
  );
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

type TrackOptions = {
  trackId?: number;
  handler?: "vide" | "soun";
  timescale?: number;
  defaultSampleDuration?: number;
  width?: number;
  height?: number;
  sampleEntry?: string;
  pssh?: boolean;
};

export function initSegment(options: TrackOptions = {}): Uint8Array {
  const {
    trackId = 1,
    handler = "vide",
    timescale = 90000,
    defaultSampleDuration = 3000,
    width = 1280,
    height = 720,
    sampleEntry = handler === "vide" ? "avc1" : "mp4a",
    pssh = false,
  } = options;
  const tkhd = fullBox(
    "tkhd",
    0,
    3,
    u32(0), // creation
    u32(0), // modification
    u32(trackId),
    u32(0), // reserved
    u32(0), // duration
    new Uint8Array(8), // reserved
    new Uint8Array(8), // layer, alternate group, volume, reserved
    new Uint8Array(36), // matrix
    u32(width * 65536),
    u32(height * 65536),
  );
  const mdhd = fullBox(
    "mdhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(timescale),
    u32(0),
    u32(0),
  );
  const hdlr = fullBox(
    "hdlr",
    0,
    0,
    u32(0),
    ascii(handler),
    new Uint8Array(12),
    [0],
  );
  const stsd = fullBox(
    "stsd",
    0,
    0,
    u32(1),
    box(sampleEntry, new Uint8Array(8)),
  );
  const trak = box(
    "trak",
    tkhd,
    box("mdia", mdhd, hdlr, box("minf", box("stbl", stsd))),
  );
  const trex = fullBox(
    "trex",
    0,
    0,
    u32(trackId),
    u32(1),
    u32(defaultSampleDuration),
    u32(0),
    u32(0),
  );
  const moov = box(
    "moov",
    trak,
    box("mvex", trex),
    ...(pssh ? [fullBox("pssh", 0, 0, new Uint8Array(20))] : []),
  );
  return concat(box("ftyp", ascii("iso6"), u32(0), ascii("iso6")), moov);
}

type MediaOptions = {
  trackId?: number;
  decodeTime: number;
  samples: number;
  /** Per-sample durations in trun; otherwise the trex default applies. */
  sampleDuration?: number;
  /** Duration in tfhd's default-sample-duration field. */
  tfhdDuration?: number;
  encrypted?: boolean;
  payload?: number;
};

export function mediaSegment(options: MediaOptions): Uint8Array {
  const {
    trackId = 1,
    decodeTime,
    samples,
    sampleDuration,
    tfhdDuration,
    encrypted = false,
    payload = 16,
  } = options;
  const tfhd =
    tfhdDuration === undefined
      ? fullBox("tfhd", 0, 0x020000, u32(trackId))
      : fullBox("tfhd", 0, 0x020008, u32(trackId), u32(tfhdDuration));
  const tfdt = fullBox("tfdt", 1, 0, u64(decodeTime));
  const trunFlags = 0x1 | (sampleDuration !== undefined ? 0x100 : 0) | 0x200;
  const perSample = Array.from({ length: samples }, () => [
    ...(sampleDuration !== undefined ? u32(sampleDuration) : []),
    ...u32(payload / samples),
  ]).flat();
  const trun = fullBox("trun", 0, trunFlags, u32(samples), u32(0), perSample);
  const traf = box(
    "traf",
    tfhd,
    tfdt,
    trun,
    ...(encrypted ? [fullBox("senc", 0, 0, u32(0))] : []),
  );
  const moof = box("moof", fullBox("mfhd", 0, 0, u32(1)), traf);
  return concat(moof, box("mdat", new Uint8Array(payload)));
}

export const styp = () => box("styp", ascii("msdh"), u32(0), ascii("msdh"));
export const sidx = () => box("sidx", new Uint8Array(24));
