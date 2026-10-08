import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../../src/psi/participant";
import {
  InProcessPsiEngine,
  type InProcessPsiEngineOptions,
  type PsiEngineMode,
} from "../../src/psi/psiEngine";
import {
  PsiOperationStoppedError,
  WorkerPsiEngine,
  servePsiWorker,
  type PsiWorkerHandle,
  type PsiWorkerInit,
  type PsiWorkerRequest,
  type PsiWorkerResponse,
} from "../../src/psi/psiWorkerEngine";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

// A stop requested while an operation runs takes effect at the next chunk or
// match slice boundary, so at most one more library call runs after the
// request: the worker is never torn down inside a library call.

const psiLibrary = await PSI();

const CHUNK_ELEMENTS = 20;
const VALUES = Array.from({ length: 100 }, (_, index) => `v-${index}`);

// A WorkerPsiEngine over an in-process dispatcher, cloning each message as a
// real worker boundary does; the shared stop flag survives the clone as shared
// memory, as it does across worker_threads.
function inProcessWorkerEngine(
  init: PsiWorkerInit,
  options: InProcessPsiEngineOptions,
): {
  engine: WorkerPsiEngine;
  posted: Array<PsiWorkerResponse>;
  terminated: () => number;
} {
  const posted: Array<PsiWorkerResponse> = [];
  let terminateCalls = 0;
  let deliver: (response: PsiWorkerResponse) => void = () => {};
  const dispatch = servePsiWorker(
    psiLibrary,
    init,
    (response) => {
      const cloned = structuredClone(response);
      posted.push(cloned);
      deliver(cloned);
    },
    options,
  );
  const handle: PsiWorkerHandle = {
    postMessage: (request) => dispatch(structuredClone(request)),
    setHandlers: ({ onMessage }) => {
      deliver = onMessage;
    },
    terminate: () => {
      terminateCalls += 1;
    },
  };
  return {
    engine: new WorkerPsiEngine(handle),
    posted,
    terminated: () => terminateCalls,
  };
}

function chunkingWorkerEngine(): ReturnType<typeof inProcessWorkerEngine> {
  return inProcessWorkerEngine(
    { role: "starter", id: "server", mode: "identifier-revealing" },
    { chunkElements: CHUNK_ELEMENTS },
  );
}

test("a stop requested at the first chunk boundary ends the operation at the next one", async () => {
  const { engine, posted } = chunkingWorkerEngine();
  const seen: Array<number> = [];
  const accepted: Array<boolean> = [];
  engine.observeProcessedElements((processed) => {
    seen.push(processed);
    accepted.push(engine.stopInFlight());
  });
  try {
    await expect(engine.createServerSetup(VALUES)).rejects.toBeInstanceOf(
      PsiOperationStoppedError,
    );
  } finally {
    engine.dispose();
  }
  expect(seen).toStrictEqual([CHUNK_ELEMENTS]);
  expect(accepted).toStrictEqual([true]);
  expect(posted.at(-1)).toMatchObject({ ok: false, stopped: true });
});

test("a stop between operations does nothing, and the next operation runs to its end", async () => {
  const { engine } = chunkingWorkerEngine();
  try {
    expect(engine.stopInFlight()).toBe(false);
    const { setup } = await engine.createServerSetup(VALUES);
    expect(setup.byteLength).toBeGreaterThan(0);
  } finally {
    engine.dispose();
  }
});

test("dispose during an operation asks it to stop before terminating the worker", async () => {
  const { engine, posted, terminated } = chunkingWorkerEngine();
  engine.observeProcessedElements(() => engine.dispose());
  await expect(engine.createServerSetup(VALUES)).rejects.toThrow(
    "PSI worker engine is disposed",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(terminated()).toBe(1);
  expect(posted.at(-1)).toMatchObject({ ok: false, stopped: true });
});

test("a participant's stopped operation fails with the stop reason it was given", async () => {
  const { engine } = chunkingWorkerEngine();
  const participant = new PSIParticipant(
    "server",
    psiLibrary,
    { role: "starter", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
    engine,
  );
  const partnerLost = new Error("partner lost");
  let lost = false;
  participant.stopOperationsWhen(() => (lost ? partnerLost : undefined));
  engine.observeProcessedElements(() => {
    lost = true;
    expect(participant.stopOperationInFlight()).toBe(true);
  });
  try {
    await expect(participant.createServerSetup(VALUES)).rejects.toBe(
      partnerLost,
    );
  } finally {
    participant.dispose();
  }
});

test("a stop flag once set is not cleared by a later request", async () => {
  const posted: Array<PsiWorkerRequest> = [];
  let deliver: (response: PsiWorkerResponse) => void = () => {};
  const engine = new WorkerPsiEngine({
    postMessage: (request) => posted.push(request),
    setHandlers: ({ onMessage }) => {
      deliver = onMessage;
    },
    terminate: () => {},
  });
  try {
    const first = engine.createClientRequest(["x"]);
    expect(engine.stopInFlight()).toBe(true);
    deliver({ id: posted[0]!.id, ok: true, result: new Uint8Array() });
    await first;

    void engine.createClientRequest(["y"]).catch(() => {});
    expect(posted).toHaveLength(2);
    expect(Atomics.load(posted[1]!.stopFlag!, 0)).not.toBe(0);
  } finally {
    engine.dispose();
  }
});

// Five slices of the partner's 100-element setup, or five pieces of the
// 100-element response a streamed match is fed.
const SLICE_ELEMENTS = 20;
const SPLIT_MATCHES: ReadonlyArray<[string, InProcessPsiEngineOptions]> = [
  [
    "first slice of a sliced",
    { matchMethod: "sliced", setupSliceElements: SLICE_ELEMENTS },
  ],
  ["first piece of a streamed", { chunkElements: SLICE_ELEMENTS }],
];
const JOINER_VALUES = VALUES.map((value, index) =>
  index % 2 === 0 ? value : `joiner-only-${index}`,
);
const SHARED_INDICES = JOINER_VALUES.flatMap((_, index) =>
  index % 2 === 0 ? [index] : [],
);
const MODES: ReadonlyArray<PsiEngineMode> = [
  "identifier-revealing",
  "count-only",
];

// The partner's setup and its response to the request `createRequest` makes,
// from a starter in `mode`.
async function matchFrames(
  mode: PsiEngineMode,
  createRequest: (values: ReadonlyArray<string>) => Promise<Uint8Array>,
): Promise<{ setup: Uint8Array; response: Uint8Array }> {
  const starter = new InProcessPsiEngine(psiLibrary, "starter", "server", mode);
  try {
    const { setup } = await starter.createServerSetup(VALUES);
    const response = await starter.processClientRequest(
      await createRequest(JOINER_VALUES),
    );
    return { setup, response };
  } finally {
    starter.dispose();
  }
}

// A joiner's worker engine in `mode` and the match it runs on the partner's
// frames, started by `match()`.
async function joinerMatch(
  mode: PsiEngineMode,
  options: InProcessPsiEngineOptions,
): Promise<
  ReturnType<typeof inProcessWorkerEngine> & { match: () => Promise<unknown> }
> {
  const joiner = inProcessWorkerEngine(
    { role: "joiner", id: "client", mode },
    options,
  );
  const { setup, response } = await matchFrames(mode, (values) =>
    joiner.engine.createClientRequest(values),
  );
  await joiner.engine.receiveServerSetup(setup);
  const match = () =>
    mode === "count-only"
      ? joiner.engine.computeIntersectionCardinality(response)
      : joiner.engine.computeAssociationTable(response);
  return { ...joiner, match };
}

test.each(
  SPLIT_MATCHES.flatMap(([split, options]) =>
    MODES.map((mode) => [split, mode, options] as const),
  ),
)(
  "a stop requested at the %s %s match ends it at the next boundary, and nothing of the match leaves the worker",
  async (_split, mode, options) => {
    const { engine, posted, match } = await joinerMatch(mode, options);
    const seen: Array<number> = [];
    engine.observeProcessedElements((processed) => {
      seen.push(processed);
      expect(engine.stopInFlight()).toBe(true);
    });
    const before = posted.length;
    try {
      await expect(match()).rejects.toBeInstanceOf(PsiOperationStoppedError);
    } finally {
      engine.dispose();
    }
    expect(seen).toStrictEqual([SLICE_ELEMENTS]);
    const matchId = posted[before]!.id;
    expect(posted.slice(before)).toStrictEqual([
      { id: matchId, processed: SLICE_ELEMENTS },
      {
        id: matchId,
        ok: false,
        error: new PsiOperationStoppedError().message,
        libraryFailure: false,
        stopped: true,
      },
    ]);
  },
);

test.each(MODES)(
  "a stop requested during a %s match in one piece takes effect only after the match finishes",
  async (mode) => {
    const { engine, posted, match } = await joinerMatch(mode, {});
    const before = posted.length;
    let result: unknown;
    try {
      const matching = match();
      expect(engine.stopInFlight()).toBe(true);
      result = await matching;
    } finally {
      engine.dispose();
    }
    const matched =
      mode === "count-only"
        ? result
        : [...(result as [Array<number>, Array<number>])[0]].sort(
            (a, b) => a - b,
          );
    expect(matched).toStrictEqual(
      mode === "count-only" ? SHARED_INDICES.length : SHARED_INDICES,
    );
    expect(posted.slice(before)).toStrictEqual([
      { id: posted[before]!.id, ok: true, result },
    ]);
  },
);

test.each(SPLIT_MATCHES)(
  "a partner lost at the %s participant's match fails it with the loss",
  async (_split, options) => {
    const { engine } = inProcessWorkerEngine(
      { role: "joiner", id: "client", mode: "identifier-revealing" },
      options,
    );
    const participant = new PSIParticipant(
      "client",
      psiLibrary,
      { role: "joiner", verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
      engine,
    );
    const partnerLost = new Error("partner lost");
    let lost = false;
    participant.stopOperationsWhen(() => (lost ? partnerLost : undefined));
    try {
      const { setup, response } = await matchFrames(
        "identifier-revealing",
        (values) => participant.createClientRequest(values),
      );
      const seen: Array<number> = [];
      engine.observeProcessedElements((processed) => {
        seen.push(processed);
        lost = true;
        expect(participant.stopOperationInFlight()).toBe(true);
      });
      await expect(
        participant.computeValueMatches(setup, response),
      ).rejects.toBe(partnerLost);
      expect(seen).toStrictEqual([SLICE_ELEMENTS]);
    } finally {
      participant.dispose();
    }
  },
);
