import { expect, test } from "vitest";

import {
  createMessagePipe,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import {
  MAX_FRAME_SIZE_BYTES,
  MAX_PSI_DECODE_ELEMENTS,
} from "../../src/connection/frameSize";
import { MAX_WEBRTC_FRAME_BYTES } from "../../src/connection/binaryPackBounds";
import { webrtcFrameExceedsBound } from "../../src/connection/webrtcOutboundBound";
import { binaryPackByteStringLength } from "../../src/connection/webrtcOutboundBound";
import { ConnectionError, InternalConsistencyError } from "../../src/errors";
import { matchedListParts } from "../../src/psi/matchedListParts";
import { psiSetPartPayloadBytes } from "../../src/psi/psiSetParts";
import { readPartnerRoundGrouping } from "../../src/psi/roundGrouping";
import {
  receiveRoundGrouping,
  receiveRoundIndexList,
  roundGroupingBound,
  roundGroupingSource,
  sendRoundGrouping,
  sendRoundIndexList,
} from "../../src/psi/roundTableParts";
import {
  OMITTED_GROUPING_LAYOUT,
  OWNER_LISTS_LAYOUT,
  RUN_LENGTHS_LAYOUT,
} from "../../src/psi/uint32ListParts";
import { partFrame, readPartFrame } from "../utils/matchedListPartFrames";

import type { RoundGroupingField } from "../../src/psi/roundGrouping";
import type { RoundGroupingSizeBounds } from "../../src/psi/roundTableParts";

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

// How many index entries fill one part's body at WEBRTC_BOUND: a word each,
// after the body's layout tag and entry count.
const ENTRIES_PER_PART = Math.floor(
  (psiSetPartPayloadBytes(webRtcPipe().sender) - 8) / 4,
);

// A grouping sent in the parts `conn`'s frame bound cuts it to, without the
// sender's check of their total against that bound, which several parts
// at that bound exceed.
async function sendGroupingUnchecked(
  conn: MessageConnection,
  field: RoundGroupingField | undefined,
): Promise<void> {
  for (const part of matchedListParts(
    roundGroupingSource(field),
    psiSetPartPayloadBytes(conn),
  ))
    await conn.send(part);
}

const digits = (count: number): Array<number> =>
  Array.from({ length: count }, (_, i) => i % 10);

async function deliver(frames: Array<unknown>): Promise<MessageConnection> {
  const [a, b] = createMessagePipe();
  for (const frame of frames) await a.send(frame);
  return b;
}

// `frames` delivered to a receiver whose connection states a data-channel
// bound of `frameBound` bytes.
async function deliverStating(
  frames: Array<unknown>,
  frameBound: number,
): Promise<MessageConnection> {
  const conn = await deliver(frames);
  return {
    send: (data) => conn.send(data),
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
    outboundWebRtcFrameBound: () => frameBound,
  };
}

const receiveList = (conn: MessageConnection, maxEntries = 1_000) =>
  receiveRoundIndexList(conn, "server", "round index list", maxEntries);

// Bounds wide enough that no grouping a test sends reaches its byte bound.
const WIDE_GROUPING: RoundGroupingSizeBounds = {
  maxPositionsPerRecord: 2 ** 31,
  partnerRecordCount: 2 ** 31,
  ownerLists: true,
};

const runLengths = (runs: Array<number>): RoundGroupingField => ({
  form: "run-lengths",
  runLengths: runs,
});

const ownerLists = (lists: Array<Array<number>>): RoundGroupingField => ({
  form: "owner-lists",
  ownerCounts: lists.map((list) => list.length),
  owners: lists.flat(),
});

// A received grouping with its words as plain arrays, to compare with the one
// sent.
function plain(
  field: RoundGroupingField | undefined,
): RoundGroupingField | undefined {
  if (field === undefined || field.form === "run-lengths")
    return field && runLengths(Array.from(field.runLengths));
  return {
    form: "owner-lists",
    ownerCounts: Array.from(field.ownerCounts),
    owners: Array.from(field.owners),
  };
}

async function refusal(run: Promise<unknown>): Promise<ConnectionError> {
  const err = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  return err as ConnectionError;
}

test("a part holds a whole number of index entries at the test bound", () => {
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
  const runs = runLengths(digits(ENTRIES_PER_PART * 2).map((d) => d + 1));
  const owners = ownerLists(Array.from({ length: 60 }, (_, i) => [i, i + 1]));
  for (const grouping of [runs, owners]) {
    const { sender, receiver, sent } = webRtcPipe();
    await sendGroupingUnchecked(sender, grouping);
    expect(sent.length).toBeGreaterThan(1);
    expect(
      plain(
        await receiveRoundGrouping(
          receiver,
          "server",
          "grouping",
          1_000,
          WIDE_GROUPING,
        ),
      ),
    ).toStrictEqual(grouping);
  }
});

test("an omitted grouping is one part of its own layout, apart from an empty one", async () => {
  // The tightest bounds a round can state, so the omitted part is admitted at
  // the smallest byte bound a grouping takes.
  const tightest: RoundGroupingSizeBounds = {
    maxPositionsPerRecord: 1,
    partnerRecordCount: 0,
    ownerLists: false,
  };
  const omitted = webRtcPipe();
  await sendRoundGrouping(omitted.sender, undefined);
  expect(omitted.sent.map(readPartFrame)).toStrictEqual([
    {
      header: { index: 0, count: 1, entries: 0 },
      body: null,
      layout: OMITTED_GROUPING_LAYOUT,
    },
  ]);
  expect(omitted.sent[0].byteLength).toBe(24);
  expect(
    await receiveRoundGrouping(
      omitted.receiver,
      "server",
      "grouping",
      0,
      tightest,
    ),
  ).toBeUndefined();

  const empty = webRtcPipe();
  await sendRoundGrouping(empty.sender, ownerLists([]));
  expect(
    plain(
      await receiveRoundGrouping(empty.receiver, "server", "grouping", 0, {
        ...tightest,
        ownerLists: true,
      }),
    ),
  ).toStrictEqual(ownerLists([]));
});

// Each ordinal below `records` on `perRecord` of `positions` owner lists, the
// most ordinals and the longest ones such a round admits; `perRecord` divides
// `positions`.
function largestOwnerLists(
  positions: number,
  records: number,
  perRecord: number,
): RoundGroupingField {
  const lists: Array<Array<number>> = Array.from(
    { length: positions },
    () => [],
  );
  const stride = positions / perRecord;
  for (let ordinal = 0; ordinal < records; ordinal++)
    for (let k = 0; k < perRecord; k++)
      lists[(ordinal % stride) + k * stride].push(ordinal);
  return ownerLists(lists);
}

test.each([
  [
    "owner lists",
    largestOwnerLists(8, 60, 4),
    8,
    { maxPositionsPerRecord: 4, partnerRecordCount: 60, ownerLists: true },
  ],
  [
    "run lengths",
    runLengths(Array.from({ length: 400 }, () => 1)),
    400,
    { maxPositionsPerRecord: 20, partnerRecordCount: 400, ownerLists: false },
  ],
])(
  "the largest grouping of %s a round admits is accepted in several parts",
  async (_label, grouping, matched, bounds) => {
    const positions = Array.from({ length: matched }, (_, k) => k);
    expect(() =>
      readPartnerRoundGrouping(grouping, positions, {
        participantId: "server",
        ...bounds,
      }),
    ).not.toThrow();
    const { sender, receiver, sent } = webRtcPipe();
    await sendGroupingUnchecked(sender, grouping);
    expect(sent.length).toBeGreaterThan(2);
    const sentBytes = sent.reduce((sum, frame) => sum + frame.byteLength, 0);
    expect(sentBytes).toBe(
      roundGroupingBound(
        positions.length,
        bounds,
        Number.POSITIVE_INFINITY,
      ).listBytes?.(sent.length),
    );
    expect(
      plain(
        await receiveRoundGrouping(
          receiver,
          "server",
          "grouping",
          positions.length,
          bounds,
        ),
      ),
    ).toStrictEqual(grouping);

    // A receiver stating a frame bound of exactly the parts' bytes takes them,
    // and one stating a byte less refuses them.
    for (const [frameBound, accepted] of [
      [sentBytes, true],
      [sentBytes - 1, false],
    ] as const) {
      const run = receiveRoundGrouping(
        await deliverStating(sent, frameBound),
        "server",
        "grouping",
        positions.length,
        bounds,
      );
      if (accepted) expect(plain(await run)).toStrictEqual(grouping);
      else
        expect((await refusal(run)).message).toMatch(
          new RegExp(`part ${sent.length - 1} is over the`),
        );
    }
  },
);

test("a grouping part over the bytes the round admits is refused as an index list's part is", async () => {
  // Two run lengths in one part: its 16-byte header, 8 bytes of tag and
  // count, and a word for each, the index list's bound for two entries.
  const runs = { maxPositionsPerRecord: 1, partnerRecordCount: 2 };
  expect(
    roundGroupingBound(2, { ...runs, ownerLists: false }, 1_000).listBytes?.(1),
  ).toBe(32);
  const threeWords = () =>
    partFrame([1, 1, 1], { entries: 2 }, RUN_LENGTHS_LAYOUT);
  const err = await refusal(
    receiveRoundGrouping(
      await deliver([threeWords()]),
      "server",
      "grouping",
      2,
      {
        ...runs,
        ownerLists: false,
      },
    ),
  );
  expect(err.message).toMatch(/part 0 is over the 32 bytes this party admits/);
  expect(err.message).toBe(
    (
      await refusal(
        receiveList(await deliver([partFrame([1, 1, 1], { entries: 2 })])),
      )
    ).message.replace("round index list", "grouping"),
  );

  // Three owner lists of ordinals below 3, each on one list, in two parts: a
  // count word per list, a word per ordinal and 24 bytes for each part, so
  // the second part is held to what the first, 32 bytes, left of 72.
  const owners = { maxPositionsPerRecord: 1, partnerRecordCount: 3 };
  expect(
    roundGroupingBound(3, { ...owners, ownerLists: true }, 1_000).listBytes?.(
      2,
    ),
  ).toBe(72);
  const later = await deliver([
    partFrame([[0]], { index: 0, count: 2, entries: 3 }),
    partFrame([[1, 1, 1, 1, 1, 1, 1], [2]], { index: 1, count: 2, entries: 3 }),
  ]);
  expect(
    (
      await refusal(
        receiveRoundGrouping(later, "server", "grouping", 3, {
          ...owners,
          ownerLists: true,
        }),
      )
    ).message,
  ).toMatch(/part 1 is over the 40 bytes this party admits/);
});

// The grouping a connection stating `frameBound` receives, in parts of the
// stated numbers of run lengths of 1.
async function groupingParts(
  frameBound: number,
  sizes: Array<number>,
): Promise<MessageConnection> {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return deliverStating(
    sizes.map((size, index) =>
      partFrame(
        Array.from({ length: size }, () => 1),
        { index, count: sizes.length, entries: total },
        RUN_LENGTHS_LAYOUT,
      ),
    ),
    frameBound,
  );
}

test("a grouping's budget is the connection's frame bound at the largest declared counts", () => {
  const largest = {
    maxPositionsPerRecord: 1,
    partnerRecordCount: 10 ** 12,
    ownerLists: true,
  };
  for (const frameBound of [MAX_WEBRTC_FRAME_BYTES, MAX_FRAME_SIZE_BYTES])
    for (const parts of [1, 2 ** 24])
      expect(
        roundGroupingBound(2 ** 24, largest, frameBound).listBytes?.(parts),
      ).toBe(frameBound);
  expect(
    roundGroupingBound(2 ** 24, largest, MAX_WEBRTC_FRAME_BYTES).entries,
  ).toBe(2 ** 24);
  expect(
    roundGroupingBound(
      3,
      { ...largest, partnerRecordCount: 1 },
      1_000,
    ).listBytes?.(3),
  ).toBe(4 * 3 + 4 + 24 * 3);
});

test("no round's run lengths reach either frame bound", () => {
  const widest = {
    maxPositionsPerRecord: 1,
    partnerRecordCount: MAX_PSI_DECODE_ELEMENTS,
    ownerLists: false,
  };
  for (const frameBound of [MAX_WEBRTC_FRAME_BYTES, MAX_FRAME_SIZE_BYTES]) {
    expect(4 * MAX_PSI_DECODE_ELEMENTS).toBeLessThan(frameBound);
    expect(
      roundGroupingBound(
        MAX_PSI_DECODE_ELEMENTS,
        widest,
        frameBound,
      ).listBytes?.(1),
    ).toBeLessThan(frameBound);
  }
});

test("a grouping over the frame bound in all its parts is refused, one just under it accepted", async () => {
  // A part of n run lengths is its 16-byte header and a body of 8 + 4n bytes:
  // 10 of them in four parts take 136 bytes in all.
  const bound = 136;
  const read = async (sizes: Array<number>) => {
    const field = await receiveRoundGrouping(
      await groupingParts(bound, sizes),
      "server",
      "grouping",
      1_000,
      WIDE_GROUPING,
    );
    return field?.form === "run-lengths" ? field.runLengths.length : undefined;
  };
  expect(await read([3, 3, 2, 2])).toBe(10);
  expect(await read([3, 2, 2, 2])).toBe(9);
  expect(
    (
      await refusal(
        receiveRoundGrouping(
          await groupingParts(bound, [3, 3, 3, 2]),
          "server",
          "grouping",
          1_000,
          WIDE_GROUPING,
        ),
      )
    ).message,
  ).toMatch(/part 3 is over the 28 bytes this party admits/);
});

test("a grouping is sent only if its parts total within the frame bound", async () => {
  const sendAtBound = async (grouping: RoundGroupingField | undefined) => {
    const { sender, sent } = webRtcPipe();
    const outcome = await sendRoundGrouping(sender, grouping).then(
      () => undefined,
      (e: unknown) => e,
    );
    return { sent, outcome };
  };
  const fits = await sendAtBound(ownerLists([[1, 2, 3]]));
  expect(fits.outcome).toBeUndefined();
  expect(fits.sent).toHaveLength(1);

  const grouping = largestOwnerLists(8, 60, 4);
  const over = await sendAtBound(grouping);
  expect(over.sent).toHaveLength(0);
  expect(over.outcome).toBeInstanceOf(InternalConsistencyError);
  expect(over.outcome).not.toBeInstanceOf(ConnectionError);
  expect((over.outcome as Error).message).toMatch(
    new RegExp(`list of \\d+ bytes is over the ${WEBRTC_BOUND} bytes`),
  );
});

test("a grouping of one-entry parts is refused once their bytes pass the frame bound", async () => {
  // Owner-list bounds at a partner record count no frame bound reaches, so
  // the frame bound is the budget, and a valid one-entry part of 28 bytes for
  // each of the 1,000 positions declared.
  const bound = 64;
  const positions = 1_000;
  const largest = {
    maxPositionsPerRecord: 1,
    partnerRecordCount: 10 ** 12,
    ownerLists: true,
  };
  expect(
    roundGroupingBound(positions, largest, bound).listBytes?.(positions),
  ).toBe(bound);
  const frames = Array.from({ length: positions }, (_, index) =>
    partFrame(
      [1],
      { index, count: positions, entries: positions },
      RUN_LENGTHS_LAYOUT,
    ),
  );
  const conn = await deliverStating(frames, bound);
  let readBytes = 0;
  const counting: MessageConnection = {
    ...conn,
    receive: async (timeoutMs?: number) => {
      const frame = await conn.receive(timeoutMs);
      readBytes += (frame as Uint8Array).byteLength;
      return frame;
    },
  };
  expect(
    (
      await refusal(
        receiveRoundGrouping(
          counting,
          "server",
          "grouping",
          positions,
          largest,
        ),
      )
    ).message,
  ).toMatch(/part 2 is over the 8 bytes this party admits/);
  expect(readBytes).toBe(3 * 28);
  expect(readBytes).toBeLessThanOrEqual(bound + 28);
});

test("parts totalling the derived budget are accepted and a word over it refused", async () => {
  // Two runs in two parts take a word each and 24 bytes for each part: 56
  // bytes in all, each part counted with its header.
  const bounds = {
    maxPositionsPerRecord: 1,
    partnerRecordCount: 2,
    ownerLists: false,
  };
  const exact = await deliver([
    partFrame([10], { index: 0, count: 2, entries: 2 }, RUN_LENGTHS_LAYOUT),
    partFrame([10], { index: 1, count: 2, entries: 2 }, RUN_LENGTHS_LAYOUT),
  ]);
  expect(
    plain(await receiveRoundGrouping(exact, "server", "grouping", 2, bounds)),
  ).toStrictEqual(runLengths([10, 10]));

  const over = await deliver([
    partFrame([10], { index: 0, count: 2, entries: 2 }, RUN_LENGTHS_LAYOUT),
    partFrame([10, 10], { index: 1, count: 2, entries: 2 }, RUN_LENGTHS_LAYOUT),
  ]);
  expect(
    (await refusal(receiveRoundGrouping(over, "server", "grouping", 2, bounds)))
      .message,
  ).toMatch(/part 1 is over the 28 bytes this party admits/);
});

test("a grouping of more runs than records is refused at its byte bound", async () => {
  // Two records' runs are at most two words, so three runs over 12 positions
  // are a part past the 32 bytes the round admits.
  const bounds = {
    maxPositionsPerRecord: 20,
    partnerRecordCount: 2,
    ownerLists: false,
  };
  const conn = await deliver([partFrame([1, 1, 1], {}, RUN_LENGTHS_LAYOUT)]);
  expect(
    (
      await refusal(
        receiveRoundGrouping(conn, "server", "grouping", 12, bounds),
      )
    ).message,
  ).toMatch(/part 0 is over the 32 bytes this party admits/);
});

test("an omitted-grouping part in a grouping that declares entries is refused", async () => {
  const conn = await deliver([partFrame(null, { entries: 2 })]);
  const err = await refusal(
    receiveRoundGrouping(conn, "server", "grouping", 10, WIDE_GROUPING),
  );
  expect(err.message).toMatch(/inbound grouping part 0 holds no entries/);
});

test("a grouping whose later part changes layout is refused", async () => {
  const conn = await deliver([
    partFrame([1], { index: 0, count: 2, entries: 2 }, RUN_LENGTHS_LAYOUT),
    partFrame([[1]], { index: 1, count: 2, entries: 2 }, OWNER_LISTS_LAYOUT),
  ]);
  expect(
    (
      await refusal(
        receiveRoundGrouping(conn, "server", "grouping", 10, WIDE_GROUPING),
      )
    ).message,
  ).toMatch(/inbound grouping part 1 is not a list of the kind awaited/);
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

test("a part over the bytes its remaining entries can take is refused before its body is read", async () => {
  // Two entries: a part of at most 16 + 8 + 2 * 4 bytes.
  const conn = await deliver([partFrame([0, 1, 2], { entries: 2 })]);
  const err = await refusal(receiveList(conn));
  expect(err.message).toMatch(/part 0 is over the 32 bytes this party admits/);
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
  const conn = await deliver([partFrame([1], {}, RUN_LENGTHS_LAYOUT)]);
  expect((await refusal(receiveList(conn))).message).toMatch(
    /inbound round index list part 0 is not a list of the kind awaited/,
  );
});
