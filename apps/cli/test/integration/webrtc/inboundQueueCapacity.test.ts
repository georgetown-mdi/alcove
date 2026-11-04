import PSI from "@openmined/psi.js";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import {
  MAX_PSI_SET_WEBRTC_FRAMES,
  countOnlyRunAheadBytes,
} from "@alcove/core/testing";

import { startBrokerProcess } from "../../signaling/brokerProcess";
import { partRuns, runOverQueue } from "./inboundQueueHarness";
import { startRefusingStunServer } from "./refusingStunServer";

import type { MessageConnection } from "@alcove/core";
import type { BrokerProcess } from "../../signaling/brokerProcess";
import type { QueueRun } from "./inboundQueueHarness";
import type { RefusingStunServer } from "./refusingStunServer";

/**
 * The count-only crossing between two CLI parties over real werift peers, at
 * a receive bound low enough that each PSI set takes as many parts as the
 * largest set does at `MAX_WEBRTC_FRAME_BYTES`, against an inbound queue of
 * the byte capacity derived at that bound (docs/spec/TRANSPORT_BOUNDS.md, The
 * inbound queue).
 */

const psiLibrary = await PSI();

const FRAME_BYTES = 16_384;

// Each set, at 35 bytes an element, fills most of its three parts, so the
// crossing is over six frames at the bound.
const ROWS = 1_384;

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

// The inviter, the receiver of a count-only run, waits after each frame it
// sends, so the acceptor's response to round 1 and its round 2 setup and
// index table all arrive before the inviter reads the first of them.
const crossing = (queueByteCapacity: number): QueueRun => ({
  algorithm: "psi-c",
  rows: ROWS,
  twoKeys: true,
  payload: false,
  frameBytes: FRAME_BYTES,
  queueByteCapacity,
  inviterPacing: { afterSendMs: 1_500 },
});

test("the count-only crossing at a lowered receive bound fits the capacity derived at it", async () => {
  const outcome = await runOverQueue(
    crossing(countOnlyRunAheadBytes(MAX_PSI_SET_WEBRTC_FRAMES, FRAME_BYTES)),
    broker,
    stunServer,
    psiLibrary,
    openConnections,
  );

  for (const settled of [outcome.inviter, outcome.acceptor]) {
    expect(settled.status).toBe("fulfilled");
    if (settled.status === "fulfilled")
      expect(settled.value.intersectionCount).toBe((ROWS * 3) / 4);
  }
  // The inviter sends only its two rounds' requests and its empty payload,
  // and each request takes as many parts as the response and setup the
  // crossing carries.
  expect(partRuns(outcome.inviterSent)).toStrictEqual([
    MAX_PSI_SET_WEBRTC_FRAMES,
    MAX_PSI_SET_WEBRTC_FRAMES,
    1,
  ]);
}, 180_000);

test("the same crossing overflows a queue one frame smaller", async () => {
  const outcome = await runOverQueue(
    crossing(
      countOnlyRunAheadBytes(MAX_PSI_SET_WEBRTC_FRAMES, FRAME_BYTES) -
        FRAME_BYTES,
    ),
    broker,
    stunServer,
    psiLibrary,
    openConnections,
  );

  expect(outcome.inviter.status).toBe("rejected");
  if (outcome.inviter.status === "rejected")
    expect(String(outcome.inviter.reason)).toMatch(/inbound buffer overflow/);
}, 180_000);
