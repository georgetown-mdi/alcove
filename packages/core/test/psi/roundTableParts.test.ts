import { expect, test } from "vitest";

import {
  createMessagePipe,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import { webrtcFrameExceedsBound } from "../../src/connection/webrtcOutboundBound";
import { binaryPackByteStringLength } from "../../src/connection/webrtcOutboundBound";
import { ConnectionError } from "../../src/errors";
import { psiSetPartPayloadBytes } from "../../src/psi/psiSetParts";
import {
  numberArrayMessage,
  receiveRoundGrouping,
  receiveRoundIndexList,
  roundGroupingElement,
  roundIndexEntryBytes,
  sendRoundGrouping,
  sendRoundIndexList,
} from "../../src/psi/roundTableParts";
import { partFrame, readPartFrame } from "../utils/matchedListPartFrames";

// A cascade round's association table and original-index list, sent as
// matched-record lists in parts on a WebRTC connection, and every part
// sequence a receiver refuses (docs/spec/PROTOCOL.md, A list of matched
// records is sent in parts).

const WEBRTC_BOUND = 256;

// A pipe whose sending end states a data-channel bound of WEBRTC_BOUND bytes,
// recording every frame it sends.
function webRtcPipe(): {
  sender: MessageConnection;
  receiver: MessageConnection;
  sent: Array<Uint8Array>;
} {
  const [a, b] = createMessagePipe();
  const sent: Array<Uint8Array> = [];
  return {
    sender: {
      send: (data) => {
        sent.push(data as Uint8Array);
        return a.send(data);
      },
      receive: (timeoutMs?: number) => a.receive(timeoutMs),
      close: () => a.close(),
      outboundWebRtcFrameBound: () => WEBRTC_BOUND,
    },
    receiver: b,
    sent,
  };
}

// How many one-digit entries fill one part's body at WEBRTC_BOUND: each takes
// its digit and a separator, inside the array's two brackets.
const ENTRIES_PER_PART = Math.floor(
  (psiSetPartPayloadBytes(webRtcPipe().sender) - 2) / 2,
);

const digits = (count: number): Array<number> =>
  Array.from({ length: count }, (_, i) => i % 10);

async function deliver(frames: Array<unknown>): Promise<MessageConnection> {
  const [a, b] = createMessagePipe();
  for (const frame of frames) await a.send(frame);
  return b;
}

const receiveList = (conn: MessageConnection, maxEntries = 1_000) =>
  receiveRoundIndexList(conn, "server", "round index list", maxEntries, 10);

async function refusal(run: Promise<unknown>): Promise<ConnectionError> {
  const err = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  return err as ConnectionError;
}

test("a part holds a whole number of one-digit entries at the test bound", () => {
  expect(ENTRIES_PER_PART).toBeGreaterThan(10);
  expect(ENTRIES_PER_PART).toBeLessThan(WEBRTC_BOUND);
});

test.each([
  ["empty", 0, 1],
  ["of one entry", 1, 1],
  ["filling one part exactly", ENTRIES_PER_PART, 1],
  ["one entry past one part", ENTRIES_PER_PART + 1, 2],
  ["ending exactly at a part boundary", ENTRIES_PER_PART * 2, 2],
  ["spanning several parts", ENTRIES_PER_PART * 4 + 3, 5],
])(
  "an index list %s goes in its parts and joins back in order",
  async (_label, count, parts) => {
    const { sender, receiver, sent } = webRtcPipe();
    const list = digits(count);
    await sendRoundIndexList(sender, list);
    expect(sent).toHaveLength(parts);
    sent.forEach((frame, index) => {
      expect(readPartFrame(frame)?.header).toStrictEqual({
        index,
        count: parts,
        entries: count,
      });
      expect(
        webrtcFrameExceedsBound(
          binaryPackByteStringLength(frame.byteLength),
          WEBRTC_BOUND,
        ),
      ).toBe(false);
    });
    expect(await receiveList(receiver)).toStrictEqual(list);
  },
);

test("a grouping in several parts joins back in order, in either form", async () => {
  const runs = digits(ENTRIES_PER_PART * 2).map((d) => d + 1);
  const owners = Array.from({ length: 60 }, (_, i) => [i, i + 1]);
  for (const grouping of [runs, owners]) {
    const { sender, receiver, sent } = webRtcPipe();
    await sendRoundGrouping(sender, grouping);
    expect(sent.length).toBeGreaterThan(1);
    expect(
      await receiveRoundGrouping(receiver, "server", "grouping", 1_000),
    ).toStrictEqual(grouping);
  }
});

test("an omitted grouping is one part holding null, apart from an empty one", async () => {
  const omitted = webRtcPipe();
  await sendRoundGrouping(omitted.sender, undefined);
  expect(omitted.sent.map(readPartFrame)).toStrictEqual([
    { header: { index: 0, count: 1, entries: 0 }, body: null },
  ]);
  expect(
    await receiveRoundGrouping(omitted.receiver, "server", "grouping", 0),
  ).toBeUndefined();

  const empty = webRtcPipe();
  await sendRoundGrouping(empty.sender, []);
  expect(
    await receiveRoundGrouping(empty.receiver, "server", "grouping", 0),
  ).toStrictEqual([]);
});

test("a null part in a grouping that declares entries is refused", async () => {
  const conn = await deliver([partFrame(null, { entries: 2 })]);
  const err = await refusal(
    receiveRoundGrouping(conn, "server", "grouping", 10),
  );
  expect(err.message).toMatch(/inbound grouping part 0 holds no entries/);
});

// --- refusals ------------------------------------------------------------------

test("a missing part is refused", async () => {
  const conn = await deliver([
    partFrame([0, 1], { index: 0, count: 3, entries: 6 }),
    partFrame([4, 5], { index: 2, count: 3, entries: 6 }),
  ]);
  const err = await refusal(receiveList(conn));
  expect(err.message).toMatch(
    /server protocol error: inbound round index list is missing part 1/,
  );
});

test("an out-of-order part is refused", async () => {
  const swapped = await deliver([
    partFrame([2, 3], { index: 1, count: 2, entries: 4 }),
    partFrame([0, 1], { index: 0, count: 2, entries: 4 }),
  ]);
  expect((await refusal(receiveList(swapped))).message).toMatch(
    /is missing part 0/,
  );
  const repeated = await deliver([
    partFrame([0, 1], { index: 0, count: 2, entries: 4 }),
    partFrame([0, 1], { index: 0, count: 2, entries: 4 }),
  ]);
  expect((await refusal(receiveList(repeated))).message).toMatch(
    /repeats part 0/,
  );
});

test("a part over the bytes its remaining entries can take is refused before its body is parsed", async () => {
  // Two entries below 10: a part of at most 16 + 2 + 2 * 2 bytes.
  expect(roundIndexEntryBytes(10)).toBe(2);
  const conn = await deliver([partFrame([10_000, 1], { entries: 2 })]);
  const err = await refusal(receiveList(conn));
  expect(err.message).toMatch(/part 0 is over the 22 bytes this party admits/);
});

test("a list declaring more entries than this party admits is refused at its first part", async () => {
  const conn = await deliver([partFrame([0, 1, 2])]);
  const err = await refusal(receiveList(conn, 2));
  expect(err.message).toMatch(/declares 3 entries, over the 2 this party/);
});

test("a sequence claiming more parts than arrive is refused at the frame that follows", async () => {
  // The list's last part never comes; what arrives in its place is the next
  // list's first part, or the round's acknowledgement.
  const nextList = await deliver([
    partFrame([0, 1], { index: 0, count: 3, entries: 6 }),
    partFrame([2, 3], { index: 1, count: 3, entries: 6 }),
    partFrame(null, { entries: 0 }),
  ]);
  expect((await refusal(receiveList(nextList))).message).toMatch(
    /repeats part 0/,
  );
  const acknowledgement = await deliver([
    partFrame([0, 1], { index: 0, count: 2, entries: 4 }),
    { status: "completed" },
  ]);
  expect((await refusal(receiveList(acknowledgement))).message).toMatch(
    /inbound round index list is not a binary frame/,
  );
});

test("parts ending short of the declared entries are refused", async () => {
  const conn = await deliver([partFrame([0, 1], { entries: 3 })]);
  expect((await refusal(receiveList(conn))).message).toMatch(
    /ends short of the list's declared entries/,
  );
});

test("a part whose body is not an index list is refused", async () => {
  // Past an unbounded index range, so no byte bound refuses the part first.
  const conn = await deliver([partFrame(["x"])]);
  const run = receiveRoundIndexList(
    conn,
    "server",
    "round index list",
    1,
    Number.POSITIVE_INFINITY,
  );
  expect((await refusal(run)).message).toMatch(/failed schema validation/);
});

// --- the part schemas ---------------------------------------------------------

test("an index list part admits finite numbers alone", () => {
  expect(numberArrayMessage.safeParse([0, 1.5, 2]).success).toBe(true);
  expect(numberArrayMessage.safeParse([0, "1"]).success).toBe(false);
  expect(numberArrayMessage.safeParse([[0]]).success).toBe(false);
});

test("a grouping part admits run lengths or owner lists, nested one level", () => {
  expect(roundGroupingElement.safeParse([1, 2]).success).toBe(true);
  expect(roundGroupingElement.safeParse([[0], [0, 1]]).success).toBe(true);
  expect(roundGroupingElement.safeParse([[[0]]]).success).toBe(false);
  expect(roundGroupingElement.safeParse(["x"]).success).toBe(false);
});

test("a pathological-count grouping part fails cleanly, not with a RangeError", async () => {
  // The grouping is partner-controlled, so it takes the single-issue
  // validation: one issue however many invalid entries it holds.
  const conn = await deliver([
    partFrame(
      Array.from({ length: 300_000 }, () => "x"),
      { entries: 1 },
    ),
  ]);
  const err = await refusal(receiveRoundGrouping(conn, "", "grouping", 10));
  expect(err.cause).not.toBeInstanceOf(RangeError);
});

test("an index entry's byte bound counts the digits of the largest index", () => {
  expect(roundIndexEntryBytes(1)).toBe(2);
  expect(roundIndexEntryBytes(1_000)).toBe(4);
  expect(roundIndexEntryBytes(1_001)).toBe(5);
  expect(roundIndexEntryBytes(Number.POSITIVE_INFINITY)).toBeUndefined();
});
