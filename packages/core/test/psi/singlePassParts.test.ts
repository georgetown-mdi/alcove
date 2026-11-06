import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
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
import { PartnerProtocolRefusalError } from "../../src/errors";
import {
  decodeSinglePassReply,
  decodeSinglePassReplyTail,
  encodeSinglePassReply,
  encodeSinglePassReplyTail,
  linkViaSinglePassPSI,
  singlePassMessageInParts,
  singlePassReplyParts,
  SINGLE_PASS_REPLY_LENGTH_FIELDS_BYTES,
} from "../../src/psi/link";
import {
  PSI_SET_PART_HEADER_BYTES,
  psiSetPartPayloadBytes,
  psiSetParts,
} from "../../src/psi/psiSetParts";
import type { AssociationTable } from "../../src/types";
import { fanOutFreeBounds } from "../utils/singlePassBounds";
import { makeParticipant } from "../utils/support";

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
