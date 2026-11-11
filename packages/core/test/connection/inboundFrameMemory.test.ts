import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  CHUNKED_OPEN_PEAK_BYTES,
  fileSyncSinglePassHandOffBytes,
  INBOUND_FRAME_MEMORY_MULTIPLES,
  inboundFrameReadBytes,
  inboundPsiFramePeakBytes,
  psiFrameHandlingBytes,
  WEBRTC_PART_MEMORY_MULTIPLES,
  webRtcMessageReadBytes,
  webRtcMessageSendBytes,
  webRtcSinglePassHandOffBytes,
} from "../../src/connection/inboundFrameMemory";
import {
  CHUNKED_ENVELOPE_VERSION,
  SINGLE_CALL_ENVELOPE_VERSION,
} from "../../src/connection/encryptedMessageConnection";

// Each multiple is a measured figure, stated with its measurement in the
// table of docs/spec/FILE_SYNC_MEMORY.md, "Memory an inbound frame takes", whose
// rows name the constant they state.
const SPEC = path.resolve(
  __dirname,
  "../../../../docs/spec/FILE_SYNC_MEMORY.md",
);

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
      handedOverReply: 1.2,
      copiedReply: 3.9,
      handedOverRequest: 30.1,
      copiedRequest: 31,
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

  test("a frame moved to the worker is weighed without the worker's copy", () => {
    expect(psiFrameHandlingBytes(100, "decode", true)).toBe(765);
    expect(psiFrameHandlingBytes(100, "stream", true)).toBe(100);
  });

  test("a single-pass hand-off over file-sync is the request moved and masked, or the reply, at the measured multiples", () => {
    expect(fileSyncSinglePassHandOffBytes(100, "decode")).toBe(3_010);
    expect(fileSyncSinglePassHandOffBytes(100, "stream")).toBe(120);
  });

  test("a single-pass request is charged its masking, above the decoding the hand-off check charges", () => {
    expect(fileSyncSinglePassHandOffBytes(100, "decode")).toBeGreaterThan(
      psiFrameHandlingBytes(100, "decode", true),
    );
    expect(webRtcSinglePassHandOffBytes(100, "decode", false)).toBeGreaterThan(
      psiFrameHandlingBytes(100, "decode"),
    );
  });

  test("a frame's peak is the larger of its read and of the frame with its hand-off", () => {
    expect(
      inboundPsiFramePeakBytes(
        100,
        "decode",
        true,
        SINGLE_CALL_ENVELOPE_VERSION,
      ),
    ).toBe(3_110);
    expect(
      inboundPsiFramePeakBytes(
        100,
        "stream",
        true,
        SINGLE_CALL_ENVELOPE_VERSION,
      ),
    ).toBe(400);
    expect(inboundPsiFramePeakBytes(100, "stream", false, undefined)).toBe(220);
  });

  // Each measured run of a reply's or a request's hand-off, read from the
  // spec's tables: the frame, and the peak beyond it copied and handed over.
  const handOffRuns = (
    frame: "Reply" | "Request" = "Reply",
  ): Array<{
    frameBytes: number;
    copied: number;
    handedOver: number;
  }> => {
    const text = fs.readFileSync(SPEC, "utf8");
    const pattern = new RegExp(
      `^\\| ${frame}, ([\\d,]+) bytes [^|]+\\| ([\\d.]+) \\| ([\\d.]+) \\|$`,
    );
    return text.split("\n").flatMap((line) => {
      const row = pattern.exec(line);
      return row === null
        ? []
        : [
            {
              frameBytes: Number(row[1]!.replaceAll(",", "")),
              copied: Number(row[2]),
              handedOver: Number(row[3]),
            },
          ];
    });
  };

  test("the handed-over reply's multiple covers every measured run", () => {
    const runs = handOffRuns();
    expect(runs.length).toBeGreaterThanOrEqual(2);
    for (const { frameBytes, handedOver } of runs)
      expect(
        fileSyncSinglePassHandOffBytes(frameBytes, "stream"),
      ).toBeGreaterThan(frameBytes * handedOver);
  });

  test("a reply in one frame over WebRTC is charged at least each measured copied run", () => {
    const runs = handOffRuns();
    expect(runs.length).toBeGreaterThanOrEqual(2);
    for (const { frameBytes, copied } of runs)
      expect(
        webRtcSinglePassHandOffBytes(frameBytes, "stream", false),
      ).toBeGreaterThan(frameBytes * copied);
  });

  // The masking multiples are the largest run measured, rounded up to a tenth.
  const roundedUpToATenth = (figure: number): number =>
    Math.ceil(figure * 10) / 10;

  test("the handed-over request's multiple is the largest measured run, its masking included", () => {
    const runs = handOffRuns("Request");
    expect(runs.length).toBeGreaterThanOrEqual(4);
    expect(
      new Set(runs.map((run) => run.frameBytes)).size,
    ).toBeGreaterThanOrEqual(3);
    expect(INBOUND_FRAME_MEMORY_MULTIPLES.handedOverRequest).toBe(
      roundedUpToATenth(Math.max(...runs.map((run) => run.handedOver))),
    );
    for (const { frameBytes, handedOver } of runs)
      expect(
        fileSyncSinglePassHandOffBytes(frameBytes, "decode"),
      ).toBeGreaterThan(frameBytes * handedOver);
  });

  test("the copied request's multiple is the largest measured run, its masking included", () => {
    const runs = handOffRuns("Request");
    expect(INBOUND_FRAME_MEMORY_MULTIPLES.copiedRequest).toBe(
      roundedUpToATenth(Math.max(...runs.map((run) => run.copied))),
    );
    for (const { frameBytes, copied } of runs)
      for (const inParts of [false, true])
        expect(
          webRtcSinglePassHandOffBytes(frameBytes, "decode", inParts),
        ).toBeGreaterThan(frameBytes * copied);
  });

  test("over WebRTC, a request is copied and masked, and a reply in parts is the worker's copy and what the engine builds", () => {
    expect(webRtcSinglePassHandOffBytes(100, "stream", false)).toBe(390);
    expect(webRtcSinglePassHandOffBytes(100, "stream", true)).toBe(200);
    expect(webRtcSinglePassHandOffBytes(100, "decode", false)).toBe(3_100);
    expect(webRtcSinglePassHandOffBytes(100, "decode", true)).toBe(3_100);
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

// docs/spec/TRANSPORT_BOUNDS.md, "Memory a message in parts takes".
const TRANSPORT_SPEC = path.resolve(
  __dirname,
  "../../../../docs/spec/TRANSPORT_BOUNDS.md",
);

function transportSpecSection(): string {
  const text = fs.readFileSync(TRANSPORT_SPEC, "utf8");
  const start = text.indexOf("### Memory a message in parts takes");
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

const MiB = 2 ** 20;
const PART_BYTES = 267_532_399;

describe("the measured multiples of a message in parts over WebRTC", () => {
  test("are the figures the spec states", () => {
    const rows: Record<string, number> = {};
    for (const line of transportSpecSection().split("\n")) {
      const row = /^\| .*\(`(\w+)`\) \| ([\d.]+) \| /.exec(line);
      if (row !== null) rows[row[1]] = Number(row[2]);
    }
    expect(WEBRTC_PART_MEMORY_MULTIPLES).toEqual({ read: 5, send: 5.2 });
    expect(rows).toEqual(WEBRTC_PART_MEMORY_MULTIPLES);
  });

  // Each measured run's message and the receiver's and the sender's peaks
  // over their baselines, in MiB, read from the spec's table.
  const measured = (): Array<[number, number, number]> =>
    transportSpecSection()
      .split("\n")
      .flatMap((line) => {
        const row =
          /^\| (\d+) MiB, \w+ parts? \| [^|]+ \| ([\d,.]+) MiB \| ([\d,.]+) MiB \|$/.exec(
            line,
          );
        if (row === null) return [];
        const mib = (s: string) => Number(s.replaceAll(",", ""));
        return [[Number(row[1]), mib(row[2]), mib(row[3])]];
      });

  test("cover every measured run", () => {
    const runs = measured();
    expect(runs).toHaveLength(7);
    for (const [messageMiB, receiverMiB, senderMiB] of runs) {
      const message = messageMiB * MiB;
      expect(webRtcMessageReadBytes(message, PART_BYTES)).toBeGreaterThan(
        receiverMiB * MiB,
      );
      // The sender's message is held before its baseline.
      expect(
        webRtcMessageSendBytes(message, PART_BYTES) - message,
      ).toBeGreaterThan(senderMiB * MiB);
    }
  });

  test("a message within one part is charged at its own size", () => {
    expect(webRtcMessageReadBytes(100, PART_BYTES)).toBe(600);
    expect(webRtcMessageSendBytes(100, PART_BYTES)).toBe(620);
    expect(webRtcMessageReadBytes(3 * PART_BYTES, PART_BYTES)).toBe(
      8 * PART_BYTES,
    );
  });
});
