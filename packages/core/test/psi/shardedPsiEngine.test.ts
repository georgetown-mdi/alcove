import { afterEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { countDeclaredPsiElements } from "../../src/connection/psiElementScan";
import {
  InternalConsistencyError,
  PartnerProtocolRefusalError,
} from "../../src/errors";
import {
  drawUniformPermutation,
  HeldPermutation,
} from "../../src/psi/countOnlyPermutation";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import {
  PSI_SHARD_MIN_ELEMENTS,
  ShardedPsiEngine,
  shardHelperMode,
  shardStalledError,
} from "../../src/psi/shardedPsiEngine";
import { fixedKeyPsiLibrary, psiTestKey } from "../utils/fixedKeyPsiLibrary";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";
import { withEmptyUnknownField } from "../utils/paddedPsiRequest";

import type { PsiEngine, PsiEngineMode } from "../../src/psi/psiEngine";

// A sharded request or response goes on the wire as the bytes one engine
// produces for the same key and values. The shard floor is set low so a unit
// run shards a set it can afford to mask.

const TOTAL = 200;
const MIN_SHARD_ELEMENTS = 40;
const SERVER_KEY = psiTestKey(0x31);
const CLIENT_KEY = psiTestKey(0x42);

const serverValues = Array.from({ length: TOTAL }, (_, index) => `v-${index}`);
// Repeats sit in different shards from their first occurrence, so a count-only
// filter applied per shard would keep them where the whole-set filter drops them.
const clientValues = Array.from({ length: TOTAL }, (_, index) => {
  if (index === 150) return "v-0";
  if (index === 199) return "v-2";
  return index % 2 === 0 ? `v-${index}` : `joiner-only-${index}`;
});

const wasm = await PSI();
const native: PSILibrary | undefined = await loadNativeAddonOrSkip();

function keyedEngine(
  library: PSILibrary,
  role: "starter" | "joiner",
  mode: PsiEngineMode,
): InProcessPsiEngine {
  return new InProcessPsiEngine(
    fixedKeyPsiLibrary(library, SERVER_KEY, CLIENT_KEY),
    role,
    role,
    mode,
  );
}

function shardedEngine(
  library: PSILibrary,
  role: "starter" | "joiner",
  mode: PsiEngineMode,
  engines: number,
  minShardElements = MIN_SHARD_ELEMENTS,
): ShardedPsiEngine {
  return new ShardedPsiEngine(
    library,
    role,
    mode,
    keyedEngine(library, role, mode),
    Array.from({ length: engines - 1 }, () =>
      keyedEngine(library, role, shardHelperMode(mode)),
    ),
    { minShardElements },
  );
}

afterEach(() => vi.restoreAllMocks());

// Every permutation an engine draws is the one fixed for its size, so two
// engines under the same key reorder under the same `pi` and `sigma`. Each
// draw gets its own copy, which the engine zeroes when it is discarded.
function fixEveryPermutation(): Mock<(size: number) => HeldPermutation> {
  const fixed = new Map<number, Int32Array>();
  return vi.spyOn(HeldPermutation, "draw").mockImplementation((size) => {
    let order = fixed.get(size);
    if (order === undefined) {
      order = drawUniformPermutation(size);
      fixed.set(size, order);
    }
    return new HeldPermutation(order.slice());
  });
}

// A request with the reveal flag cleared, as the library's own client builds
// one in its cardinality mode: no engine mode builds such a request.
function cardinalityRequest(
  library: PSILibrary,
  values: ReadonlyArray<string>,
): Uint8Array {
  const client = library.client!.createWithNewKey(false);
  try {
    return client.createRequest(values).serializeBinary();
  } finally {
    client.delete();
  }
}

describe.each([
  ["wasm", wasm],
  ["native addon", native],
])("the %s backend", (_name, library) => {
  describe.each<PsiEngineMode>(["identifier-revealing"])(
    "a %s round",
    (mode) => {
      test.for([1, 2, 3, 5])(
        "across %i engines puts one engine's bytes on the wire",
        async (engines, ctx) => {
          if (!library) {
            ctx.skip();
            return;
          }
          const single = {
            starter: keyedEngine(library, "starter", mode),
            joiner: keyedEngine(library, "joiner", mode),
          };
          const sharded = {
            starter: shardedEngine(library, "starter", mode, engines),
            joiner: shardedEngine(library, "joiner", mode, engines),
          };
          try {
            const setup = await single.starter.createServerSetup(serverValues);
            expect(
              await sharded.starter.createServerSetup(serverValues),
            ).toStrictEqual(setup);

            const request =
              await single.joiner.createClientRequest(clientValues);
            expect(
              await sharded.joiner.createClientRequest(clientValues),
            ).toEqual(request);

            const response = await single.starter.processClientRequest(request);
            expect(await sharded.starter.processClientRequest(request)).toEqual(
              response,
            );

            await single.joiner.receiveServerSetup(setup.setup);
            await sharded.joiner.receiveServerSetup(setup.setup);
            expect(
              await sharded.joiner.computeAssociationTable(response),
            ).toStrictEqual(
              await single.joiner.computeAssociationTable(response),
            );
          } finally {
            for (const engine of [
              single.starter,
              single.joiner,
              sharded.starter,
              sharded.joiner,
            ])
              engine.dispose();
          }
        },
      );
    },
  );

  test("a partner request in the library's cardinality mode is refused as one engine refuses it", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    const single = keyedEngine(library, "starter", "identifier-revealing");
    const sharded = shardedEngine(
      library,
      "starter",
      "identifier-revealing",
      3,
    );
    try {
      const request = cardinalityRequest(library, clientValues);
      const refusal = await Promise.resolve()
        .then(() => single.processClientRequest(request))
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(refusal).toBeInstanceOf(Error);
      await expect(sharded.processClientRequest(request)).rejects.toThrow(
        (refusal as Error).message,
      );
    } finally {
      single.dispose();
      sharded.dispose();
    }
  });
});

describe.each([
  ["wasm", wasm],
  ["native addon", native],
])("the %s backend in a count-only-permuted round", (_name, library) => {
  const mode: PsiEngineMode = "count-only-permuted";
  // At the shipped floor, enough elements that every engine takes a part:
  // 2,100 for one or two engines, 3,124 for three and 5,172 for five.
  const elementsFor = (engines: number): number =>
    Math.max(2, engines) * PSI_SHARD_MIN_ELEMENTS + 52;
  // Every third receiver value is a sender value.
  const permutedValues = (elements: number) => ({
    sender: Array.from({ length: elements }, (_, index) => `s-${index}`),
    receiver: Array.from({ length: elements }, (_, index) =>
      index % 3 === 0 ? `s-${index}` : `r-${index}`,
    ),
    matches: Math.ceil(elements / 3),
  });

  test.for([1, 2, 3, 5])(
    "across %i engines puts one engine's bytes on the wire under the same pi, and the receiver counts every match",
    { timeout: 120_000 },
    async (engines, ctx) => {
      if (!library) {
        ctx.skip();
        return;
      }
      const draws = fixEveryPermutation();
      const values = permutedValues(elementsFor(engines));
      const single = {
        starter: keyedEngine(library, "starter", mode),
        joiner: keyedEngine(library, "joiner", mode),
      };
      const sharded = {
        starter: shardedEngine(
          library,
          "starter",
          mode,
          engines,
          PSI_SHARD_MIN_ELEMENTS,
        ),
        joiner: shardedEngine(
          library,
          "joiner",
          mode,
          engines,
          PSI_SHARD_MIN_ELEMENTS,
        ),
      };
      try {
        const setup = await single.starter.createPermutedSetup(values.sender);
        const request = await single.joiner.createClientRequest(
          values.receiver,
        );
        const response = await single.starter.processClientRequest(
          request,
          values.receiver.length,
        );

        const drawsBefore = draws.mock.calls.length;
        expect(
          await sharded.starter.createPermutedSetup(values.sender),
        ).toStrictEqual(setup);
        expect(
          await sharded.joiner.createClientRequest(values.receiver),
        ).toEqual(request);
        expect(
          await sharded.starter.processClientRequest(
            request,
            values.receiver.length,
          ),
        ).toEqual(response);
        // `sigma` and `pi`, each drawn once, on the primary.
        expect(draws.mock.calls.length - drawsBefore).toBe(2);

        await sharded.joiner.receiveServerSetup(setup.setup);
        await sharded.joiner.receiveIndexTable(setup.indexTable);
        await sharded.joiner.matchPermutedRound(response);
        expect(await sharded.joiner.finishPermutedCount()).toBe(values.matches);
      } finally {
        for (const engine of [
          single.starter,
          single.joiner,
          sharded.starter,
          sharded.joiner,
        ])
          engine.dispose();
      }
    },
  );

  test("a second round reorders under the first round's pi, and a request of another size is refused", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    const draws = fixEveryPermutation();
    const values = permutedValues(elementsFor(3));
    const single = keyedEngine(library, "starter", mode);
    const sharded = shardedEngine(
      library,
      "starter",
      mode,
      3,
      PSI_SHARD_MIN_ELEMENTS,
    );
    const joiner = keyedEngine(library, "joiner", mode);
    const shorterJoiner = keyedEngine(library, "joiner", mode);
    try {
      let shardedDraws = 0;
      for (const round of [0, 1]) {
        const request = await joiner.createClientRequest(
          values.receiver.map((value) => `${String(round)}:${value}`),
        );
        const expected = await single.processClientRequest(
          request,
          values.receiver.length,
        );
        const drawsBefore = draws.mock.calls.length;
        expect(
          await sharded.processClientRequest(request, values.receiver.length),
        ).toEqual(expected);
        shardedDraws += draws.mock.calls.length - drawsBefore;
      }
      expect(shardedDraws).toBe(1);
      const shorter = await shorterJoiner.createClientRequest(
        values.receiver.slice(1),
      );
      await expect(
        sharded.processClientRequest(shorter, values.receiver.length - 1),
      ).rejects.toThrow(
        /has 3123 elements where the exchange's first had 3124/,
      );
    } finally {
      for (const engine of [single, sharded, joiner, shorterJoiner])
        engine.dispose();
    }
  }, 120_000);
});

describe("the sharded engine in the count-only-permuted mode", () => {
  const mode: PsiEngineMode = "count-only-permuted";

  // A starter whose engines each record the requests they are asked to answer.
  const answeringEngines = (engineMode: PsiEngineMode, engines: number) => {
    const primary = keyedEngine(wasm, "starter", engineMode);
    const helpers = Array.from({ length: engines - 1 }, () =>
      keyedEngine(wasm, "starter", shardHelperMode(engineMode)),
    );
    return {
      sharded: new ShardedPsiEngine(
        wasm,
        "starter",
        engineMode,
        primary,
        helpers,
        { minShardElements: MIN_SHARD_ELEMENTS },
      ),
      primaryAnswers: vi.spyOn(primary, "processClientRequest"),
      helperAnswers: helpers.map((helper) =>
        vi.spyOn(helper, "processClientRequest"),
      ),
    };
  };

  test.for([2, 3, 5])(
    "across %i engines the primary answers the whole request, to one engine's bytes under the same pi, at a size the other modes split",
    async (engines) => {
      fixEveryPermutation();
      const permuted = answeringEngines(mode, engines);
      const split = answeringEngines("identifier-revealing", engines);
      const single = keyedEngine(wasm, "starter", mode);
      const joiner = keyedEngine(wasm, "joiner", mode);
      const revealingJoiner = keyedEngine(
        wasm,
        "joiner",
        "identifier-revealing",
      );
      try {
        const request = await joiner.createClientRequest(serverValues);
        expect(
          await permuted.sharded.processClientRequest(
            request,
            serverValues.length,
          ),
        ).toEqual(
          await single.processClientRequest(request, serverValues.length),
        );
        expect(permuted.primaryAnswers).toHaveBeenCalledOnce();
        expect(permuted.primaryAnswers).toHaveBeenCalledWith(
          request,
          serverValues.length,
          undefined,
        );
        for (const answer of permuted.helperAnswers)
          expect(answer).not.toHaveBeenCalled();

        await split.sharded.processClientRequest(
          await revealingJoiner.createClientRequest(serverValues),
        );
        for (const answer of split.helperAnswers)
          expect(answer).toHaveBeenCalledOnce();
      } finally {
        for (const engine of [
          permuted.sharded,
          split.sharded,
          single,
          joiner,
          revealingJoiner,
        ])
          engine.dispose();
      }
    },
  );

  test("a request padded with an empty unknown field is refused for its parsed count, before pi is drawn", async () => {
    const draws = fixEveryPermutation();
    const sharded = shardedEngine(wasm, "starter", mode, 3);
    const joiner = keyedEngine(wasm, "joiner", mode);
    try {
      const padded = withEmptyUnknownField(
        await joiner.createClientRequest(serverValues.slice(1)),
      );
      expect(
        countDeclaredPsiElements(padded, "request", Number.MAX_SAFE_INTEGER),
      ).toBe(serverValues.length);
      const refused = sharded.processClientRequest(padded, serverValues.length);
      await expect(refused).rejects.toBeInstanceOf(PartnerProtocolRefusalError);
      await expect(refused).rejects.toThrow(
        `the partner's PSI request has ${String(serverValues.length - 1)} elements for its ${String(serverValues.length)} declared records`,
      );
      expect(draws).not.toHaveBeenCalled();
    } finally {
      sharded.dispose();
      joiner.dispose();
    }
  });

  test("a value repeated across two parts is refused, as one engine refuses it", async () => {
    const sharded = shardedEngine(wasm, "joiner", mode, 3);
    try {
      const repeated = [...serverValues];
      repeated[TOTAL - 1] = repeated[0]!;
      const refused = sharded.createClientRequest(repeated);
      await expect(refused).rejects.toBeInstanceOf(InternalConsistencyError);
      await expect(refused).rejects.toThrow(/was given a repeated value/);
    } finally {
      sharded.dispose();
    }
  });

  test("a primary that is not built to create the first part of a split request is refused at construction", () => {
    expect(
      () => new ShardedPsiEngine(wasm, "starter", mode, fakeEngine(), []),
    ).toThrow(
      "starter: a sharded PSI engine in the count-only-permuted mode needs a primary built in that mode that creates the first part of a split request",
    );
  });

  test("a primary built in the identifier-revealing mode is refused at construction, and one in this mode is not", () => {
    const mismatched = keyedEngine(wasm, "starter", "identifier-revealing");
    const matching = keyedEngine(wasm, "starter", mode);
    const helper = keyedEngine(wasm, "starter", shardHelperMode(mode));
    try {
      const refused = () =>
        new ShardedPsiEngine(wasm, "starter", mode, mismatched, [helper]);
      expect(refused).toThrow(InternalConsistencyError);
      expect(refused).toThrow(
        "starter: a sharded PSI engine in the count-only-permuted mode needs a primary built in that mode that creates the first part of a split request",
      );
      expect(
        new ShardedPsiEngine(wasm, "starter", mode, matching, [helper]),
      ).toBeInstanceOf(ShardedPsiEngine);
    } finally {
      for (const engine of [mismatched, matching, helper]) engine.dispose();
    }
  });

  test("a disposed engine refuses a split operation before any engine sees it", async () => {
    const engines = [fakeEngine(), fakeEngine()];
    const engine = new ShardedPsiEngine(
      wasm,
      "joiner",
      "identifier-revealing",
      engines[0]!,
      engines.slice(1),
      { minShardElements: 1 },
    );
    engine.dispose();
    await expect(engine.createClientRequest(["a", "b"])).rejects.toThrow(
      "joiner: createClientRequest called on a disposed PSI engine",
    );
    await expect(
      engine.processClientRequest(new wasm.request().serializeBinary()),
    ).rejects.toThrow(
      "joiner: processClientRequest called on a disposed PSI engine",
    );
    for (const each of engines) {
      expect(each.createClientRequest).not.toHaveBeenCalled();
      expect(each.processClientRequest).not.toHaveBeenCalled();
    }
  });

  test("the helper mode is identifier-revealing in either mode", () => {
    expect(shardHelperMode("identifier-revealing")).toBe(
      "identifier-revealing",
    );
    expect(shardHelperMode("count-only-permuted")).toBe("identifier-revealing");
  });
});

describe("the sharded engine's split", () => {
  test("a set too small for a second shard runs on the primary alone", async () => {
    const single = keyedEngine(wasm, "joiner", "identifier-revealing");
    const helper = fakeEngine();
    const engine = new ShardedPsiEngine(
      wasm,
      "joiner",
      "identifier-revealing",
      keyedEngine(wasm, "joiner", "identifier-revealing"),
      [helper],
      { minShardElements: MIN_SHARD_ELEMENTS },
    );
    try {
      const values = clientValues.slice(0, 2 * MIN_SHARD_ELEMENTS - 1);
      expect(await engine.createClientRequest(values)).toEqual(
        await single.createClientRequest(values),
      );
      expect(helper.createClientRequest).not.toHaveBeenCalled();
    } finally {
      engine.dispose();
      single.dispose();
    }
  });

  test("the running count sums the shards and stops short of the total", async () => {
    const engine = shardedEngine(wasm, "joiner", "identifier-revealing", 3);
    const reported: Array<number> = [];
    engine.observeProcessedElements((processed) => reported.push(processed));
    try {
      await engine.createClientRequest(clientValues);
    } finally {
      engine.dispose();
    }
    // Three shards of 66, 67 and 67, which mask on this thread last first:
    // each finished shard adds its range while another still runs, and the
    // last one's finish is the settle report's.
    expect(reported).toStrictEqual([67, 134]);
  });

  test("the primary's shard starts after every other shard has its part", async () => {
    const started: Array<string> = [];
    const engines = ["primary", "first helper", "second helper"].map((name) => {
      const engine = fakeEngine();
      engine.createClientRequest.mockImplementation(() => {
        started.push(name);
        return Promise.resolve(new wasm.request().serializeBinary());
      });
      return engine;
    });
    const engine = new ShardedPsiEngine(
      wasm,
      "joiner",
      "identifier-revealing",
      engines[0]!,
      engines.slice(1),
      { minShardElements: 1 },
    );
    await engine.createClientRequest(["a", "b", "c"]);
    expect(started).toStrictEqual(["second helper", "first helper", "primary"]);
  });

  test("an operation on the primary alone passes its count through", async () => {
    const primary = fakeEngine();
    const engine = new ShardedPsiEngine(
      wasm,
      "joiner",
      "identifier-revealing",
      primary,
      [fakeEngine()],
    );
    const reported: Array<number> = [];
    engine.observeProcessedElements((processed) => reported.push(processed));
    primary.report?.(7);
    expect(reported).toStrictEqual([7]);
  });

  test("a failed split reports nothing for the shards still running", async () => {
    const primary = fakeEngine();
    primary.createClientRequest.mockRejectedValue(new Error("primary failed"));
    const helper = fakeEngine();
    let finishHelper: (bytes: Uint8Array) => void = () => undefined;
    helper.createClientRequest.mockReturnValue(
      new Promise<Uint8Array>((resolve) => {
        finishHelper = resolve;
      }),
    );
    const engine = new ShardedPsiEngine(
      wasm,
      "joiner",
      "identifier-revealing",
      primary,
      [helper],
      { minShardElements: 1 },
    );
    const reported: Array<number> = [];
    engine.observeProcessedElements((processed) => reported.push(processed));
    await expect(engine.createClientRequest(["a", "b"])).rejects.toThrow(
      "primary failed",
    );
    helper.report?.(1);
    finishHelper(new wasm.request().serializeBinary());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reported).toStrictEqual([]);
  });

  test.for<PsiEngineMode>(["identifier-revealing"])(
    "a wrapper in %s mode refuses a request in the library's cardinality mode before any engine sees it",
    async (wrapperMode) => {
      const engines = [fakeEngine(), fakeEngine(), fakeEngine()];
      const engine = new ShardedPsiEngine(
        wasm,
        "starter",
        wrapperMode,
        engines[0]!,
        engines.slice(1),
        { minShardElements: MIN_SHARD_ELEMENTS },
      );
      const request = cardinalityRequest(wasm, clientValues);
      await expect(engine.processClientRequest(request)).rejects.toThrow(
        "starter protocol error: the partner's PSI request ran the " +
          `library's cardinality mode, where this exchange runs ${wrapperMode}`,
      );
      for (const each of engines)
        expect(each.processClientRequest).not.toHaveBeenCalled();
    },
  );

  test("a stop reaches every engine", () => {
    const engines = [fakeEngine(false), fakeEngine(true), fakeEngine(false)];
    const engine = new ShardedPsiEngine(
      wasm,
      "joiner",
      "identifier-revealing",
      engines[0]!,
      engines.slice(1),
    );
    expect(engine.stopInFlight()).toBe(true);
    for (const each of engines)
      expect(each.stopInFlight).toHaveBeenCalledOnce();
  });

  test("dispose reaches every engine once, past one that throws", () => {
    const failing = fakeEngine();
    failing.dispose.mockImplementation(() => {
      throw new Error("dispose failed");
    });
    const engines = [fakeEngine(), failing, fakeEngine()];
    const engine = new ShardedPsiEngine(
      wasm,
      "joiner",
      "identifier-revealing",
      engines[0]!,
      engines.slice(1),
    );
    expect(() => engine.dispose()).toThrow("dispose failed");
    engine.dispose();
    for (const each of engines) expect(each.dispose).toHaveBeenCalledOnce();
  });
});

describe("helpers built from the primary's copied key", () => {
  test.for<["starter" | "joiner", PsiEngineMode]>([
    ["joiner", "identifier-revealing"],
    ["joiner", "count-only-permuted"],
    ["starter", "identifier-revealing"],
  ])(
    "a %s in %s mode puts the primary's own bytes on the wire",
    async ([role, mode]) => {
      // The count-only-permuted mode takes distinct values.
      const values =
        mode === "count-only-permuted" ? serverValues : clientValues;
      const primary = new InProcessPsiEngine(wasm, role, role, mode);
      const helpers = [1, 2].map(
        () =>
          new InProcessPsiEngine(wasm, role, role, shardHelperMode(mode), {
            secretKey: primary.copySecretKey(),
          }),
      );
      const single = new InProcessPsiEngine(wasm, role, role, mode, {
        secretKey: primary.copySecretKey(),
      });
      const partner = keyedEngine(wasm, "joiner", mode);
      const sharded = new ShardedPsiEngine(wasm, role, mode, primary, helpers, {
        minShardElements: MIN_SHARD_ELEMENTS,
      });
      try {
        if (role === "joiner")
          expect(await sharded.createClientRequest(values)).toEqual(
            await single.createClientRequest(values),
          );
        else {
          const request = await partner.createClientRequest(values);
          expect(await sharded.processClientRequest(request)).toEqual(
            await single.processClientRequest(request),
          );
        }
      } finally {
        for (const engine of [sharded, single, partner]) engine.dispose();
      }
    },
  );

  test("each copy is its own buffer, and a disposed engine refuses one", () => {
    const engine = new InProcessPsiEngine(
      wasm,
      "joiner",
      "joiner",
      "identifier-revealing",
    );
    const first = engine.copySecretKey();
    const second = engine.copySecretKey();
    expect(first.byteLength).toBe(32);
    expect(first.buffer).not.toBe(second.buffer);
    expect(first).toEqual(second);
    engine.dispose();
    expect(() => engine.copySecretKey()).toThrow(/holds no secret key/);
  });
});

describe("the shard progress timeout", () => {
  const TIMEOUT_MS = 60_000;

  function pendingEngine(): FakeEngine & { finish: () => void } {
    const engine = fakeEngine() as FakeEngine & { finish: () => void };
    engine.createClientRequest.mockReturnValue(
      new Promise<Uint8Array>((resolve) => {
        engine.finish = () => resolve(new wasm.request().serializeBinary());
      }),
    );
    return engine;
  }

  test("a shard silent past the timeout fails the split at once", async () => {
    vi.useFakeTimers();
    try {
      const primary = pendingEngine();
      const helper = pendingEngine();
      const engine = new ShardedPsiEngine(
        wasm,
        "joiner",
        "identifier-revealing",
        primary,
        [helper],
        { minShardElements: 1, shardProgressTimeoutMs: TIMEOUT_MS },
      );
      const outcome = engine.createClientRequest(["a", "b"]).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      primary.report?.(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toEqual(
        new Error(
          "Encrypting the data made no progress for 1 minute. Run the exchange again.",
        ),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("ticks keep a shard's timeout from expiring, and a settled split leaves no timer", async () => {
    vi.useFakeTimers();
    try {
      const primary = pendingEngine();
      const helper = pendingEngine();
      const engine = new ShardedPsiEngine(
        wasm,
        "joiner",
        "identifier-revealing",
        primary,
        [helper],
        { minShardElements: 1, shardProgressTimeoutMs: TIMEOUT_MS },
      );
      const done = engine.createClientRequest(["a", "b"]);
      for (let tick = 1; tick <= 5; tick += 1) {
        await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
        primary.report?.(tick);
        helper.report?.(tick);
      }
      primary.finish();
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      helper.finish();
      await expect(done).resolves.toBeInstanceOf(Uint8Array);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a shard that settles restarts the timeouts of the shards still running", async () => {
    vi.useFakeTimers();
    try {
      const primary = pendingEngine();
      const helper = pendingEngine();
      const engine = new ShardedPsiEngine(
        wasm,
        "joiner",
        "identifier-revealing",
        primary,
        [helper],
        { minShardElements: 1, shardProgressTimeoutMs: TIMEOUT_MS },
      );
      const outcome = engine.createClientRequest(["a", "b"]).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      primary.finish();
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toEqual(shardStalledError(TIMEOUT_MS));
    } finally {
      vi.useRealTimers();
    }
  });

  test("the message states a timeout that is not whole minutes in seconds", () => {
    expect(shardStalledError(90_000).message).toBe(
      "Encrypting the data made no progress for 90 seconds. Run the exchange again.",
    );
  });
});

type FakeEngine = PsiEngine & {
  processClientRequest: Mock<(requestBytes: Uint8Array) => Promise<Uint8Array>>;
  createClientRequest: Mock<
    (values: ReadonlyArray<string>) => Promise<Uint8Array>
  >;
  stopInFlight: Mock<() => boolean>;
  dispose: Mock<() => void>;
  report?: (processed: number) => void;
};

function fakeEngine(stops = false): FakeEngine {
  const refuse = (): Promise<never> =>
    Promise.reject(new Error("not expected in this test"));
  const engine: FakeEngine = {
    createServerSetup: refuse,
    processClientRequest: vi.fn(refuse),
    createClientRequest: vi.fn(refuse),
    receiveServerSetup: refuse,
    receiveServerSetupPiece: refuse,
    completeServerSetup: refuse,
    discardServerSetup: refuse,
    computeAssociationTable: refuse,
    createPermutedSetup: refuse,
    receiveIndexTable: refuse,
    matchPermutedRound: refuse,
    finishPermutedCount: refuse,
    observeProcessedElements: (report) => {
      engine.report = report;
    },
    stopInFlight: vi.fn(() => stops),
    dispose: vi.fn<() => void>(),
  };
  return engine;
}
