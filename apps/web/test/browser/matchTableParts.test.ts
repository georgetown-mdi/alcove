/// <reference types="@vitest/browser-playwright/context" />

import { expect, inject, test } from "vitest";

import { EncryptedMessageConnection, generateSharedSecret } from "@alcove/core";
import { PSIParticipant, linkViaPSI } from "@alcove/core/testing";
// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import { openPeerMessageConnection } from "../../src/psi/transport/peerMessageConnection.js";

import { canReachServer } from "../utils/pspiFixtures.js";
import { connectRendezvousPair } from "../utils/rendezvousPair.js";

import type { MessageConnection } from "@alcove/core";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

/**
 * A cascade's match table sent in parts between two browser parties over a
 * real PeerJS pair: each side's data channel states a receive bound low enough
 * that the round's association table and original-index list each take
 * several parts, so a table of a few hundred records crosses the channel the
 * way one past `MAX_WEBRTC_FRAME_BYTES` would (docs/spec/PROTOCOL.md, A list
 * of matched records is sent in parts).
 */

const addressInfo = {
  address: "127.0.0.1",
  port: inject("signalingBrokerPort") ?? 0,
};
const hostString = `http://${addressInfo.address}:${String(addressInfo.port)}`;
const serverUnreachableNote = `PeerJS coordination server at ${hostString} unreachable`;

/** Both sides' data-channel receive bound: about a hundred positions a part. */
const TEST_FRAME_BYTES = 512;

const RECORDS = 600;
const SHARED = 400;

const SESSION_KEY = new Uint8Array(32).fill(0x24);

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

const keys = (prefix: string): Array<string> =>
  Array.from({ length: RECORDS }, (_, i) => `${prefix}-${i}`);

test("two browser parties read one match table sent in several parts", async (ctx) => {
  if (!(await canReachServer(hostString)))
    return ctx.skip(serverUnreachableNote);

  const { inviterPeer, acceptorPeer, inviterConn, acceptorConn } =
    await connectRendezvousPair(generateSharedSecret(), addressInfo);
  const opened: Array<MessageConnection> = [];
  try {
    const [inviter, acceptor] = await Promise.all([
      openPeerMessageConnection(inviterConn, {
        maxFrameBytes: TEST_FRAME_BYTES,
      }),
      openPeerMessageConnection(acceptorConn, {
        maxFrameBytes: TEST_FRAME_BYTES,
      }),
    ]);
    opened.push(inviter, acceptor);
    const [starterConn, joinerConn] = (
      await Promise.all([
        EncryptedMessageConnection.create(inviter, SESSION_KEY, "responder"),
        EncryptedMessageConnection.create(acceptor, SESSION_KEY, "initiator"),
      ])
    ).map(recording);

    const psiLibrary = await (PSI() as Promise<PSILibrary>);
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
        [[...keys("own").slice(0, 200), ...keys("shared").slice(0, 400)]],
        bounds,
        -1,
      ),
      linkViaPSI(
        { cardinality: "one-to-one" },
        joiner,
        joinerConn.conn,
        [[...keys("shared").slice(0, 400), ...keys("other").slice(0, 200)]],
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
  } finally {
    for (const connection of opened)
      await connection.close().catch(() => {
        // Already terminal: the run that owned it closed or failed it.
      });
    inviterPeer.disconnect();
    acceptorPeer.disconnect();
  }
}, 120_000);
