import PSI from "@openmined/psi.js";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { EncryptedMessageConnection, generateSharedSecret } from "@alcove/core";
import {
  PSIParticipant,
  PSI_SET_PART_HEADER_BYTES,
  boundedInboundFramesWithBounds,
  decodeSinglePassReplyTail,
  encodeSinglePassReplyTail,
  linkViaSinglePassPSI,
  psiSetPartPayloadBytes,
  singlePassReplyParts,
} from "@alcove/core/testing";

import { openWebRtcMessageConnection } from "../../../src/connection/webrtc/webrtcMessageConnection";
import { startBrokerProcess } from "../../signaling/brokerProcess";
import { startRefusingStunServer } from "./refusingStunServer";

import type { MessageConnection } from "@alcove/core";
import type { BrokerProcess } from "../../signaling/brokerProcess";
import type { RefusingStunServer } from "./refusingStunServer";

/**
 * Single-pass messages 1 and 2 sent in parts between two CLI parties over
 * real werift peers (docs/spec/PROTOCOL.md, Single-pass messages in parts):
 * a whole exchange at a receive bound low enough that both messages take
 * several parts, and a reply past `MAX_WEBRTC_FRAME_BYTES` in total at the
 * shipped bound.
 */

const psiLibrary = await PSI();

const SESSION_KEY = new Uint8Array(32).fill(0x47) as Uint8Array<ArrayBuffer>;

let broker: BrokerProcess;
let stunServer: RefusingStunServer;
const openConnections: Array<MessageConnection> = [];

beforeAll(async () => {
  stunServer = await startRefusingStunServer();
  broker = await startBrokerProcess();
}, 60_000);

afterEach(async () => {
  for (const connection of openConnections.splice(0))
    await connection.close().catch(() => {
      // Already terminal: the run that owned it closed or failed it.
    });
}, 60_000);

afterAll(async () => {
  await broker?.stop();
  await stunServer?.stop();
});

/** Two encrypted connections over real werift peers, receiving at `frameBytes` where given. */
async function connectedPair(
  frameBytes?: number,
): Promise<[EncryptedMessageConnection, EncryptedMessageConnection]> {
  const common = {
    location: {
      host: "127.0.0.1",
      port: broker.port,
      path: broker.path,
      key: broker.key,
      secure: false,
    },
    sharedSecret: generateSharedSecret(),
    iceServers: stunServer.iceServers,
    rendezvousTimeoutMs: 60_000,
    channelOpenTimeoutMs: 30_000,
    closeFlushTimeoutMs: 5_000,
    ...(frameBytes === undefined
      ? {}
      : {
          inboundFrames: () =>
            boundedInboundFramesWithBounds({ maxFrameBytes: frameBytes }),
        }),
  };
  const [inviter, acceptor] = await Promise.all([
    openWebRtcMessageConnection({ ...common, role: "inviter" }),
    openWebRtcMessageConnection({ ...common, role: "acceptor" }),
  ]);
  openConnections.push(inviter, acceptor);
  return Promise.all([
    EncryptedMessageConnection.create(inviter, SESSION_KEY, "initiator"),
    EncryptedMessageConnection.create(acceptor, SESSION_KEY, "responder"),
  ]);
}

/** `conn`, counting the first parts it sends whose set takes several. */
function countingSplitSets(conn: EncryptedMessageConnection): {
  conn: MessageConnection;
  splitSets: () => number;
} {
  let splitSets = 0;
  return {
    splitSets: () => splitSets,
    conn: {
      send: (data) => {
        if (
          data instanceof Uint8Array &&
          data.byteLength >= PSI_SET_PART_HEADER_BYTES
        ) {
          const view = new DataView(data.buffer, data.byteOffset, 8);
          if (view.getUint32(0) === 0 && view.getUint32(4) > 1) splitSets += 1;
        }
        return conn.send(data);
      },
      receive: (timeoutMs) => conn.receive(timeoutMs),
      close: () => conn.close(),
      outboundWebRtcFrameBound: () => conn.outboundWebRtcFrameBound(),
      outboundFileSyncFrameBound: () => conn.outboundFileSyncFrameBound(),
      outboundFrameOverheadBytes: (frameBytes) =>
        conn.outboundFrameOverheadBytes(frameBytes),
    },
  };
}

const RECORDS = 600;
// Under the 249 matches the resolved table carries in one part at the
// lowered bound.
const SHARED = 200;

const keys = (prefix: string, count: number): Array<string> =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

const participant = (role: "starter" | "joiner", elements: number) =>
  new PSIParticipant(
    role === "starter" ? "server" : "client",
    psiLibrary,
    { role, verbose: -1 },
    { setup: elements, request: elements },
  );

test("a single-pass exchange sends both messages in parts at a lowered receive bound and matches whole", async () => {
  const [starterConn, joinerConn] = (await connectedPair(2_048)).map(
    countingSplitSets,
  );
  const starter = participant("starter", RECORDS);
  const joiner = participant("joiner", RECORDS);
  const bounds = {
    partnerRecordCount: RECORDS,
    keyWidths: [1],
    localFanOutFactor: 1,
  };
  // Records shared-0 to shared-199 are on both sides, at rows 400 to 599 of
  // the starter's file and rows 0 to 199 of the joiner's.
  const [starterTable, joinerTable] = await Promise.all([
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      starter,
      starterConn.conn,
      [[...keys("own", 400), ...keys("shared", SHARED)]],
      bounds,
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      joiner,
      joinerConn.conn,
      [[...keys("shared", SHARED), ...keys("other", 400)]],
      bounds,
      false,
      -1,
    ),
  ]);
  starter.dispose();
  joiner.dispose();

  const pairs = (table: [Array<number>, Array<number>], swap: boolean) =>
    table[0]
      .map((row, i) => (swap ? [table[1][i], row] : [row, table[1][i]]))
      .sort((a, b) => a[0] - b[0]);
  const expected = Array.from({ length: SHARED }, (_, i) => [i + 400, i]);
  expect(pairs(starterTable, false)).toStrictEqual(expected);
  expect(pairs(joinerTable, true)).toStrictEqual(expected);
  // The request; and the setup, the response and the tail of the reply.
  expect(joinerConn.splitSets()).toBeGreaterThanOrEqual(1);
  expect(starterConn.splitSets()).toBe(3);
}, 180_000);

// Past MAX_WEBRTC_FRAME_BYTES in total, so the reply takes two parts at the
// shipped bound.
const TABLE_WORDS = 70_000_000;

test("a single-pass reply past the frame bound in total crosses the shipped bound in parts", async () => {
  const [starterConn, joinerConn] = await connectedPair();
  const starter = participant("starter", 8);
  const joiner = participant("joiner", 8);
  const request = await joiner.createClientRequest(keys("v", 8));
  const { setup } = await starter.createServerSetup(keys("v", 4));
  const response = await starter.processClientRequest(request);
  const table = new Int32Array(TABLE_WORDS).fill(-1);
  table[TABLE_WORDS - 1] = 3;
  const tail = encodeSinglePassReplyTail(TABLE_WORDS, table);
  const replyBytes = 8 + setup.byteLength + response.byteLength + tail.length;
  expect(replyBytes).toBeGreaterThan(2 ** 28);

  const send = (async () => {
    for (const part of singlePassReplyParts(
      setup,
      response,
      tail,
      psiSetPartPayloadBytes(starterConn),
    ))
      await starterConn.send(part);
  })();
  const received = await joiner.receiveSinglePassReplyInParts(
    joinerConn,
    replyBytes,
    8,
  );
  await send;

  const decoded = decodeSinglePassReplyTail(received.tail);
  expect(decoded.numRecords).toBe(TABLE_WORDS);
  expect(decoded.distinctValueIndices).toHaveLength(TABLE_WORDS);
  expect(decoded.distinctValueIndices[TABLE_WORDS - 1]).toBe(3);
  expect(decoded.distinctValueIndices[0]).toBe(-1);
  const [matched] = await joiner.matchHeldServerSetup(received.response);
  expect(matched.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  starter.dispose();
  joiner.dispose();
}, 600_000);
