import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import {
  ShardedPsiEngine,
  shardStalledError,
} from "../../src/psi/shardedPsiEngine";
import { fixedKeyPsiLibrary, psiTestKey } from "../utils/fixedKeyPsiLibrary";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";

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
): ShardedPsiEngine {
  return new ShardedPsiEngine(
    library,
    role,
    mode,
    keyedEngine(library, role, mode),
    Array.from({ length: engines - 1 }, () => keyedEngine(library, role, mode)),
    { minShardElements: MIN_SHARD_ELEMENTS },
  );
}

describe.each([
  ["wasm", wasm],
  ["native addon", native],
])("the %s backend", (_name, library) => {
  describe.each<PsiEngineMode>(["identifier-revealing", "count-only"])(
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
            if (mode === "identifier-revealing")
              expect(
                await sharded.joiner.computeAssociationTable(response),
              ).toStrictEqual(
                await single.joiner.computeAssociationTable(response),
              );
            else
              expect(
                await sharded.joiner.computeIntersectionCardinality(response),
              ).toBe(
                await single.joiner.computeIntersectionCardinality(response),
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

  test("a partner request in the other mode is refused as one engine refuses it", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    const joiner = keyedEngine(library, "joiner", "identifier-revealing");
    const single = keyedEngine(library, "starter", "count-only");
    const sharded = shardedEngine(library, "starter", "count-only", 3);
    try {
      const request = await joiner.createClientRequest(clientValues);
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
      joiner.dispose();
      single.dispose();
      sharded.dispose();
    }
  });
});

describe.each([
  ["wasm", wasm],
  ["native addon", native],
])("the %s backend over a five-way count-only split", (_name, library) => {
  // Four values the count-only filter drops leave 196 elements, so a floor of
  // 30 admits six shards and the five engines bound the split at five.
  const FIVE_WAY_MIN_SHARD_ELEMENTS = 30;

  test("uses all five engines and puts one engine's bytes on the wire", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    const mode: PsiEngineMode = "count-only";
    const single = {
      starter: keyedEngine(library, "starter", mode),
      joiner: keyedEngine(library, "joiner", mode),
    };
    const shards = {
      starter: Array.from({ length: 5 }, () =>
        keyedEngine(library, "starter", mode),
      ),
      joiner: Array.from({ length: 5 }, () =>
        keyedEngine(library, "joiner", mode),
      ),
    };
    const requestCalls = shards.joiner.map((engine) => {
      const counted = vi.fn(engine.createClientRequest.bind(engine));
      engine.createClientRequest = counted;
      return counted;
    });
    const responseCalls = shards.starter.map((engine) => {
      const counted = vi.fn(engine.processClientRequest.bind(engine));
      engine.processClientRequest = counted;
      return counted;
    });
    const sharded = {
      starter: new ShardedPsiEngine(
        library,
        "starter",
        mode,
        shards.starter[0]!,
        shards.starter.slice(1),
        { minShardElements: FIVE_WAY_MIN_SHARD_ELEMENTS },
      ),
      joiner: new ShardedPsiEngine(
        library,
        "joiner",
        mode,
        shards.joiner[0]!,
        shards.joiner.slice(1),
        { minShardElements: FIVE_WAY_MIN_SHARD_ELEMENTS },
      ),
    };
    try {
      const request = await single.joiner.createClientRequest(clientValues);
      expect(await sharded.joiner.createClientRequest(clientValues)).toEqual(
        request,
      );
      for (const calls of requestCalls) expect(calls).toHaveBeenCalledOnce();

      const response = await single.starter.processClientRequest(request);
      expect(await sharded.starter.processClientRequest(request)).toEqual(
        response,
      );
      for (const calls of responseCalls) expect(calls).toHaveBeenCalledOnce();
    } finally {
      for (const engine of [
        single.starter,
        single.joiner,
        sharded.starter,
        sharded.joiner,
      ])
        engine.dispose();
    }
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

  test.for<[PsiEngineMode, PsiEngineMode]>([
    ["count-only", "identifier-revealing"],
    ["identifier-revealing", "count-only"],
  ])(
    "a wrapper in %s mode refuses a request in %s mode before any engine sees it",
    async ([wrapperMode, requestMode]) => {
      const joiner = keyedEngine(wasm, "joiner", requestMode);
      const engines = [fakeEngine(), fakeEngine(), fakeEngine()];
      const engine = new ShardedPsiEngine(
        wasm,
        "starter",
        wrapperMode,
        engines[0]!,
        engines.slice(1),
        { minShardElements: MIN_SHARD_ELEMENTS },
      );
      try {
        const request = await joiner.createClientRequest(clientValues);
        await expect(engine.processClientRequest(request)).rejects.toThrow(
          "starter protocol error: the partner's PSI request ran the " +
            `${requestMode} mode, where this exchange runs ${wrapperMode}`,
        );
        for (const each of engines)
          expect(each.processClientRequest).not.toHaveBeenCalled();
      } finally {
        joiner.dispose();
      }
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
    ["joiner", "count-only"],
    ["starter", "identifier-revealing"],
    ["starter", "count-only"],
  ])(
    "a %s in %s mode puts the primary's own bytes on the wire",
    async ([role, mode]) => {
      const primary = new InProcessPsiEngine(wasm, role, role, mode);
      const helpers = [1, 2].map(
        () =>
          new InProcessPsiEngine(wasm, role, role, mode, {
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
          expect(await sharded.createClientRequest(clientValues)).toEqual(
            await single.createClientRequest(clientValues),
          );
        else {
          const request = await partner.createClientRequest(clientValues);
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
    computeIntersectionCardinality: refuse,
    observeProcessedElements: (report) => {
      engine.report = report;
    },
    stopInFlight: vi.fn(() => stops),
    dispose: vi.fn<() => void>(),
  };
  return engine;
}
