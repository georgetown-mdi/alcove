import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import { ShardedPsiEngine } from "../../src/psi/shardedPsiEngine";
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
    // Three shards of 66, 67 and 67: each finished shard adds its range while
    // another still runs, and the last one's finish is the settle report's.
    expect(reported).toStrictEqual([66, 133]);
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
