import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  CHUNKED_OPEN_PEAK_BYTES,
  INBOUND_FRAME_MEMORY_MULTIPLES,
  inboundFrameReadBytes,
  inboundPsiFramePeakBytes,
  psiFrameHandlingBytes,
} from "../../src/connection/inboundFrameMemory";
import {
  CHUNKED_ENVELOPE_VERSION,
  SINGLE_CALL_ENVELOPE_VERSION,
} from "../../src/connection/encryptedMessageConnection";

// Each multiple is a measured figure, stated with its measurement in the
// table of docs/spec/FILE_SYNC.md, "Memory an inbound frame takes", whose
// rows name the constant they state.
const SPEC = path.resolve(__dirname, "../../../../docs/spec/FILE_SYNC.md");

function specMultiples(): Record<string, number> {
  const text = fs.readFileSync(SPEC, "utf8");
  const start = text.indexOf("### Memory an inbound frame takes");
  const section = text.slice(start, text.indexOf("\n### ", start + 1));
  const rows: Record<string, number> = {};
  for (const line of section.split("\n")) {
    const row = /^\| .*\(`(\w+)`\) \| ([\d.]+) \| /.exec(line);
    if (row !== null) rows[row[1]] = Number(row[2]);
  }
  return rows;
}

describe("the measured multiples of an inbound frame", () => {
  test("are the figures the spec states with their measurements", () => {
    expect(INBOUND_FRAME_MEMORY_MULTIPLES).toEqual({
      aeadOpen: 4,
      psiDecode: 7.65,
      streamedSetup: 1,
      workerClone: 1,
    });
    expect(specMultiples()).toEqual(INBOUND_FRAME_MEMORY_MULTIPLES);
  });

  test("a read is the frame, or the frame with its decryption", () => {
    expect(inboundFrameReadBytes(100, false)).toBe(100);
    expect(inboundFrameReadBytes(100, true)).toBe(400);
    expect(inboundFrameReadBytes(100, false, CHUNKED_ENVELOPE_VERSION)).toBe(
      100,
    );
  });

  test("a version-1 read, or one before a version is negotiated, is at the aeadOpen multiple", () => {
    expect(inboundFrameReadBytes(100, true, SINGLE_CALL_ENVELOPE_VERSION)).toBe(
      100 * INBOUND_FRAME_MEMORY_MULTIPLES.aeadOpen,
    );
    expect(inboundFrameReadBytes(100, true, undefined)).toBe(
      100 * INBOUND_FRAME_MEMORY_MULTIPLES.aeadOpen,
    );
  });

  // The largest of three peaks above the loaded envelope at each size, in a
  // fresh process with no forced collection (docs/spec/TRANSPORT_BOUNDS.md,
  // Inbound frame-size bound).
  const MEASURED_CHUNKED_OPENS = [
    { envelopeBytes: 16_777_258, peakAboveEnvelopeBytes: 33_984_512 },
    { envelopeBytes: 67_108_954, peakAboveEnvelopeBytes: 83_263_488 },
    { envelopeBytes: 268_435_738, peakAboveEnvelopeBytes: 99_962_880 },
    { envelopeBytes: 1_073_742_874, peakAboveEnvelopeBytes: 100_077_568 },
    { envelopeBytes: 2_147_489_818, peakAboveEnvelopeBytes: 101_023_744 },
  ];

  test.each(MEASURED_CHUNKED_OPENS)(
    "a version-2 read of $envelopeBytes bytes covers the measured peak",
    ({ envelopeBytes, peakAboveEnvelopeBytes }) => {
      expect(
        inboundFrameReadBytes(envelopeBytes, true, CHUNKED_ENVELOPE_VERSION),
      ).toBeGreaterThanOrEqual(envelopeBytes + peakAboveEnvelopeBytes);
      expect(
        inboundFrameReadBytes(
          envelopeBytes,
          true,
          SINGLE_CALL_ENVELOPE_VERSION,
        ),
      ).toBe(envelopeBytes * INBOUND_FRAME_MEMORY_MULTIPLES.aeadOpen);
      expect(inboundFrameReadBytes(envelopeBytes, true, undefined)).toBe(
        envelopeBytes * INBOUND_FRAME_MEMORY_MULTIPLES.aeadOpen,
      );
    },
  );

  test("a version-2 read is the frame and the largest peak measured", () => {
    expect(CHUNKED_OPEN_PEAK_BYTES).toBe(
      Math.max(
        ...MEASURED_CHUNKED_OPENS.map((row) => row.peakAboveEnvelopeBytes),
      ),
    );
    expect(inboundFrameReadBytes(100, true, CHUNKED_ENVELOPE_VERSION)).toBe(
      100 + CHUNKED_OPEN_PEAK_BYTES,
    );
  });

  test("a hand-off is the worker's copy and what the engine builds", () => {
    expect(psiFrameHandlingBytes(100, "decode")).toBe(865);
    expect(psiFrameHandlingBytes(100, "stream")).toBe(200);
  });

  test("a frame's peak is the larger of its read and of the frame with its hand-off", () => {
    expect(
      inboundPsiFramePeakBytes(
        100,
        "decode",
        true,
        SINGLE_CALL_ENVELOPE_VERSION,
      ),
    ).toBe(965);
    expect(
      inboundPsiFramePeakBytes(
        100,
        "stream",
        true,
        SINGLE_CALL_ENVELOPE_VERSION,
      ),
    ).toBe(400);
    expect(inboundPsiFramePeakBytes(100, "stream", false, undefined)).toBe(300);
  });

  test.each([
    ["version 1", SINGLE_CALL_ENVELOPE_VERSION, 400],
    ["no negotiated version", undefined, 400],
    ["version 2", CHUNKED_ENVELOPE_VERSION, 100 + CHUNKED_OPEN_PEAK_BYTES],
  ])(
    "a frame's read under %s is charged as the read gate charges it",
    (_what, envelopeVersion, readBytes) => {
      expect(
        inboundPsiFramePeakBytes(100, "stream", true, envelopeVersion),
      ).toBe(readBytes);
      expect(inboundFrameReadBytes(100, true, envelopeVersion)).toBe(readBytes);
    },
  );
});
