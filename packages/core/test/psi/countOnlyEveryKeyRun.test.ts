import { afterEach, describe, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import {
  createMessagePipe,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import { countDeclaredPsiElements } from "../../src/connection/psiElementScan";
import {
  InternalConsistencyError,
  PartnerProtocolRefusalError,
  PeerAbortError,
} from "../../src/errors";
import { HeldPermutation } from "../../src/psi/countOnlyPermutation";
import {
  CountOnlyDummies,
  countOnlyRoundElements,
  type CountOnlyDeclaredCounts,
} from "../../src/psi/countOnlyRounds";
import { linkViaCountOnlyPSI } from "../../src/psi/link";
import { PSIParticipant } from "../../src/psi/participant";
import { InProcessPsiEngine, type PsiEngine } from "../../src/psi/psiEngine";
import {
  servePsiWorker,
  WorkerPsiEngine,
  type PsiWorkerHandle,
  type PsiWorkerResponse,
} from "../../src/psi/psiWorkerEngine";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";
import { withEmptyUnknownField } from "../utils/paddedPsiRequest";
import {
  FIXTURE_COUNT,
  RECEIVER,
  SENDER,
  filler,
  randomRecords,
  referenceCount,
  roundsOf,
  type Records,
} from "../utils/countOnlyEveryKey";

// The count-only construction over every agreed key, run between two
// in-memory parties through linkViaCountOnlyPSI (docs/spec/PROTOCOL.md,
// PSI-C: The count-only rounds, Computing the count, Count reporting and
// entitlement).

const wasm = await PSI();
const native: PSILibrary | undefined = await loadNativeAddonOrSkip();
const backends: Array<[string, PSILibrary]> = [
  ["wasm", wasm],
  ...(native === undefined ? [] : [["native", native] as [string, PSILibrary]]),
];

afterEach(() => vi.restoreAllMocks());

type Tap = Partial<Record<keyof PsiEngine, (...args: Array<never>) => void>>;

// The engine with each tapped method's arguments handed to the tap first.
function tapped(engine: PsiEngine, tap: Tap): PsiEngine {
  return new Proxy(engine, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      const observe = tap[property as keyof PsiEngine] as
        ((...args: Array<unknown>) => void) | undefined;
      return (...args: Array<unknown>) => {
        observe?.(...args);
        return (member as (...a: Array<unknown>) => unknown).apply(
          target,
          args,
        );
      };
    },
  });
}

// A receiver running modified software: each request it builds holds one
// record fewer than it should, and an empty unknown field stands in for it,
// so a wire scan still counts the declared records.
function padding(engine: PsiEngine): PsiEngine {
  return new Proxy(engine, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      if (property !== "createClientRequest")
        return (member as (...a: Array<unknown>) => unknown).bind(target);
      return async (values: ReadonlyArray<string>) =>
        withEmptyUnknownField(
          await target.createClientRequest(values.slice(1)),
        );
    },
  });
}

function participant(
  library: PSILibrary,
  role: "starter" | "joiner",
  tap: Tap = {},
  inWorker = false,
  padRequests = false,
): PSIParticipant {
  const id = role === "starter" ? "server" : "client";
  const tappedEngine = tapped(
    inWorker
      ? workerEngine(library, role, id)
      : new InProcessPsiEngine(library, role, id, "count-only-permuted"),
    tap,
  );
  return new PSIParticipant(
    id,
    library,
    { role, verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
    padRequests ? padding(tappedEngine) : tappedEngine,
  );
}

// A worker-backed engine served on this thread; structuredClone stands in for
// the worker boundary, so an index table that could not cross it fails here.
function workerEngine(
  library: PSILibrary,
  role: "starter" | "joiner",
  id: string,
): WorkerPsiEngine {
  let deliver: (response: PsiWorkerResponse) => void = () => {};
  const dispatch = servePsiWorker(
    library,
    { role, id, mode: "count-only-permuted" },
    (response) => deliver(structuredClone(response)),
  );
  const handle: PsiWorkerHandle = {
    postMessage: (request) => dispatch(structuredClone(request)),
    setHandlers: ({ onMessage }) => {
      deliver = onMessage;
    },
    terminate: () => {},
  };
  return new WorkerPsiEngine(handle);
}

// Records every frame a party sends.
function recording(
  conn: MessageConnection,
  sent: Array<unknown>,
): MessageConnection {
  return {
    send: (data) => {
      sent.push(data);
      return conn.send(data);
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}

// Rewrites the `index`th frame a party receives.
function rewritingInbound(
  conn: MessageConnection,
  index: number,
  rewrite: (frame: unknown) => unknown,
): MessageConnection {
  let received = 0;
  return {
    send: (data) => conn.send(data),
    receive: async (timeoutMs?: number) => {
      const frame = await conn.receive(timeoutMs);
      return received++ === index ? rewrite(frame) : frame;
    },
    close: () => conn.close(),
  };
}

const countReports = (frames: Array<unknown>): Array<unknown> =>
  frames.filter(
    (frame) =>
      typeof frame === "object" &&
      frame !== null &&
      "intersectionCount" in frame,
  );

interface RunOptions {
  library?: PSILibrary;
  reportCountToSender?: boolean;
  senderTap?: Tap;
  receiverTap?: Tap;
  senderDeclared?: CountOnlyDeclaredCounts;
  receiverDeclared?: CountOnlyDeclaredCounts;
  senderData?: Array<Array<string | undefined>>;
  receiverConn?: (conn: MessageConnection) => MessageConnection;
  inWorker?: boolean;
  padReceiverRequests?: boolean;
}

interface RunOutcome {
  sender: PromiseSettledResult<number | undefined>;
  receiver: PromiseSettledResult<number | undefined>;
  senderSent: Array<unknown>;
  receiverSent: Array<unknown>;
  senderParticipant: PSIParticipant;
  receiverParticipant: PSIParticipant;
}

// Both parties' runs, settled. A party that fails closes its end, as a run
// ending on an error does, so the other is not left waiting.
async function run(
  sender: Records,
  receiver: Records,
  options: RunOptions = {},
): Promise<RunOutcome> {
  const library = options.library ?? wasm;
  const [senderEnd, receiverEnd] = createMessagePipe();
  const senderSent: Array<unknown> = [];
  const receiverSent: Array<unknown> = [];
  const senderConn = recording(senderEnd, senderSent);
  const receiverConn = recording(
    options.receiverConn?.(receiverEnd) ?? receiverEnd,
    receiverSent,
  );
  const declared = {
    receiverRecords: receiver.length,
    senderRecords: sender.length,
  };
  const report = options.reportCountToSender ?? true;
  const maxCount = Math.min(sender.length, receiver.length);
  const senderParticipant = participant(
    library,
    "starter",
    options.senderTap,
    options.inWorker,
  );
  const receiverParticipant = participant(
    library,
    "joiner",
    options.receiverTap,
    options.inWorker,
    options.padReceiverRequests,
  );
  const settle = (
    conn: MessageConnection,
    counted: Promise<number | undefined>,
  ): Promise<number | undefined> =>
    counted.catch((error: unknown) => {
      conn.close();
      throw error;
    });
  const [senderOutcome, receiverOutcome] = await Promise.allSettled([
    settle(
      senderConn,
      linkViaCountOnlyPSI(
        senderParticipant,
        senderConn,
        options.senderData ?? roundsOf(sender),
        report,
        maxCount,
        options.senderDeclared ?? declared,
      ),
    ),
    settle(
      receiverConn,
      linkViaCountOnlyPSI(
        receiverParticipant,
        receiverConn,
        roundsOf(receiver),
        report,
        maxCount,
        options.receiverDeclared ?? declared,
      ),
    ),
  ]);
  return {
    sender: senderOutcome,
    receiver: receiverOutcome,
    senderSent,
    receiverSent,
    senderParticipant,
    receiverParticipant,
  };
}

function disposeBoth(outcome: RunOutcome): void {
  outcome.senderParticipant.dispose();
  outcome.receiverParticipant.dispose();
}

function fulfilled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

function rejection(result: PromiseSettledResult<unknown>): unknown {
  expect(result.status).toBe("rejected");
  return result.status === "rejected" ? result.reason : undefined;
}

describe.each(backends)("on the %s backend", (_name, library) => {
  test("the count is the replay's on the cross-key conflict fixture, and reaches the sender", async () => {
    expect(referenceCount(SENDER, RECEIVER)).toBe(FIXTURE_COUNT);
    const outcome = await run(SENDER, RECEIVER, { library });
    disposeBoth(outcome);

    expect(fulfilled(outcome.receiver)).toBe(FIXTURE_COUNT);
    expect(fulfilled(outcome.sender)).toBe(FIXTURE_COUNT);
    expect(countReports(outcome.receiverSent)).toEqual([
      { intersectionCount: FIXTURE_COUNT },
    ]);
    expect(countReports(outcome.senderSent)).toEqual([]);
  });

  test.each([
    [11, 40, 30],
    [29, 25, 60],
  ])(
    "the count is the replay's on a three-key fixture (seed %i), whichever party receives",
    async (seed, senderCount, receiverCount) => {
      const sender = randomRecords(seed, senderCount);
      const receiver = randomRecords(seed + 1, receiverCount);
      const expected = referenceCount(sender, receiver);
      expect(referenceCount(receiver, sender)).toBe(expected);

      const outcome = await run(sender, receiver, { library });
      const swapped = await run(receiver, sender, { library });
      disposeBoth(outcome);
      disposeBoth(swapped);

      expect(fulfilled(outcome.receiver)).toBe(expected);
      expect(fulfilled(swapped.receiver)).toBe(expected);
    },
  );
});

test("the count is the same through the worker-backed engine", async () => {
  const outcome = await run(SENDER, RECEIVER, { inWorker: true });
  disposeBoth(outcome);

  expect(fulfilled(outcome.receiver)).toBe(FIXTURE_COUNT);
  expect(fulfilled(outcome.sender)).toBe(FIXTURE_COUNT);
});

test("one-sided: the sender holds no count and no count-report frame is sent", async () => {
  const outcome = await run(SENDER, RECEIVER, { reportCountToSender: false });
  disposeBoth(outcome);

  expect(fulfilled(outcome.receiver)).toBe(FIXTURE_COUNT);
  expect(fulfilled(outcome.sender)).toBeUndefined();
  expect(countReports(outcome.receiverSent)).toEqual([]);
  expect(countReports(outcome.senderSent)).toEqual([]);
});

test("every round's setup and request have the declared record counts, whatever the coverage", async () => {
  // Most receiver records lack the second key, and the first key's values
  // repeat, so a set of the records holding a unique value would be short.
  const receiver: Records = [
    ...Array.from({ length: 20 }, (_, i) => [`dup-${String(i % 4)}`, ""]),
    ["111", "ann"],
    ["222", ""],
  ];
  const setupSizes: Array<number> = [];
  const requestSizes: Array<number> = [];
  const requestsOnWire: Array<number> = [];
  const outcome = await run(SENDER, receiver, {
    senderTap: {
      createPermutedSetup: (values: ReadonlyArray<string>) =>
        setupSizes.push(values.length),
      processClientRequest: (bytes: Uint8Array) =>
        requestsOnWire.push(
          countDeclaredPsiElements(bytes, "request", Number.MAX_SAFE_INTEGER),
        ),
    } as Tap,
    receiverTap: {
      createClientRequest: (values: ReadonlyArray<string>) =>
        requestSizes.push(values.length),
    } as Tap,
  });
  disposeBoth(outcome);

  expect(fulfilled(outcome.receiver)).toBe(referenceCount(SENDER, receiver));
  expect(setupSizes).toEqual([SENDER.length, SENDER.length]);
  expect(requestSizes).toEqual([receiver.length, receiver.length]);
  expect(requestsOnWire).toEqual([receiver.length, receiver.length]);
});

function elementsOf(serialized: Array<Uint8Array>): Array<string> {
  return serialized.map((element) => Buffer.from(element).toString("hex"));
}

test("a value under two keys gives no equal request or response element across rounds", async () => {
  // Receiver 0 and sender 0 hold "same" under both keys, as does receiver 1
  // with no partner; without the round prefix both would encrypt alike in
  // both rounds.
  const sender: Records = [["same", "same"], ...filler("s", 20)];
  const receiver: Records = [
    ["same", "same"],
    ["solo", "solo"],
    ...filler("r", 20),
  ];
  const requests: Array<Array<string>> = [];
  const responses: Array<Array<string>> = [];
  const outcome = await run(sender, receiver, {
    senderTap: {
      processClientRequest: (bytes: Uint8Array) =>
        requests.push(
          elementsOf(
            wasm.request
              .deserializeBinary(bytes)
              .getEncryptedElementsList_asU8(),
          ),
        ),
    } as Tap,
    receiverTap: {
      matchPermutedRound: (bytes: Uint8Array) =>
        responses.push(
          elementsOf(
            wasm.response
              .deserializeBinary(bytes)
              .getEncryptedElementsList_asU8(),
          ),
        ),
    } as Tap,
  });
  disposeBoth(outcome);

  expect(fulfilled(outcome.receiver)).toBe(1);
  for (const perRound of [requests, responses]) {
    expect(perRound).toHaveLength(2);
    const first = new Set(perRound[0]);
    expect(perRound[1]!.filter((element) => first.has(element))).toEqual([]);
  }
});

test("a request element is deterministic in its input, so the test above would see an unprefixed value", async () => {
  const engine = new InProcessPsiEngine(
    wasm,
    "joiner",
    "client",
    "count-only-permuted",
  );
  const values = ["same", "other"];
  const once = elementsOf(
    wasm.request
      .deserializeBinary(await engine.createClientRequest(values))
      .getEncryptedElementsList_asU8(),
  );
  const twice = elementsOf(
    wasm.request
      .deserializeBinary(await engine.createClientRequest(values))
      .getEncryptedElementsList_asU8(),
  );
  engine.dispose();
  expect(twice).toEqual(once);
});

test("the receiver's request follows one random order, the same in every round, and the count is unchanged", async () => {
  // Every receiver value is its own record's, so each request position names
  // the record it holds.
  const receiver: Records = Array.from({ length: 40 }, (_, i) => [
    `r${String(i)}-a`,
    `r${String(i)}-b`,
  ]);
  const sender: Records = [
    ["r3-a", "x"],
    ["y", "r3-b"],
    ["r17-a", "z"],
    ["w", "r30-b"],
    ...filler("s", 10),
  ];
  const requests: Array<ReadonlyArray<string>> = [];
  const outcome = await run(sender, receiver, {
    receiverTap: {
      createClientRequest: (values: ReadonlyArray<string>) =>
        requests.push([...values]),
    } as Tap,
  });
  disposeBoth(outcome);

  const recordAt = (values: ReadonlyArray<string>, round: number) =>
    values.map((value) => {
      const match = new RegExp(`^${String(round)}:r(\\d+)-`).exec(value);
      expect(match).not.toBeNull();
      return Number(match![1]);
    });
  const order = recordAt(requests[0]!, 0);
  expect(recordAt(requests[1]!, 1)).toEqual(order);
  expect([...order].sort((a, b) => a - b)).toEqual(
    Array.from({ length: receiver.length }, (_, i) => i),
  );
  expect(order).not.toEqual(
    Array.from({ length: receiver.length }, (_, i) => i),
  );
  expect(fulfilled(outcome.receiver)).toBe(referenceCount(sender, receiver));
  expect(fulfilled(outcome.receiver)).toBe(3);
});

describe("the receiver's request order is discarded when the rounds end", () => {
  // The order, `pi` and `sigma` are the run's three draws; only the order is
  // the run's to discard, the other two the engines'.
  test("once the rounds complete", async () => {
    const draw = vi.spyOn(HeldPermutation, "draw");
    const outcome = await run(SENDER, RECEIVER);
    const drawn = draw.mock.results.map(
      (result) => result.value as HeldPermutation,
    );
    expect(drawn).toHaveLength(3);
    const discarded = () =>
      drawn.filter((held) => {
        try {
          held.at(0);
          return false;
        } catch {
          return true;
        }
      });
    expect(discarded()).toHaveLength(1);
    expect(discarded()[0]!.size).toBe(RECEIVER.length);
    disposeBoth(outcome);
    expect(discarded()).toHaveLength(3);
  });

  test("when a round fails", async () => {
    const draw = vi.spyOn(HeldPermutation, "draw");
    const discard = vi.spyOn(HeldPermutation.prototype, "discard");
    const outcome = await run(SENDER, RECEIVER, {
      senderDeclared: {
        receiverRecords: RECEIVER.length + 1,
        senderRecords: SENDER.length,
      },
    });
    // The sender refused the first request, so it drew `sigma` and no `pi`.
    rejection(outcome.receiver);
    const drawn = draw.mock.results.map(
      (result) => result.value as HeldPermutation,
    );
    expect(drawn.map((held) => held.size).sort((a, b) => a - b)).toEqual([
      SENDER.length,
      RECEIVER.length,
    ]);
    const order = drawn.find((held) => held.size === RECEIVER.length);
    expect(discard.mock.contexts).toEqual([order]);
    disposeBoth(outcome);
  });
});

describe("a frame not of the declared shape is refused as a protocol error", () => {
  function expectProtocolRefusal(
    outcome: RunOutcome,
    party: "sender" | "receiver",
    message: RegExp,
  ): void {
    disposeBoth(outcome);
    const refusal = rejection(outcome[party]);
    expect(refusal).toBeInstanceOf(PartnerProtocolRefusalError);
    expect((refusal as Error).message).toMatch(message);
    rejection(outcome[party === "sender" ? "receiver" : "sender"]);
    expect(countReports(outcome.senderSent)).toEqual([]);
    expect(countReports(outcome.receiverSent)).toEqual([]);
  }

  test("a setup of another size than the sender's declared count", async () => {
    const outcome = await run(SENDER, RECEIVER, {
      receiverDeclared: {
        receiverRecords: RECEIVER.length,
        senderRecords: SENDER.length + 1,
      },
    });
    expectProtocolRefusal(
      outcome,
      "receiver",
      /PSI setup has 48 elements for its 49 declared records/,
    );
  });

  test("a request of another size than the receiver's declared count", async () => {
    const outcome = await run(SENDER, RECEIVER, {
      senderDeclared: {
        receiverRecords: RECEIVER.length + 1,
        senderRecords: SENDER.length,
      },
    });
    expectProtocolRefusal(
      outcome,
      "sender",
      /PSI request has 64 elements for its 65 declared records/,
    );
  });

  test.for([
    ["wasm", false],
    ["native", false],
    ["worker-backed", true],
  ] as const)(
    "a request padded with an empty unknown field is refused for its parsed count before pi is drawn or any response part is sent, on the %s engine",
    async ([name, inWorker]) => {
      const library = name === "native" ? native : wasm;
      if (library === undefined) return;
      const scanned = vi.fn();
      const draw = vi.spyOn(HeldPermutation, "draw");
      const baseline = await run(SENDER, RECEIVER, {
        library,
        inWorker,
        senderDeclared: {
          receiverRecords: RECEIVER.length + 1,
          senderRecords: SENDER.length,
        },
      });
      disposeBoth(baseline);
      draw.mockClear();
      const outcome = await run(SENDER, RECEIVER, {
        library,
        inWorker,
        padReceiverRequests: true,
        senderTap: {
          processClientRequest: (bytes: Uint8Array) =>
            scanned(
              countDeclaredPsiElements(
                bytes,
                "request",
                Number.MAX_SAFE_INTEGER,
              ),
            ),
        } as Tap,
      });
      disposeBoth(outcome);

      expect(scanned).toHaveBeenCalledWith(RECEIVER.length);
      expectProtocolRefusal(
        outcome,
        "sender",
        /PSI request has 63 elements for its 64 declared records/,
      );
      // The sender's setup and index table are all it sent before the request,
      // as when the wire-scan bound refuses the request.
      expect(outcome.senderSent).toHaveLength(baseline.senderSent.length);
      // Only `sigma` (the sender's count) and the receiver's request order.
      expect(
        draw.mock.results
          .map((result) => (result.value as HeldPermutation).size)
          .sort((a, b) => a - b),
      ).toEqual([SENDER.length, RECEIVER.length]);
    },
  );

  // The receiver's inbound frames start with round 0's setup, one part at
  // this size, then the round's index table.
  const INDEX_TABLE_FRAME = 1;

  test("an index table of the wrong length", async () => {
    const outcome = await run(SENDER, RECEIVER, {
      receiverConn: (conn) =>
        rewritingInbound(conn, INDEX_TABLE_FRAME, (frame) =>
          (frame as Uint8Array).subarray(4),
        ),
    });
    expectProtocolRefusal(outcome, "receiver", /index table is 188 bytes/);
  });

  test("an index table that is not a permutation", async () => {
    const outcome = await run(SENDER, RECEIVER, {
      receiverConn: (conn) =>
        rewritingInbound(conn, INDEX_TABLE_FRAME, (frame) => {
          const table = (frame as Uint8Array).slice();
          table.set(table.subarray(0, 4), 4);
          return table;
        }),
    });
    expectProtocolRefusal(outcome, "receiver", /not a permutation/);
  });
});

describe("a run that ends before its last round yields no count", () => {
  test("the sender stopping between rounds", async () => {
    // The sender fails building its second round, after the first completed,
    // and its end of the connection closes.
    const failing = function* (): Generator<string | undefined> {
      throw new Error("the sender stopped before its second round");
    };
    const [first] = roundsOf(SENDER);
    const outcome = await run(SENDER, RECEIVER, {
      senderData: [first!, failing() as unknown as Array<string | undefined>],
    });
    disposeBoth(outcome);
    rejection(outcome.sender);
    rejection(outcome.receiver);
    expect(countReports(outcome.receiverSent)).toEqual([]);
    await expect(
      outcome.receiverParticipant.finishPermutedCount(2),
    ).rejects.toThrow(/after 1 of the exchange.s 2 count-only rounds/);
  });

  test("an abort after a round's setup, in place of its index table", async () => {
    const outcome = await run(SENDER, RECEIVER, {
      receiverConn: (conn) =>
        rewritingInbound(conn, 4, () => ({
          decision: "abort",
          abortReasons: ["the partner stopped"],
        })),
    });
    const refusal = rejection(outcome.receiver);
    expect(refusal).toBeInstanceOf(PeerAbortError);
    rejection(outcome.sender);
    expect(countReports(outcome.receiverSent)).toEqual([]);
    expect(countReports(outcome.senderSent)).toEqual([]);
    await expect(
      outcome.receiverParticipant.finishPermutedCount(2),
    ).rejects.toThrow(/after 1 of the exchange.s 2 count-only rounds/);
    disposeBoth(outcome);
  });
});

test("a round's set has one element per record, a fresh dummy for a missing or repeated value", async () => {
  const elements = await countOnlyRoundElements(
    ["a", undefined, "b", "b", "c"],
    3,
    5,
  );
  expect(elements[0]).toBe("3:a");
  expect(elements[4]).toBe("3:c");
  for (const index of [1, 2, 3])
    expect(elements[index]).toMatch(/^[0-9a-f]{64}$/);
  expect(new Set(elements).size).toBe(5);
  const dummies = new CountOnlyDummies();
  expect(dummies.draw()).not.toBe(dummies.draw());
  await expect(countOnlyRoundElements(["a"], 0, 2)).rejects.toThrow(
    InternalConsistencyError,
  );
  await expect(
    countOnlyRoundElements([new Set(["a", "b"])], 0, 1),
  ).rejects.toThrow(/several/);
});
