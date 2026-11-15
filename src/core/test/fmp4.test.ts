import { describe, expect, it } from "vitest";
import {
  Fmp4StreamSplitter,
  initSegmentKey,
  inspectInitSegment,
  inspectMediaSegment,
  looksLikeIsoBmff,
  primaryTrack,
} from "../src/use-cases/fmp4.ts";
import {
  box,
  concat,
  initSegment,
  mediaSegment,
  sidx,
  styp,
} from "./fmp4-fixtures.ts";

const typeAt = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));

describe("Fmp4StreamSplitter", () => {
  const init = initSegment();
  const first = mediaSegment({ decodeTime: 0, samples: 2 });
  const second = mediaSegment({ decodeTime: 6000, samples: 2 });
  const stream = concat(init, styp(), sidx(), first, styp(), second);

  it("emits the init segment and one segment per moof+mdat", () => {
    const segments = new Fmp4StreamSplitter().push(stream);
    expect(segments.map((s) => s.type)).toEqual(["init", "media", "media"]);
    expect(segments[0].bytes).toEqual(init);
    expect(segments[1].bytes).toEqual(first);
    expect(segments[2].bytes).toEqual(second);
  });

  it("handles appends that cut boxes at any byte", () => {
    const splitter = new Fmp4StreamSplitter();
    const segments = [];
    for (let i = 0; i < stream.byteLength; i += 7) {
      segments.push(...splitter.push(stream.slice(i, i + 7)));
    }
    expect(segments.map((s) => s.type)).toEqual(["init", "media", "media"]);
    expect(segments[2].bytes).toEqual(second);
  });

  it("adds an ftyp when the init segment has none", () => {
    const moovOnly = init.subarray(init.indexOf(0x6d) - 4); // from "moov"
    const [segment] = new Fmp4StreamSplitter().push(moovOnly.slice());
    expect(typeAt(segment.bytes, 0)).toBe("ftyp");
    expect(inspectInitSegment(segment.bytes).tracks).toHaveLength(1);
  });

  it("stops on data that is not MP4 boxes", () => {
    const splitter = new Fmp4StreamSplitter();
    expect(
      splitter.push(new Uint8Array([0x47, 0x40, 0, 0x10, 1, 2, 3, 4])),
    ).toEqual([]);
    expect(splitter.failed).toBe(true);
    expect(splitter.push(stream)).toEqual([]);
  });

  it("supports 64-bit box sizes", () => {
    const mdat = new Uint8Array([
      0, 0, 0, 1, 0x6d, 0x64, 0x61, 0x74, 0, 0, 0, 0, 0, 0, 0, 20, 1, 2, 3, 4,
    ]);
    const moof = box("moof");
    const [segment] = new Fmp4StreamSplitter().push(concat(moof, mdat));
    expect(segment.type).toBe("media");
    expect(segment.bytes.byteLength).toBe(28);
  });
});

describe("inspectInitSegment", () => {
  it("reads track id, handler, timescale, defaults and size", () => {
    const info = inspectInitSegment(
      initSegment({
        trackId: 7,
        timescale: 48000,
        defaultSampleDuration: 1024,
        width: 1920,
        height: 1080,
      }),
    );
    expect(info.encrypted).toBe(false);
    expect(info.tracks).toEqual([
      {
        trackId: 7,
        handler: "vide",
        timescale: 48000,
        defaultSampleDuration: 1024,
        width: 1920,
        height: 1080,
      },
    ]);
    expect(primaryTrack(info)?.trackId).toBe(7);
  });

  it("detects encrypted sample entries and pssh boxes", () => {
    expect(
      inspectInitSegment(initSegment({ sampleEntry: "encv" })).encrypted,
    ).toBe(true);
    expect(
      inspectInitSegment(initSegment({ handler: "soun", sampleEntry: "enca" }))
        .encrypted,
    ).toBe(true);
    expect(inspectInitSegment(initSegment({ pssh: true })).encrypted).toBe(
      true,
    );
  });
});

describe("inspectMediaSegment", () => {
  const init = inspectInitSegment(initSegment({ defaultSampleDuration: 3000 }));

  it("reads decode time and per-sample durations", () => {
    const info = inspectMediaSegment(
      mediaSegment({ decodeTime: 2 ** 33, samples: 4, sampleDuration: 1500 }),
      init,
    );
    expect(info.tracks).toEqual([
      { trackId: 1, decodeTime: 2 ** 33, duration: 6000, sampleCount: 4 },
    ]);
    expect(info.encrypted).toBe(false);
  });

  it("falls back to tfhd, then trex default durations", () => {
    expect(
      inspectMediaSegment(
        mediaSegment({ decodeTime: 0, samples: 3, tfhdDuration: 1000 }),
        init,
      ).tracks[0].duration,
    ).toBe(3000);
    expect(
      inspectMediaSegment(mediaSegment({ decodeTime: 0, samples: 3 }), init)
        .tracks[0].duration,
    ).toBe(9000);
    expect(
      inspectMediaSegment(mediaSegment({ decodeTime: 0, samples: 3 })).tracks[0]
        .duration,
    ).toBeUndefined();
  });

  it("detects sample encryption in media segments", () => {
    expect(
      inspectMediaSegment(
        mediaSegment({ decodeTime: 0, samples: 1, encrypted: true }),
        init,
      ).encrypted,
    ).toBe(true);
  });
});

describe("helpers", () => {
  it("recognises ISO BMFF data", () => {
    expect(looksLikeIsoBmff(initSegment())).toBe(true);
    expect(
      looksLikeIsoBmff(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])),
    ).toBe(false);
  });

  it("gives equal init segments equal keys", () => {
    expect(initSegmentKey(initSegment())).toBe(initSegmentKey(initSegment()));
    expect(initSegmentKey(initSegment())).not.toBe(
      initSegmentKey(initSegment({ width: 640, height: 360 })),
    );
  });
});
