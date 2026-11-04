import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  INBOUND_FRAME_MEMORY_MULTIPLES,
  inboundFrameReadBytes,
  inboundPsiFramePeakBytes,
  psiFrameHandlingBytes,
} from "../../src/connection/inboundFrameMemory";
import {
  AEAD_CHUNK_PLAINTEXT_BYTES,
  AEAD_TAG_BYTES,
} from "../../src/connection/chunkedAead";
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

  test("a version-2 read is the frame and one chunk's copy and plaintext", () => {
    const workingSet = 2 * (AEAD_CHUNK_PLAINTEXT_BYTES + AEAD_TAG_BYTES);
    expect(workingSet).toBe(32 * 1024 * 1024 + 32);
    expect(inboundFrameReadBytes(100, true, CHUNKED_ENVELOPE_VERSION)).toBe(
      100 + workingSet,
    );
    const gib = 1024 ** 3;
    expect(inboundFrameReadBytes(gib, true, CHUNKED_ENVELOPE_VERSION)).toBe(
      gib + workingSet,
    );
    expect(inboundFrameReadBytes(gib, true, SINGLE_CALL_ENVELOPE_VERSION)).toBe(
      4 * gib,
    );
  });

  test("a hand-off is the worker's copy and what the engine builds", () => {
    expect(psiFrameHandlingBytes(100, "decode")).toBe(865);
    expect(psiFrameHandlingBytes(100, "stream")).toBe(200);
  });

  test("a frame's peak is the larger of its read and of the frame with its hand-off", () => {
    expect(inboundPsiFramePeakBytes(100, "decode", true)).toBe(965);
    expect(inboundPsiFramePeakBytes(100, "stream", true)).toBe(400);
    expect(inboundPsiFramePeakBytes(100, "stream", false)).toBe(300);
  });
});
