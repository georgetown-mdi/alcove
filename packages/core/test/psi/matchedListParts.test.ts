import { describe, expect, test, vi } from "vitest";

import {
  ConnectionError,
  createMessagePipe,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import { MESSAGE_HEADER_BYTES } from "../../src/connection/fileSyncFraming";
import { PeerAbortError } from "../../src/errors";
import {
  arraySource,
  joinMatchedArrayParts,
  MATCHED_LIST_PART_HEADER_BYTES,
  matchedListParts,
  parseMatchedListParts,
  receiveMatchedArray,
  receiveMatchedListParts,
  sendMatchedList,
  utf8Length,
} from "../../src/psi/matchedListParts";
import { partFrame, readPartFrame } from "../utils/matchedListPartFrames";

// The parts a matched-record list is sent in, and every part sequence a
// receiver refuses before any part's body is parsed (docs/spec/PROTOCOL.md, A
// list of matched records is sent in parts).

const entries = Array.from({ length: 40 }, (_, i) => ({
  theirIndex: i * 7,
  iteration: i % 3,
}));

const asArray = (value: unknown): Array<unknown> => {
  if (!Array.isArray(value)) throw new Error("not an array");
  return value;
};

// A pipe whose sending end states a file-sync message-file bound leaving
// `bodyBytes` bytes for each part's body.
function pipeWithPartBody(
  bodyBytes: number,
): [MessageConnection, MessageConnection] {
  const [a, b] = createMessagePipe();
  const bound =
    MESSAGE_HEADER_BYTES + MATCHED_LIST_PART_HEADER_BYTES + bodyBytes;
  return [
    {
      send: (data) => a.send(data),
      receive: (timeoutMs?: number) => a.receive(timeoutMs),
      close: () => a.close(),
      outboundFileSyncFrameBound: () => bound,
    },
    b,
  ];
}

async function deliver(frames: Array<unknown>): Promise<MessageConnection> {
  const [a, b] = createMessagePipe();
  for (const frame of frames) await a.send(frame);
  return b;
}

async function refusalOf(
  frames: Array<unknown>,
  maxEntries = 100,
): Promise<unknown> {
  const parsePart = vi.fn(asArray);
  const conn = await deliver(frames);
  const outcome = await receiveMatchedArray(
    conn,
    "client",
    "mapped-element list",
    maxEntries,
    parsePart,
  ).catch((error: unknown) => error);
  return { outcome, parsed: parsePart.mock.calls.length };
}

describe("sending", () => {
  test("a list that fits one part is one part holding the whole list", () => {
    const parts = [...matchedListParts(arraySource(entries), 1 << 20)];
    expect(parts).toHaveLength(1);
    expect(readPartFrame(parts[0])).toEqual({
      header: { index: 0, count: 1, entries: entries.length },
      body: entries,
    });
  });

  test("an empty list is one part holding an empty array", () => {
    const parts = [...matchedListParts(arraySource([]), 64)];
    expect(parts.map(readPartFrame)).toEqual([
      { header: { index: 0, count: 1, entries: 0 }, body: [] },
    ]);
  });

  test("a list past one part's bytes is cut into parts each within them", () => {
    const bodyBytes = 200;
    const parts = [...matchedListParts(arraySource(entries), bodyBytes)];
    expect(parts.length).toBeGreaterThan(1);
    const joined: Array<unknown> = [];
    parts.forEach((part, index) => {
      expect(
        part.byteLength - MATCHED_LIST_PART_HEADER_BYTES,
      ).toBeLessThanOrEqual(bodyBytes);
      const read = readPartFrame(part)!;
      expect(read.header).toEqual({
        index,
        count: parts.length,
        entries: entries.length,
      });
      joined.push(...asArray(read.body));
    });
    expect(joined).toEqual(entries);
  });

  test("a list past one part's entries is cut at the entry bound", () => {
    const parts = [...matchedListParts(arraySource(entries), 1 << 20, 16)];
    expect(
      parts.map((part) => asArray(readPartFrame(part)!.body).length),
    ).toEqual([16, 16, 8]);
  });

  test("an entry no part can hold is refused before any part is built", () => {
    expect(() => [
      ...matchedListParts(arraySource(["x".repeat(64)]), 32),
    ]).toThrow(/does not fit one part/);
  });

  test("an entry is measured in UTF-8 bytes", () => {
    for (const text of ["a", "é", "€", "😀", "\ud800"])
      expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length);
  });

  test("a list sent on a connection is sized to its stated bound and received whole", async () => {
    const [sender, receiver] = pipeWithPartBody(150);
    const sending = sendMatchedList(sender, arraySource(entries));
    const received = await receiveMatchedListParts(
      receiver,
      "client",
      "mapped-element list",
      entries.length,
    );
    await sending;
    expect(received.bodies.length).toBeGreaterThan(1);
    expect(
      joinMatchedArrayParts(received, "client", "mapped-element list", asArray),
    ).toEqual(entries);
  });
});

describe("what a receiver refuses before parsing any part", () => {
  const [first, second, third] = [
    ...matchedListParts(arraySource(entries), 1 << 20, 16),
  ];

  test.each([
    ["a missing part", [first, third], "is missing part 1"],
    ["a repeated part", [first, first], "repeats part 0"],
    ["a part out of order", [second, first], "is missing part 0"],
    [
      "a list declaring more entries than this party admits",
      [first],
      "declares 40 entries, over the 39 this party admits",
      39,
    ],
    [
      "a part count of zero",
      [partFrame([1], { count: 0, entries: 1 })],
      "declares 0 parts for a list of 1 entry",
    ],
    [
      "more parts than entries",
      [partFrame([1], { count: 2, entries: 1 })],
      "declares 2 parts for a list of 1 entry",
    ],
    [
      "a later part declaring another count",
      [first, partFrame([1], { index: 1, count: 4, entries: 40 })],
      "part 1 declares a different list than part 0",
    ],
    [
      "a later part declaring other entries",
      [first, partFrame([1], { index: 1, count: 3, entries: 41 })],
      "part 1 declares a different list than part 0",
    ],
    [
      "a part shorter than its header",
      [new Uint8Array(MATCHED_LIST_PART_HEADER_BYTES - 1)],
      "part 0 is shorter than its header",
    ],
    [
      "a part with no body",
      [first.subarray(0, MATCHED_LIST_PART_HEADER_BYTES)],
      "part 0 has no body",
    ],
    ["a JSON frame in place of a part", [entries], "is not a binary frame"],
  ] as Array<[string, Array<unknown>, string, number?]>)(
    "%s",
    async (_name, frames, detail, maxEntries) => {
      const { outcome, parsed } = (await refusalOf(frames, maxEntries)) as {
        outcome: unknown;
        parsed: number;
      };
      expect(outcome).toBeInstanceOf(ConnectionError);
      expect((outcome as ConnectionError).kind).toBe("protocol");
      expect((outcome as Error).message).toBe(
        `client protocol error: inbound mapped-element list ${detail}`,
      );
      expect(parsed).toBe(0);
    },
  );

  test("an abort in place of a part ends the receive as the partner's abort", async () => {
    const { outcome, parsed } = (await refusalOf([
      first,
      { decision: "abort", abortReasons: ["any text"] },
    ])) as { outcome: unknown; parsed: number };
    expect(outcome).toBeInstanceOf(PeerAbortError);
    expect(parsed).toBe(0);
  });

  test("a part sequence that never ends is not parsed while it waits", async () => {
    const parsePart = vi.fn(asArray);
    const conn = await deliver([first, second]);
    const receive = receiveMatchedArray(conn, "client", "list", 100, parsePart);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(parsePart).not.toHaveBeenCalled();
    await conn.close();
    await expect(receive).rejects.toBeInstanceOf(ConnectionError);
  });
});

describe("what a receiver refuses once the headers hold", () => {
  async function joined(frames: Array<unknown>): Promise<unknown> {
    const conn = await deliver(frames);
    const received = await receiveMatchedListParts(conn, "client", "list", 100);
    return Promise.resolve()
      .then(() => joinMatchedArrayParts(received, "client", "list", asArray))
      .catch((error: unknown) => error);
  }

  test.each([
    [
      "a body that is not JSON",
      [
        (() => {
          const frame = partFrame([1]);
          frame[MATCHED_LIST_PART_HEADER_BYTES] = 0x7b;
          return frame;
        })(),
      ],
      "part 0 is not a JSON message",
    ],
    [
      "a part holding no entries in a list that is not empty",
      [
        partFrame([], { index: 0, count: 2, entries: 2 }),
        partFrame([1, 2], { index: 1, count: 2, entries: 2 }),
      ],
      "part 0 holds no entries",
    ],
    [
      "a part running past the declared entries",
      [partFrame([1, 2, 3], { entries: 2 })],
      "part 0 runs past the list's declared entries",
    ],
    [
      "parts ending short of the declared entries",
      [partFrame([1], { entries: 2 })],
      "ends short of the list's declared entries",
    ],
  ] as Array<[string, Array<unknown>, string]>)(
    "%s",
    async (_n, frames, detail) => {
      const outcome = await joined(frames);
      expect(outcome).toBeInstanceOf(ConnectionError);
      expect((outcome as Error).message).toBe(
        `client protocol error: inbound list ${detail}`,
      );
    },
  );

  test("a body's parse error names no partner byte", async () => {
    const frame = partFrame(["secret-value"]);
    frame[frame.length - 1] = 0x2c;
    const outcome = await joined([frame]);
    expect(outcome).toBeInstanceOf(ConnectionError);
    expect(String(outcome)).not.toContain("secret-value");
    expect((outcome as Error).cause).toBeUndefined();
  });

  test("each part is validated by the caller's parse", async () => {
    const conn = await deliver([partFrame([1, "two"])]);
    const received = await receiveMatchedListParts(conn, "client", "list", 100);
    expect(() =>
      parseMatchedListParts(received, "client", "list", (value) => {
        const part = asArray(value);
        if (!part.every(Number.isFinite)) throw new Error("not a number list");
        return { part, entries: part.length };
      }),
    ).toThrow("not a number list");
  });
});
