import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  countDeclaredPsiElements,
  PsiElementScan,
} from "../../src/connection/psiElementScan";
import type { PsiMessageKind } from "../../src/connection/psiElementScan";

const lib = await PSI();

const BIG = 1_000_000; // a ceiling far above any test frame's element count

function elems(count: number, byteLen: number): Array<Uint8Array> {
  return Array.from({ length: count }, () => new Uint8Array(byteLen));
}

function requestBytes(count: number, byteLen = 0, reveal = false): Uint8Array {
  const m = new lib.request();
  m.setRevealIntersection(reveal);
  m.setEncryptedElementsList(elems(count, byteLen));
  return m.serializeBinary();
}
function responseBytes(count: number, byteLen = 0): Uint8Array {
  const m = new lib.response();
  m.setEncryptedElementsList(elems(count, byteLen));
  return m.serializeBinary();
}
function rawSetupBytes(count: number, byteLen = 0): Uint8Array {
  const m = new lib.serverSetup();
  const raw = new lib.serverSetup.RawInfo();
  raw.setEncryptedElementsList(elems(count, byteLen));
  m.setRaw(raw);
  return m.serializeBinary();
}

// --- Equivalence: the scan count matches what deserializeBinary materializes ----
// The scan runs before deserialize to bound the amplifying allocation, so it
// must never under-count the elements the library would produce. Pin it
// across message kinds, element counts, element byte sizes, and the optional
// revealIntersection field, and re-verify on a library upgrade.

const cases: Array<{
  kind: PsiMessageKind;
  build: (n: number, b?: number) => Uint8Array;
  deser: (u: Uint8Array) => number;
}> = [
  {
    kind: "request",
    build: (n, b) => requestBytes(n, b),
    deser: (u) =>
      lib.request.deserializeBinary(u).getEncryptedElementsList().length,
  },
  {
    kind: "response",
    build: (n, b) => responseBytes(n, b),
    deser: (u) =>
      lib.response.deserializeBinary(u).getEncryptedElementsList().length,
  },
  {
    kind: "serverSetup",
    build: (n, b) => rawSetupBytes(n, b),
    deser: (u) =>
      lib.serverSetup.deserializeBinary(u).getRaw()?.getEncryptedElementsList()
        .length ?? 0,
  },
];

for (const { kind, build, deser } of cases) {
  test(`${kind}: scan count equals the deserialized element count`, () => {
    for (const n of [0, 1, 2, 7, 100]) {
      for (const b of [0, 2, 35]) {
        const bytes = build(n, b);
        expect(countDeclaredPsiElements(bytes, kind, BIG)).toBe(n);
        expect(deser(bytes)).toBe(n); // the scan matches the library
      }
    }
  });
}

test("request: the revealIntersection varint field does not affect the count", () => {
  expect(
    countDeclaredPsiElements(requestBytes(5, 35, true), "request", BIG),
  ).toBe(5);
  expect(
    countDeclaredPsiElements(requestBytes(5, 35, false), "request", BIG),
  ).toBe(5);
});

test("a non-Raw (GCS) server setup declares no amplifiable element list", () => {
  const m = new lib.serverSetup();
  const gcs = new lib.serverSetup.GCSInfo();
  gcs.setDiv(1);
  gcs.setHashRange(1000);
  gcs.setBits(new Uint8Array([1, 2, 3, 4]));
  m.setGcs(gcs);
  // The scan sees only the single `bits` field inside the oneof submessage, so a
  // non-Raw setup can never amplify -- it is rejected downstream as non-Raw, not
  // here.
  expect(
    countDeclaredPsiElements(m.serializeBinary(), "serverSetup", BIG),
  ).toBeLessThanOrEqual(2);
});

// --- Over-declaration: stops early, above the ceiling --------------------------

test("an over-declared frame is reported above the ceiling without a full count", () => {
  const bytes = requestBytes(1000, 0); // 1000 empty elements, ~2 KB
  // Ceiling 4: the scan returns >4 (early exit) rather than the true 1000.
  const scanned = countDeclaredPsiElements(bytes, "request", 4);
  expect(scanned).toBeGreaterThan(4);
  // And an exact ceiling admits an exactly-at-ceiling frame.
  expect(countDeclaredPsiElements(requestBytes(4, 0), "request", 4)).toBe(4);
});

test("a setup that packs elements under the Raw oneof is counted at depth", () => {
  // Depth-1 counting: 1000 elements nested inside the raw submessage are seen.
  expect(
    countDeclaredPsiElements(rawSetupBytes(1000, 0), "serverSetup", 4),
  ).toBeGreaterThan(4);
});

// --- Malformed frames fail closed ----------------------------------------------

test("an empty frame declares zero elements", () => {
  expect(countDeclaredPsiElements(new Uint8Array(0), "request", BIG)).toBe(0);
});

test("a truncated frame throws (rejected fail-closed)", () => {
  const full = requestBytes(10, 35);
  expect(() =>
    countDeclaredPsiElements(full.subarray(0, full.length - 5), "request", BIG),
  ).toThrow(/PSI element scan/);
});

test("a field whose declared length runs past the buffer throws", () => {
  // Field 2 (tag 0x12), wire type 2, length varint 100, but no payload follows.
  const bytes = new Uint8Array([0x12, 0x64]);
  expect(() => countDeclaredPsiElements(bytes, "request", BIG)).toThrow(
    /past end/,
  );
});

// --- A frame scanned in pieces --------------------------------------------------

// The scan over `bytes` cut into pieces of `size` bytes: its count, or the
// message it throws.
function scannedInPieces(
  bytes: Uint8Array,
  kind: PsiMessageKind,
  ceiling: number,
  size: number,
): number | string {
  const scan = new PsiElementScan(kind, ceiling, bytes.byteLength);
  try {
    for (let start = 0; start < bytes.byteLength; start += size)
      if (scan.add(bytes.subarray(start, start + size)) > ceiling) break;
    return scan.end();
  } catch (error) {
    return (error as Error).message;
  }
}

function scannedWhole(
  bytes: Uint8Array,
  kind: PsiMessageKind,
  ceiling: number,
): number | string {
  try {
    return countDeclaredPsiElements(bytes, kind, ceiling);
  } catch (error) {
    return (error as Error).message;
  }
}

test("a frame scanned in pieces cut anywhere counts and refuses as the whole frame does", () => {
  const gcs = new lib.serverSetup();
  const gcsInfo = new lib.serverSetup.GCSInfo();
  gcsInfo.setDiv(300);
  gcsInfo.setHashRange(1 << 20);
  gcsInfo.setBits(new Uint8Array([1, 2, 3, 4]));
  gcs.setGcs(gcsInfo);
  const setup = rawSetupBytes(9, 33);
  const frames: Array<[PsiMessageKind, Uint8Array]> = [
    ["request", requestBytes(7, 35, true)],
    ["response", responseBytes(9, 33)],
    ["serverSetup", setup],
    ["serverSetup", rawSetupBytes(0)],
    ["serverSetup", gcs.serializeBinary()],
    ["serverSetup", setup.subarray(0, setup.length - 4)],
    ["serverSetup", new Uint8Array([...setup, 0x0a])],
    ["request", new Uint8Array([0x12, 0x64])],
    ["request", new Uint8Array([0x0b])],
    ["request", new Uint8Array([0x09, 1, 2, 3])],
    ["request", new Uint8Array([0x0d, 1, 2, 3, 4])],
    ["request", new Uint8Array([0x08, ...Array<number>(10).fill(0x80), 0])],
    ["serverSetup", new Uint8Array([0x0a, 0x04, 0x0a, 0x05, 1, 2])],
  ];
  for (const [kind, bytes] of frames)
    for (const ceiling of [BIG, 3])
      for (const size of [1, 2, 3, 5, 34, 35, 36, bytes.byteLength || 1])
        expect(scannedInPieces(bytes, kind, ceiling, size)).toStrictEqual(
          scannedWhole(bytes, kind, ceiling),
        );
});

test("a frame scanned in pieces past its stated length, or ending short of it, throws", () => {
  const bytes = requestBytes(3, 35);
  const over = new PsiElementScan("request", BIG, bytes.byteLength - 1);
  expect(() => over.add(bytes)).toThrow(/past the frame's length/);
  const short = new PsiElementScan("request", BIG, bytes.byteLength);
  short.add(bytes.subarray(0, 10));
  expect(() => short.end()).toThrow(/ends short of its length/);
});
