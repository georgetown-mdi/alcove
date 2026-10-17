import PSI from "@openmined/psi.js";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { EncryptedMessageConnection, generateSharedSecret } from "@alcove/core";
import {
  PSIParticipant,
  boundedInboundFramesWithBounds,
  linkViaPSI,
} from "@alcove/core/testing";

import { openWebRtcMessageConnection } from "../../../src/connection/webrtc/webrtcMessageConnection";
import { startBrokerProcess } from "../../signaling/brokerProcess";
import { startRefusingStunServer } from "./refusingStunServer";

import type { MessageConnection } from "@alcove/core";
import type { BrokerProcess } from "../../signaling/brokerProcess";
import type { RefusingStunServer } from "./refusingStunServer";

/**
 * A cascade's match table sent in parts between two CLI parties over real
 * werift peers: each side's data channel states a receive bound low enough
 * that the round's association table and original-index list each take
 * several parts, so a table of a few hundred records crosses the channel the
 * way one past `MAX_WEBRTC_FRAME_BYTES` would (docs/spec/PROTOCOL.md, A list
 * of matched records is sent in parts).
 */

const psiLibrary = await PSI();

/** Both sides' data-channel receive bound: about a hundred positions a part. */
const TEST_FRAME_BYTES = 512;

const RECORDS = 600;
const SHARED = 400;

const SESSION_KEY = new Uint8Array(32).fill(0x24) as Uint8Array<ArrayBuffer>;

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

/** `conn`, recording every frame sent through it above the envelope. */
function recording(conn: EncryptedMessageConnection): {
  conn: MessageConnection;
  sent: Array<unknown>;
} {
  const sent: Array<unknown> = [];
  return {
    sent,
    conn: {
      send: (data) => {
        sent.push(data);
        return conn.send(data);
      },
      receive: (timeoutMs) => conn.receive(timeoutMs),
      close: () => conn.close(),
      outboundWebRtcFrameBound: () => conn.outboundWebRtcFrameBound(),
      outboundFileSyncFrameBound: () => conn.outboundFileSyncFrameBound(),
      outboundFrameOverheadBytes: () => conn.outboundFrameOverheadBytes(),
    },
  };
}

/**
 * The header of each first part of a list of positions alone among `sent`:
 * a matched-record list part whose JSON body is an array of numbers.
 */
function indexListHeaders(
  sent: Array<unknown>,
): Array<{ count: number; entries: number }> {
  const headers: Array<{ count: number; entries: number }> = [];
  for (const frame of sent) {
    if (!(frame instanceof Uint8Array) || frame.byteLength <= 16) continue;
    const view = new DataView(frame.buffer, frame.byteOffset, 16);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(frame.subarray(16)));
    } catch {
      continue;
    }
    if (
      view.getUint32(0) === 0 &&
      Array.isArray(body) &&
      body.length > 0 &&
      body.every((entry) => typeof entry === "number")
    )
      headers.push({
        count: view.getUint32(4),
        entries: Number(view.getBigUint64(8)),
      });
  }
  return headers;
}

const keys = (prefix: string, from: number): Array<string> =>
  Array.from({ length: RECORDS }, (_, i) => `${prefix}-${from + i}`);

test("a cascade's match table crosses the data channel in several parts and matches whole", async () => {
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
    inboundFrames: () =>
      boundedInboundFramesWithBounds({ maxFrameBytes: TEST_FRAME_BYTES }),
  };
  const [inviter, acceptor] = await Promise.all([
    openWebRtcMessageConnection({ ...common, role: "inviter" }),
    openWebRtcMessageConnection({ ...common, role: "acceptor" }),
  ]);
  openConnections.push(inviter, acceptor);
  const [starterConn, joinerConn] = (
    await Promise.all([
      EncryptedMessageConnection.create(inviter, SESSION_KEY, "initiator"),
      EncryptedMessageConnection.create(acceptor, SESSION_KEY, "responder"),
    ])
  ).map(recording);

  const party = (role: "starter" | "joiner") =>
    new PSIParticipant(
      role === "starter" ? "server" : "client",
      psiLibrary,
      { role, verbose: -1 },
      { setup: RECORDS, request: RECORDS },
    );
  const starter = party("starter");
  const joiner = party("joiner");
  const bounds = { partnerRecordCount: RECORDS, keyWidths: [1] };
  // Records shared-0 to shared-399 are on both sides, at rows 200 to 599 of
  // the starter's file and rows 0 to 399 of the joiner's.
  const [starterTable, joinerTable] = await Promise.all([
    linkViaPSI(
      { cardinality: "one-to-one" },
      starter,
      starterConn.conn,
      [[...keys("own", 0).slice(0, 200), ...keys("shared", 0).slice(0, 400)]],
      bounds,
      -1,
    ),
    linkViaPSI(
      { cardinality: "one-to-one" },
      joiner,
      joinerConn.conn,
      [[...keys("shared", 0).slice(0, 400), ...keys("other", 0).slice(0, 200)]],
      bounds,
      -1,
    ),
  ]);
  starter.dispose();
  joiner.dispose();

  const pairs = (table: [Array<number>, Array<number>], swap: boolean) =>
    table[0]
      .map((row, i) => (swap ? [table[1][i], row] : [row, table[1][i]]))
      .sort((a, b) => a[0] - b[0]);
  const expected = Array.from({ length: SHARED }, (_, i) => [i + 200, i]);
  expect(pairs(starterTable, false)).toStrictEqual(expected);
  expect(pairs(joinerTable, true)).toStrictEqual(expected);

  // The joiner's association table, as its two index lists, and the
  // starter's original-index list: every one of them in several parts.
  const joinerLists = indexListHeaders(joinerConn.sent);
  const starterLists = indexListHeaders(starterConn.sent);
  expect(joinerLists).toHaveLength(2);
  expect(starterLists).toHaveLength(1);
  for (const header of [...joinerLists, ...starterLists]) {
    expect(header.entries).toBe(SHARED);
    expect(header.count).toBeGreaterThan(2);
  }
}, 180_000);
