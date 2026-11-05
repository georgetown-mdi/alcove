import PSI from "@openmined/psi.js";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { startBrokerProcess } from "../../signaling/brokerProcess";
import { noteOf, rowOffset, runOverQueue } from "./inboundQueueHarness";
import { startRefusingStunServer } from "./refusingStunServer";

import type { ExchangeResult, MessageConnection } from "@alcove/core";
import type { BrokerProcess } from "../../signaling/brokerProcess";
import type { QueueRun } from "./inboundQueueHarness";
import type { RefusingStunServer } from "./refusingStunServer";

/**
 * A cascade with a payload between two CLI parties over real werift peers,
 * each receiving through an inbound queue smaller than the mapped-element
 * list and the payload rows the partner sends without waiting for a reply.
 * Each party reads those streams as they arrive (docs/spec/TRANSPORT_BOUNDS.md,
 * The inbound queue), so the exchange completes whole.
 */

const psiLibrary = await PSI();

const FRAME_BYTES = 8_192;
const ROWS = 4_000;

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

// Each party is slowed after every frame it receives, and slowed more after
// every frame it sends, so a reader that is reading keeps up with the frames
// arriving and only a frame no read is waiting for stays in the queue.
const pacing = { afterReceiveMs: 10, afterSendMs: 40 };

const run: QueueRun = {
  algorithm: "psi",
  rows: ROWS,
  twoKeys: false,
  payload: true,
  frameBytes: FRAME_BYTES,
  // About 36 KB of mapped-element list and 88 KB of payload rows cross at
  // these rows.
  queueByteCapacity: 4 * FRAME_BYTES,
  inviterPacing: pacing,
  acceptorPacing: pacing,
};

// This side's pairs, as (own row, partner row), in own-row order.
function pairs(result: ExchangeResult): Array<[number, number]> {
  const [own, partner] = result.associationTable ?? [[], []];
  return Array.from(own, (row, i): [number, number] => [row, partner[i]]).sort(
    (a, b) => a[0] - b[0],
  );
}

// The note value of each row of the partner's payload, by the partner's row.
function partnerNotes(result: ExchangeResult): Map<number, string | null> {
  const { columns, rowIndices, rows } = result.partnerPayload;
  const note = columns.indexOf("note");
  const notes = new Map<number, string | null>();
  for (let i = 0; i < rowIndices.length; i++) {
    const values: ReadonlyArray<string | null> =
      "row" in rows
        ? (
            rows as { row: (index: number) => ReadonlyArray<string | null> }
          ).row(i)
        : (rows as ReadonlyArray<ReadonlyArray<string | null>>)[i];
    notes.set(rowIndices[i], values[note]);
  }
  return notes;
}

test("a cascade's mapped-element list and payload rows cross a queue smaller than either", async () => {
  const outcome = await runOverQueue(
    run,
    broker,
    stunServer,
    psiLibrary,
    openConnections,
  );

  expect(outcome.inviter.status).toBe("fulfilled");
  expect(outcome.acceptor.status).toBe("fulfilled");
  if (
    outcome.inviter.status !== "fulfilled" ||
    outcome.acceptor.status !== "fulfilled"
  )
    return;
  const shift = rowOffset(run, "acceptor");
  const shared = (ROWS * 3) / 4;
  expect(pairs(outcome.inviter.value)).toStrictEqual(
    Array.from({ length: shared }, (_, k) => [k + shift, k]),
  );
  expect(pairs(outcome.acceptor.value)).toStrictEqual(
    Array.from({ length: shared }, (_, k) => [k, k + shift]),
  );
  // The acceptor's rows are numbered from 0 in its own file.
  expect(partnerNotes(outcome.inviter.value)).toStrictEqual(
    new Map(
      Array.from({ length: shared }, (_, k) => [
        k,
        noteOf("acceptor", k + shift),
      ]),
    ),
  );
  expect(partnerNotes(outcome.acceptor.value)).toStrictEqual(
    new Map(
      Array.from({ length: shared }, (_, k) => [
        k + shift,
        noteOf("inviter", k + shift),
      ]),
    ),
  );
}, 180_000);
