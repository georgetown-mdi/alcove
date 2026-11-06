import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  MAX_PSI_SET_WEBRTC_FRAMES,
  countOnlyRunAheadBytes,
  createMessagePipe,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import {
  binaryPackByteStringLength,
  webrtcFrameExceedsBound,
} from "../../src/connection/webrtcOutboundBound";
import {
  singlePassReplyByteCap,
  singlePassRequestByteCap,
} from "../../src/connection/frameSize";
import { ConnectionError, PartnerProtocolRefusalError } from "../../src/errors";
import {
  decodeSinglePassReply,
  decodeSinglePassReplyTail,
  encodeSinglePassReply,
  encodeSinglePassReplyTail,
  linkViaSinglePassPSI,
  singlePassMessageInParts,
  singlePassReplyParts,
  singlePassReplyQueueBytes,
  SINGLE_PASS_REPLY_LENGTH_FIELDS_BYTES,
} from "../../src/psi/link";
import {
  PSI_SET_PART_HEADER_BYTES,
  psiSetPartPayloadBytes,
  psiSetParts,
} from "../../src/psi/psiSetParts";
import { runExchange } from "../../src/exchange";
import type { Output } from "../../src/config/linkageTermsSchema";
import type { AssociationTable } from "../../src/types";
import { fanOutFreeBounds } from "../utils/singlePassBounds";
import { distinctFirstName, makeParticipant, prepared } from "../utils/support";

const psiLibrary = await PSI();

// A per-frame bound low enough that a few dozen values send both single-pass
// messages in parts, so no multi-gigabyte run is needed.
const LOWERED_FRAME_BOUND = 300;

interface Capture {
  readonly sent: Array<unknown>;
}

// `conn` stating `frameBound` as its partner's WebRTC frame bound, recording
// every frame it sends.
function capturing(
  conn: MessageConnection,
  frameBound: number | undefined,
  capture: Capture,
): MessageConnection {
  return {
    send: (frame: unknown) => {
      capture.sent.push(frame);
      return conn.send(frame);
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
    ...(frameBound === undefined
      ? {}
      : { outboundWebRtcFrameBound: () => frameBound }),
  };
}

const senderSet = Array.from({ length: 40 }, (_, i) => `v${i}`);
const receiverSet = Array.from({ length: 30 }, (_, i) => `v${2 * i}`);

async function runSinglePass(frameBound: number | undefined): Promise<{
  senderResult: AssociationTable;
  receiverResult: AssociationTable;
  senderSent: Array<unknown>;
  receiverSent: Array<unknown>;
}> {
  const [a, b] = createMessagePipe();
  const senderCapture: Capture = { sent: [] };
  const receiverCapture: Capture = { sent: [] };
  const [senderResult, receiverResult] = await Promise.all([
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      makeParticipant(psiLibrary, "starter"),
      capturing(a, frameBound, senderCapture),
      [senderSet],
      fanOutFreeBounds(1, receiverSet.length),
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      makeParticipant(psiLibrary, "joiner"),
      capturing(b, frameBound, receiverCapture),
      [receiverSet],
      fanOutFreeBounds(1, senderSet.length),
      false,
      -1,
    ),
  ]);
  return {
    senderResult,
    receiverResult,
    senderSent: senderCapture.sent,
    receiverSent: receiverCapture.sent,
  };
}

function header(part: Uint8Array): {
  index: number;
  count: number;
  setBytes: number;
} {
  const view = new DataView(part.buffer, part.byteOffset, part.byteLength);
  return {
    index: view.getUint32(0),
    count: view.getUint32(4),
    setBytes: Number(view.getBigUint64(8)),
  };
}

// The first `setCount` sets the frames send in parts, in order, joined. The
// frames after them belong to a later message.
function joinedSets(
  frames: Array<Uint8Array>,
  setCount: number,
): Array<Uint8Array> {
  const sets: Array<Uint8Array> = [];
  let at = 0;
  while (sets.length < setCount) {
    const { count, setBytes } = header(frames[at]);
    const set = new Uint8Array(setBytes);
    let filled = 0;
    for (let i = 0; i < count; i++) {
      const payload = frames[at + i].subarray(PSI_SET_PART_HEADER_BYTES);
      set.set(payload, filled);
      filled += payload.byteLength;
    }
    sets.push(set);
    at += count;
  }
  return sets;
}

test("both single-pass messages travel in parts within a lowered frame bound and match as one frame does", async () => {
  const whole = await runSinglePass(undefined);
  const parts = await runSinglePass(LOWERED_FRAME_BOUND);

  expect(parts.senderResult).toEqual(whole.senderResult);
  expect(parts.receiverResult).toEqual(whole.receiverResult);
  expect(whole.receiverResult[0].length).toBe(20);

  // One frame each way, as a run within the bound sends them.
  const [wholeRequest] = whole.receiverSent as Array<Uint8Array>;
  const [wholeReply] = whole.senderSent as Array<Uint8Array>;
  expect(() => decodeSinglePassReply(wholeReply)).not.toThrow();

  // In parts: the request as one set, the reply as the setup, the response
  // and the tail, every frame within the bound.
  const requestFrames = parts.receiverSent.filter(
    (frame): frame is Uint8Array => frame instanceof Uint8Array,
  );
  const replyFrames = parts.senderSent.filter(
    (frame): frame is Uint8Array => frame instanceof Uint8Array,
  );
  for (const frame of [...requestFrames, ...replyFrames])
    expect(
      webrtcFrameExceedsBound(
        binaryPackByteStringLength(frame.byteLength),
        LOWERED_FRAME_BOUND,
      ),
    ).toBe(false);
  const [request] = joinedSets(requestFrames, 1);
  expect(header(requestFrames[0]).count).toBeGreaterThan(1);
  expect(request.byteLength).toBe(wholeRequest.byteLength);

  // Each run draws its own key, so the setup's order and with it the table's
  // words differ; the lengths do not.
  const [setup, response, tail] = joinedSets(replyFrames, 3);
  const decodedWhole = decodeSinglePassReply(wholeReply);
  expect(setup.byteLength).toBe(decodedWhole.setup.byteLength);
  expect(response.byteLength).toBe(decodedWhole.response.byteLength);
  const decodedTail = decodeSinglePassReplyTail(tail);
  expect(decodedTail.numRecords).toBe(decodedWhole.numRecords);
  expect(decodedTail.distinctValueIndices).toHaveLength(
    decodedWhole.distinctValueIndices.length,
  );
  expect(replyFrames.length).toBeGreaterThan(3);
});

test("a message travels in parts only when its derived cap passes the largest frame the bound admits", () => {
  const [conn] = createMessagePipe();
  const lowered = Object.assign(conn, {
    outboundWebRtcFrameBound: () => LOWERED_FRAME_BOUND,
  });
  const largest = psiSetPartPayloadBytes(lowered) + PSI_SET_PART_HEADER_BYTES;
  expect(singlePassMessageInParts(lowered, largest)).toBe(false);
  expect(singlePassMessageInParts(lowered, largest + 1)).toBe(true);
  // A file-sync connection keeps one frame, held to the message file instead.
  const fileSync = Object.assign(createMessagePipe()[0], {
    outboundWebRtcFrameBound: () => LOWERED_FRAME_BOUND,
    outboundFileSyncFrameBound: () => LOWERED_FRAME_BOUND,
  });
  expect(singlePassMessageInParts(fileSync, largest + 1)).toBe(false);
});

test("the reply's parts are the one frame's fields under the part header", () => {
  const setup = Uint8Array.from([1, 2, 3, 4, 5]);
  const response = Uint8Array.from([6, 7, 8]);
  const indices = [0, -1, 2];
  const tail = encodeSinglePassReplyTail(2, indices);
  const frames = [...singlePassReplyParts(setup, response, tail, 4)];
  expect(frames.map((f) => header(f))).toEqual([
    { index: 0, count: 2, setBytes: 5 },
    { index: 1, count: 2, setBytes: 5 },
    { index: 0, count: 1, setBytes: 3 },
    { index: 0, count: 4, setBytes: 16 },
    { index: 1, count: 4, setBytes: 16 },
    { index: 2, count: 4, setBytes: 16 },
    { index: 3, count: 4, setBytes: 16 },
  ]);
  const whole = encodeSinglePassReply(setup, response, 2, indices);
  expect(whole.subarray(4 + 5 + 4 + 3)).toEqual(tail);
  expect(whole.byteLength).toBe(
    SINGLE_PASS_REPLY_LENGTH_FIELDS_BYTES +
      setup.byteLength +
      response.byteLength +
      tail.byteLength,
  );
  expect(() => decodeSinglePassReplyTail(new Uint8Array(3))).toThrow(
    PartnerProtocolRefusalError,
  );
});

// A receiver run over a lowered bound whose partner is played by `reply`,
// handed the request this party sent.
async function receiverAgainst(
  reply: (conn: MessageConnection, request: Uint8Array) => Promise<void>,
): Promise<unknown> {
  const [a, b] = createMessagePipe();
  const lowered = Object.assign(b, {
    outboundWebRtcFrameBound: () => LOWERED_FRAME_BOUND,
  });
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    makeParticipant(psiLibrary, "joiner"),
    lowered,
    [receiverSet],
    fanOutFreeBounds(1, senderSet.length),
    false,
    -1,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  const requestFrames: Array<Uint8Array> = [];
  for (;;) {
    const part = (await a.receive()) as Uint8Array;
    requestFrames.push(part);
    const { index, count } = header(part);
    if (index === count - 1) break;
  }
  await reply(a, joinedSets(requestFrames, 1)[0]);
  return run;
}

const senderSize = { effectiveKeyCount: 1, recordCount: senderSet.length };
const receiverSize = { effectiveKeyCount: 1, recordCount: receiverSet.length };

// A conforming sender's setup and response to `request`.
async function conformingReply(
  request: Uint8Array,
): Promise<{ setup: Uint8Array; response: Uint8Array }> {
  const sender = makeParticipant(psiLibrary, "starter");
  const { setup } = await sender.createServerSetup(senderSet);
  return { setup, response: await sender.processClientRequest(request) };
}

async function sendAll(
  conn: MessageConnection,
  frames: Iterable<Uint8Array>,
): Promise<void> {
  for (const frame of frames) await conn.send(frame);
}

test("a reply whose setup declares more than the reply cap leaves is refused at its first part", async () => {
  const error = await receiverAgainst(async (conn, request) => {
    const cap = singlePassReplyByteCap(
      1,
      senderSize,
      receiverSize,
      request.byteLength,
    );
    const [first] = psiSetParts(new Uint8Array(cap), 200);
    await conn.send(first);
  });
  expect(error).toBeInstanceOf(PartnerProtocolRefusalError);
  expect(String(error)).toMatch(/inbound PSI serverSetup declares \d+ bytes/);
});

test("a reply whose response declares more than the request sent is refused at its first part", async () => {
  let requestBytes = 0;
  const error = await receiverAgainst(async (conn, request) => {
    requestBytes = request.byteLength;
    const { setup } = await conformingReply(request);
    await sendAll(conn, psiSetParts(setup, 200));
    await sendAll(conn, psiSetParts(new Uint8Array(requestBytes + 1), 200));
  });
  expect(error).toBeInstanceOf(PartnerProtocolRefusalError);
  expect(String(error)).toContain(
    `inbound PSI response declares ${requestBytes + 1} bytes, over the ` +
      `${requestBytes} bytes of the request this party sent`,
  );
});

test("a reply whose tail declares more than the reply cap leaves is refused at its first part", async () => {
  let left = 0;
  const error = await receiverAgainst(async (conn, request) => {
    const { setup, response } = await conformingReply(request);
    left =
      singlePassReplyByteCap(1, senderSize, receiverSize, request.byteLength) -
      SINGLE_PASS_REPLY_LENGTH_FIELDS_BYTES -
      setup.byteLength -
      response.byteLength;
    await sendAll(conn, psiSetParts(setup, 200));
    await sendAll(conn, psiSetParts(response, 200));
    await sendAll(conn, psiSetParts(new Uint8Array(left + 4), 200));
  });
  expect(error).toBeInstanceOf(PartnerProtocolRefusalError);
  expect(String(error)).toContain(
    `inbound PSI reply tail declares ${left + 4} bytes, over the ${left} ` +
      "bytes the single-pass reply cap leaves for it",
  );
});

test("a conforming reply in parts from a separate sender resolves", async () => {
  const error = await receiverAgainst(async (conn, request) => {
    const { setup, response } = await conformingReply(request);
    await sendAll(
      conn,
      singlePassReplyParts(
        setup,
        response,
        encodeSinglePassReplyTail(
          senderSet.length,
          Array.from({ length: senderSet.length }, () => -1),
        ),
        200,
      ),
    );
  });
  // The tail's table names no value, so the run matches nothing and sends back
  // an empty resolved table.
  expect(error).toBeUndefined();
});

// The queue byte bound the count-only crossing derives at the lowered bound.
const LOWERED_QUEUE_BYTES = countOnlyRunAheadBytes(
  MAX_PSI_SET_WEBRTC_FRAMES,
  LOWERED_FRAME_BOUND,
);

// A receiver run over a lowered bound and a queue held to
// LOWERED_QUEUE_BYTES, whose partner is played by `reply`. The receiver reads
// nothing until `reply` has sent every frame, so they all queue.
async function queuedReceiverAgainst(
  reply: (
    conn: MessageConnection,
    request: Uint8Array,
    receiver: MessageConnection,
  ) => Promise<void>,
): Promise<unknown> {
  const [a, b] = createMessagePipe({ byteCapacity: LOWERED_QUEUE_BYTES });
  let replySent!: () => void;
  const sent = new Promise<void>((resolve) => (replySent = resolve));
  const receiver: MessageConnection = {
    send: (frame: unknown) => b.send(frame),
    receive: async (timeoutMs?: number) => {
      await sent;
      return b.receive(timeoutMs);
    },
    close: () => b.close(),
    outboundWebRtcFrameBound: () => LOWERED_FRAME_BOUND,
    holdInboundQueueBytes: (bytes) => b.holdInboundQueueBytes?.(bytes),
  };
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    makeParticipant(psiLibrary, "joiner"),
    receiver,
    [receiverSet],
    fanOutFreeBounds(1, senderSet.length),
    false,
    -1,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  const requestFrames: Array<Uint8Array> = [];
  for (;;) {
    const part = (await a.receive()) as Uint8Array;
    requestFrames.push(part);
    const { index, count } = header(part);
    if (index === count - 1) break;
  }
  await reply(a, joinedSets(requestFrames, 1)[0], receiver);
  replySent();
  return run;
}

test("a reply in parts queued past the count-only bound behind a slow setup consumer completes", async () => {
  let queued = 0;
  const error = await queuedReceiverAgainst(async (conn, request) => {
    const { setup, response } = await conformingReply(request);
    for (const part of singlePassReplyParts(
      setup,
      response,
      encodeSinglePassReplyTail(
        senderSet.length,
        Array.from({ length: senderSet.length }, () => -1),
      ),
      psiSetPartPayloadBytes(
        Object.assign(createMessagePipe()[0], {
          outboundWebRtcFrameBound: () => LOWERED_FRAME_BOUND,
        }),
      ),
    )) {
      queued += part.byteLength;
      await conn.send(part);
    }
  });
  expect(queued).toBeGreaterThan(LOWERED_QUEUE_BYTES);
  expect(error).toBeUndefined();
});

test("a partner sending past the raised queue bound is still refused", async () => {
  let raised = 0;
  const error = await queuedReceiverAgainst(async (conn, request, receiver) => {
    raised = singlePassReplyQueueBytes(
      receiver,
      singlePassReplyByteCap(1, senderSize, receiverSize, request.byteLength),
    );
    const { setup, response } = await conformingReply(request);
    const frames = [
      ...singlePassReplyParts(
        setup,
        response,
        encodeSinglePassReplyTail(
          senderSet.length,
          Array.from({ length: senderSet.length }, () => -1),
        ),
        psiSetPartPayloadBytes(receiver),
      ),
    ];
    let queued = 0;
    for (const frame of frames) {
      queued += frame.byteLength;
      await conn.send(frame);
    }
    while (queued <= raised) {
      queued += LOWERED_FRAME_BOUND;
      await conn.send(new Uint8Array(LOWERED_FRAME_BOUND));
    }
  });
  expect(raised).toBeGreaterThan(LOWERED_QUEUE_BYTES);
  expect(error).toBeInstanceOf(ConnectionError);
  expect(String(error)).toContain(
    `inbound buffer overflow: over the ${raised}-byte bound`,
  );
});

test("the receiver raises its queue bound only after the request's last part is sent", async () => {
  const events: Array<string> = [];
  const [a, b] = createMessagePipe({ byteCapacity: LOWERED_QUEUE_BYTES });
  const receiver: MessageConnection = {
    send: (frame: unknown) => {
      events.push("send");
      return b.send(frame);
    },
    receive: (timeoutMs?: number) => b.receive(timeoutMs),
    close: () => b.close(),
    outboundWebRtcFrameBound: () => LOWERED_FRAME_BOUND,
    holdInboundQueueBytes: (bytes) => {
      events.push(bytes === undefined ? "restore" : `raise ${bytes}`);
      b.holdInboundQueueBytes?.(bytes);
    },
  };
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    makeParticipant(psiLibrary, "joiner"),
    receiver,
    [receiverSet],
    fanOutFreeBounds(1, senderSet.length),
    false,
    -1,
  );
  const requestFrames: Array<Uint8Array> = [];
  for (;;) {
    const part = (await a.receive()) as Uint8Array;
    requestFrames.push(part);
    const { index, count } = header(part);
    if (index === count - 1) break;
  }
  const request = joinedSets(requestFrames, 1)[0];
  const { setup, response } = await conformingReply(request);
  await sendAll(
    a,
    singlePassReplyParts(
      setup,
      response,
      encodeSinglePassReplyTail(
        senderSet.length,
        Array.from({ length: senderSet.length }, () => -1),
      ),
      psiSetPartPayloadBytes(receiver),
    ),
  );
  await run;

  const raised = singlePassReplyQueueBytes(
    receiver,
    singlePassReplyByteCap(1, senderSize, receiverSize, request.byteLength),
  );
  expect(requestFrames.length).toBeGreaterThan(1);
  expect(raised).toBeGreaterThan(LOWERED_QUEUE_BYTES);
  expect(events.slice(0, requestFrames.length + 2)).toStrictEqual([
    ...requestFrames.map(() => "send"),
    `raise ${raised}`,
    "restore",
  ]);
});

test("a partner keeping frames queued past the built bound through the reply is refused when the bound is restored", async () => {
  const JUNK_BYTES = LOWERED_FRAME_BOUND;
  const [a, b] = createMessagePipe({ byteCapacity: LOWERED_QUEUE_BYTES });
  let replySent!: () => void;
  const sent = new Promise<void>((resolve) => (replySent = resolve));
  let raised = 0;
  let queued = 0;
  let mostQueuedAtRestore = 0;
  const receiver: MessageConnection = {
    send: (frame: unknown) => b.send(frame),
    // Before each read the partner tops the queue up to the raised bound with
    // frames behind the reply.
    receive: async (timeoutMs?: number) => {
      await sent;
      while (raised > 0 && queued + JUNK_BYTES <= raised) {
        queued += JUNK_BYTES;
        await a.send(new Uint8Array(JUNK_BYTES));
      }
      const frame = (await b.receive(timeoutMs)) as Uint8Array;
      queued -= frame.byteLength;
      return frame;
    },
    close: () => b.close(),
    outboundWebRtcFrameBound: () => LOWERED_FRAME_BOUND,
    holdInboundQueueBytes: (bytes) => {
      if (bytes === undefined) mostQueuedAtRestore = queued;
      else raised = bytes;
      b.holdInboundQueueBytes?.(bytes);
    },
  };
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    makeParticipant(psiLibrary, "joiner"),
    receiver,
    [receiverSet],
    fanOutFreeBounds(1, senderSet.length),
    false,
    -1,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  const requestFrames: Array<Uint8Array> = [];
  for (;;) {
    const part = (await a.receive()) as Uint8Array;
    requestFrames.push(part);
    const { index, count } = header(part);
    if (index === count - 1) break;
  }
  const { setup, response } = await conformingReply(
    joinedSets(requestFrames, 1)[0],
  );
  for (const part of singlePassReplyParts(
    setup,
    response,
    encodeSinglePassReplyTail(
      senderSet.length,
      Array.from({ length: senderSet.length }, () => -1),
    ),
    psiSetPartPayloadBytes(receiver),
  )) {
    queued += part.byteLength;
    await a.send(part);
  }
  replySent();
  const error = await run;

  expect(mostQueuedAtRestore).toBeGreaterThan(LOWERED_QUEUE_BYTES);
  expect(error).toBeInstanceOf(ConnectionError);
  expect((error as ConnectionError).kind).toBe("protocol");
  expect(String(error)).toContain(
    `inbound buffer overflow: over the ${LOWERED_QUEUE_BYTES}-byte bound`,
  );
});

// One first-name row per name, prepared as `identity` for a single-pass run.
function singlePassRows(
  identity: string,
  names: Array<string>,
  output: Output,
): ReturnType<typeof prepared> {
  return prepared(
    identity,
    names.map((first_name) => ({ first_name })),
    { terms: { linkageStrategy: "single-pass", output } },
  );
}

// `conn` stating the lowered frame bound, recording each queue bound it holds.
function loweredRecordingHolds(
  conn: MessageConnection,
  holds: Array<number | undefined>,
): MessageConnection {
  const hold = conn.holdInboundQueueBytes?.bind(conn);
  return Object.assign(conn, {
    outboundWebRtcFrameBound: () => LOWERED_FRAME_BOUND,
    holdInboundQueueBytes: (bytes: number | undefined) => {
      holds.push(bytes);
      hold?.(bytes);
    },
  });
}

const sharedNames = Array.from({ length: 20 }, (_, i) => distinctFirstName(i));
const receiverNames = [
  ...sharedNames,
  ...Array.from({ length: 10 }, (_, i) => distinctFirstName(100 + i)),
];
const senderNames = [
  ...sharedNames,
  ...Array.from({ length: 20 }, (_, i) => distinctFirstName(200 + i)),
];
const bothOutput: Output = { expectsOutput: true, shareWithPartner: true };

test.each([
  ["the initiator", "is sent its table", true, false],
  ["the responder", "is sent its table", false, false],
  ["the initiator", "is sent no table", true, true],
  ["the responder", "is sent no table", false, true],
])(
  "a conforming exchange in parts whose reply receiver is %s and whose sender %s completes on a queue at the count-only bound",
  async (_receiver, _table, receiverIsInitiator, withheld) => {
    const [a, b] = createMessagePipe({ byteCapacity: LOWERED_QUEUE_BYTES });
    const holds: Array<number | undefined> = [];
    const receiverOutput: Output = withheld
      ? { expectsOutput: true, shareWithPartner: false }
      : bothOutput;
    const senderOutput: Output = withheld
      ? { expectsOutput: false, shareWithPartner: true }
      : bothOutput;
    const receiverParty = singlePassRows(
      receiverIsInitiator ? "Initiator Co" : "Responder Co",
      receiverNames,
      receiverOutput,
    );
    const senderParty = singlePassRows(
      receiverIsInitiator ? "Responder Co" : "Initiator Co",
      senderNames,
      senderOutput,
    );
    const [initiator, responder] = await Promise.all([
      runExchange(
        loweredRecordingHolds(a, holds),
        "initiator",
        receiverIsInitiator ? receiverParty : senderParty,
        { psiLibrary },
      ),
      runExchange(
        loweredRecordingHolds(b, holds),
        "responder",
        receiverIsInitiator ? senderParty : receiverParty,
        { psiLibrary },
      ),
    ]);
    const [receiverResult, senderResult] = receiverIsInitiator
      ? [initiator, responder]
      : [responder, initiator];
    expect(holds[0]).toBeGreaterThan(LOWERED_QUEUE_BYTES);
    expect(holds.slice(1)).toStrictEqual([undefined]);
    expect(receiverResult.associationTable?.[0]).toHaveLength(20);
    expect(senderResult.associationTable?.[0].length).toBe(
      withheld ? undefined : 20,
    );
  },
);

test("a request in parts declaring more than its derived cap is refused at its first part", async () => {
  const [a, b] = createMessagePipe();
  const lowered = Object.assign(a, {
    outboundWebRtcFrameBound: () => LOWERED_FRAME_BOUND,
  });
  const requestCap = singlePassRequestByteCap(receiverSize);
  const [first] = psiSetParts(new Uint8Array(requestCap + 1), 200);
  await b.send(first);
  const error = await linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    makeParticipant(psiLibrary, "starter"),
    lowered,
    [senderSet],
    fanOutFreeBounds(1, receiverSet.length),
    false,
    -1,
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PartnerProtocolRefusalError);
  expect(String(error)).toContain(
    `inbound PSI request declares ${requestCap + 1} bytes, over the ${requestCap}`,
  );
});
