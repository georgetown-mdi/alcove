import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  INBOUND_FRAME_MEMORY_MULTIPLES,
  inboundFrameReadBytes,
  inboundPsiFramePeakBytes,
  psiFrameHandlingBytes,
} from "../../src/connection/inboundFrameMemory";

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
