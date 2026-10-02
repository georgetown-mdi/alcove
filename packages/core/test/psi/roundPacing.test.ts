import { afterEach, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import {
  connectionEndReader,
  createMessagePipe,
} from "../../src/connection/messageConnection";
import {
  buildRoundSet,
  groupDuplicatesAndRemoveUndefineds,
  linkViaPSI,
  removeDuplicatesAndUndefineds,
} from "../../src/psi/link";
import { PSIParticipant } from "../../src/psi/participant";
import {
  resolveRoundCandidatePairs,
  roundCandidatePairSweep,
} from "../../src/psi/roundResolution";
import {
  EVENT_LOOP_HOLD_MS,
  EventLoopPacer,
  PACED_STRETCH_RECORDS,
  runPaced,
  runUnpaced,
} from "../../src/utils/eventLoop";
import { sortAssociationTable } from "../../src/testing";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";
import { fanOutFreeBounds } from "../utils/singlePassBounds";

import type { KeyCandidates } from "../../src/standardization";

// A cascade round is built and resolved on an open connection, on the thread
// whose event loop answers the transport's liveness checks. These hold the
// round's passes over records to yielding as they go, and to the results the
// unpaced forms give.

afterEach(() => {
  vi.restoreAllMocks();
});

// Every reading of the clock is a full hold later than the one before, so a
// pacer is due each time it is asked.
function everyPacerReadingIsDue(): void {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(
    () => (now += EVENT_LOOP_HOLD_MS),
  );
}

const read = (value: KeyCandidates): KeyCandidates => value;

const ROWS: Array<KeyCandidates> = [
  "a",
  undefined,
  "b",
  new Set(["c", "a"]),
  "",
  "b",
  new Set(["d", "d2"]),
  "e",
];

test.each([
  { permutation: undefined },
  { permutation: [3, 5, 8, 13, 21, 34, 55, 89] },
])(
  "a round's set built in paced stretches is the unpaced set (permutation $permutation)",
  async ({ permutation }) => {
    const dropped = await buildRoundSet(ROWS, read, false, permutation);
    const [values, rows] = removeDuplicatesAndUndefineds(ROWS, permutation);
    expect(dropped).toStrictEqual({ set: [values, { rows }], rowCount: 8 });

    const kept = await buildRoundSet(ROWS, read, true, permutation);
    expect(kept).toStrictEqual({
      set: groupDuplicatesAndRemoveUndefineds(ROWS, permutation),
      rowCount: 8,
    });
  },
);

test("the event loop runs while a round's set is built", async () => {
  const stretches = 3;
  let turns = 0;
  const timer = setInterval(() => ++turns, 0);
  const turnsAtStretch: Array<number> = [];
  function* rows(): Generator<KeyCandidates> {
    for (let i = 0; i < stretches * PACED_STRETCH_RECORDS; ++i) {
      if (i % PACED_STRETCH_RECORDS === 0) {
        turnsAtStretch.push(turns);
        const until = performance.now() + EVENT_LOOP_HOLD_MS;
        while (performance.now() < until);
      }
      yield `value ${i}`;
    }
  }
  try {
    const { rowCount } = await buildRoundSet(rows(), read, false);
    expect(rowCount).toBe(stretches * PACED_STRETCH_RECORDS);
  } finally {
    clearInterval(timer);
  }
  expect(turnsAtStretch).toHaveLength(stretches);
  for (let s = 1; s < stretches; ++s)
    expect(turnsAtStretch[s]).toBeGreaterThan(turnsAtStretch[s - 1]);
});

test("a pacer yields only once its hold has passed", async () => {
  let turns = 0;
  const timer = setInterval(() => ++turns, 0);
  try {
    const pacer = new EventLoopPacer();
    await pacer.yieldWhenDue();
    expect(turns).toBe(0);
    const until = performance.now() + EVENT_LOOP_HOLD_MS;
    while (performance.now() < until);
    await pacer.yieldWhenDue();
    expect(turns).toBeGreaterThan(0);
  } finally {
    clearInterval(timer);
  }
});

test("the paced sweep resolves a round as the unpaced sweep does", async () => {
  const pairs = 3 * PACED_STRETCH_RECORDS + 7;
  const senderRanks = Array.from({ length: pairs }, (_, i) => i >> 1);
  const receiverRanks = Array.from({ length: pairs }, (_, i) => (i * 7) % 911);
  const acceptance = { senderAcceptsOnce: true, receiverAcceptsOnce: true };
  everyPacerReadingIsDue();
  const yieldWhenDue = vi.spyOn(EventLoopPacer.prototype, "yieldWhenDue");
  const paced = await runPaced(
    roundCandidatePairSweep(senderRanks, receiverRanks, acceptance),
    new EventLoopPacer(),
  );
  expect(yieldWhenDue).toHaveBeenCalledTimes(3);
  expect(paced).toStrictEqual(
    resolveRoundCandidatePairs(senderRanks, receiverRanks, acceptance),
  );
  expect(
    runUnpaced(roundCandidatePairSweep(senderRanks, receiverRanks, acceptance)),
  ).toStrictEqual(paced);
});

test(
  "every pass of a cascade round over its records yields as it goes",
  {
    timeout: 60_000,
  },
  async () => {
    const psiLibrary = await PSI();
    const stretches = 2;
    const rows = stretches * PACED_STRETCH_RECORDS;
    const values = [Array.from({ length: rows }, (_, i) => `value ${i}`)];
    const [starterConn, joinerConn] = createMessagePipe();
    const participant = (role: "starter" | "joiner"): PSIParticipant =>
      new PSIParticipant(
        role,
        psiLibrary,
        { role, verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
      );
    const yieldWhenDue = vi.spyOn(EventLoopPacer.prototype, "yieldWhenDue");

    const [starter, joiner] = await Promise.all([
      linkViaPSI(
        { cardinality: "one-to-one" },
        participant("starter"),
        starterConn,
        values,
        fanOutFreeBounds(1, rows),
        -1,
      ),
      linkViaPSI(
        { cardinality: "one-to-one" },
        participant("joiner"),
        joinerConn,
        values,
        fanOutFreeBounds(1, rows),
        -1,
      ),
    ]);

    const identity = Array.from({ length: rows }, (_, i) => i);
    expect(sortAssociationTable(starter)).toStrictEqual([identity, identity]);
    expect(sortAssociationTable(joiner, true)).toStrictEqual([
      identity,
      identity,
    ]);
    // Each party's round asks its pacer once a stretch in each of eleven passes
    // over the round's records: the set build, the candidate-pair pass, the
    // sweep, both loops of each of the two position-set derivations, and the
    // four passes that record the accepted pairs.
    const passes = 11;
    expect(yieldWhenDue.mock.calls.length).toBeGreaterThanOrEqual(
      2 * passes * stretches,
    );
  },
);

test("a pacer throws what it stops on, at its next yield and not before", async () => {
  const stop = new Error("the connection ended");
  let stopReason: Error | undefined = undefined;
  everyPacerReadingIsDue();
  const pacer = new EventLoopPacer(() => stopReason);
  await pacer.yieldWhenDue();
  stopReason = stop;
  await expect(pacer.yieldWhenDue()).rejects.toBe(stop);
});

test("a round's set build stops within a stretch once its connection has ended", async () => {
  everyPacerReadingIsDue();
  const [conn, peer] = createMessagePipe();
  let rowsRead = 0;
  function* rows(): Generator<KeyCandidates> {
    for (let i = 0; i < 10 * PACED_STRETCH_RECORDS; ++i) {
      ++rowsRead;
      if (i === PACED_STRETCH_RECORDS) void peer.close();
      yield `value ${i}`;
    }
  }
  const build = buildRoundSet(
    rows(),
    read,
    false,
    undefined,
    new EventLoopPacer(connectionEndReader(conn)),
  );
  await expect(build).rejects.toMatchObject({ kind: "transport" });
  expect(rowsRead).toBeLessThanOrEqual(3 * PACED_STRETCH_RECORDS);
});
