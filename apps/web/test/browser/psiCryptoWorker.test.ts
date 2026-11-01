/// <reference types="@vitest/browser-playwright/context" />

import { describe, expect, test } from "vitest";

import {
  InProcessPsiEngine,
  classifyFailure,
  isPartnerProtocolRefusal,
  psiEngineOptionsForBackend,
} from "@alcove/core";
import { ProtocolRefusalError } from "@alcove/core/testing";
// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import {
  createBrowserPsiEngineFactory,
  createPsiCryptoWorkerHandle,
  encodePsiWorkerInit,
} from "@psi/workers/psiCryptoController";
import { defaultSpawnPsiCryptoWorker } from "@psi/workers/psiCryptoWorkerClient";
import { failureFor } from "@exchange/useInviterExchange";
import { startPsiWorkerPool } from "@psi/workers/psiWorkerPool";

import { SEEDED_JOINER_KEY, SEEDED_STARTER_KEY } from "./seededPsiKeys";

import type {
  PsiCryptoWorker,
  SpawnPsiCryptoWorker,
} from "@psi/workers/psiCryptoController";
import type { PsiEngine, PsiEngineMode } from "@alcove/core";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

// The browser PSI crypto offload, exercised against the REAL Vite-native worker
// running the REAL WASM engine in a real browser. The host-side
// dispatch plumbing (reply routing, fault handling, dispose ordering) is pinned in
// Node with a fake worker (test/unit/psi/psiCryptoController.test.ts); this closes the gap
// end to end -- that the actual worker module, constructed via `new Worker(new
// URL(...))` and loading `@openmined/psi.js/psi_wasm_worker`, runs the masking
// correctly (byte-identical intersection) AND tears down cleanly on every terminal
// path -- which only a real Worker + real WASM can prove.

// The starter's and joiner's value lists; the overlap is {charlie, delta}, so the
// joiner learns those two of its own values matched and nothing else.
const STARTER_VALUES = ["alpha", "bravo", "charlie", "delta"];
const JOINER_VALUES = ["charlie", "delta", "echo", "foxtrot"];
const EXPECTED_MATCH_VALUES = new Set(["charlie", "delta"]);

// A spawner that wraps the real one and counts terminate() calls per worker, so a test
// can assert the worker was actually torn down (a real Web Worker fires no event on
// terminate, so its disposal is otherwise unobservable). Wraps `terminate` in place on
// the real worker rather than proxying the whole object, so the host handle still sets
// onmessage/onerror on -- and posts to -- the genuine worker.
function trackingSpawner(): {
  spawn: SpawnPsiCryptoWorker;
  terminations: () => number;
} {
  let terminations = 0;
  const spawn: SpawnPsiCryptoWorker = (init) => {
    const worker: PsiCryptoWorker = defaultSpawnPsiCryptoWorker(init);
    const realTerminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      terminations += 1;
      realTerminate();
    };
    return worker;
  };
  return { spawn, terminations: () => terminations };
}

// Drive the full engine round-trip in the participant's order and return the joiner's
// association table [localIndices, partnerIndices].
async function runRoundTrip(
  starter: PsiEngine,
  joiner: PsiEngine,
): Promise<[Array<number>, Array<number>]> {
  const { setup } = await starter.createServerSetup(STARTER_VALUES);
  await joiner.receiveServerSetup(setup);
  const request = await joiner.createClientRequest(JOINER_VALUES);
  const response = await starter.processClientRequest(request);
  return joiner.computeAssociationTable(response);
}

describe("PSI crypto Web Worker (real Vite-native worker, real WASM)", () => {
  test("the exchange completes correctly with the worker in place", async () => {
    const { spawn, terminations } = trackingSpawner();
    const factory = createBrowserPsiEngineFactory(spawn);
    const starter = factory("starter", "server", "identifier-revealing");
    const joiner = factory("joiner", "client", "identifier-revealing");

    let table: [Array<number>, Array<number>];
    try {
      table = await runRoundTrip(starter, joiner);
    } finally {
      starter.dispose();
      joiner.dispose();
    }

    // The real workers found exactly the overlap. table[0] indexes the joiner's own
    // request values (request order preserves input order, so it is key- and
    // backend-independent, unlike the partner index in table[1], which comes back in
    // the setup's key-dependent sorted order), so mapping those indices back to values
    // recovers the deterministic ground truth.
    expect(table[0]).toHaveLength(EXPECTED_MATCH_VALUES.size);
    expect(table[1]).toHaveLength(EXPECTED_MATCH_VALUES.size);
    const matchedJoinerValues = new Set(
      table[0].map((index) => JOINER_VALUES[index]),
    );
    expect(matchedJoinerValues).toEqual(EXPECTED_MATCH_VALUES);

    // Both workers were torn down by dispose() -- no leak past the exchange.
    expect(terminations()).toBe(2);
  }, 30_000);

  test("a partner setup out of ascending order is refused in the worker as the partner's", async () => {
    const factory = createBrowserPsiEngineFactory(trackingSpawner().spawn);
    const starter = factory("starter", "server", "identifier-revealing");
    const joiner = factory("joiner", "client", "identifier-revealing");
    let refused: unknown;
    try {
      const psi = await (PSI() as Promise<PSILibrary>);
      const { setup } = await starter.createServerSetup(STARTER_VALUES);
      const elements = [
        ...psi.serverSetup
          .deserializeBinary(setup)
          .getRaw()!
          .getEncryptedElementsList_asU8(),
      ];
      [elements[0], elements[1]] = [elements[1], elements[0]];
      const raw = new psi.serverSetup.RawInfo();
      raw.setEncryptedElementsList(elements);
      const swapped = new psi.serverSetup();
      swapped.setRaw(raw);
      refused = await joiner.receiveServerSetup(swapped.serializeBinary()).then(
        () => undefined,
        (error: unknown) => error,
      );
    } finally {
      starter.dispose();
      joiner.dispose();
    }

    expect(refused).toBeInstanceOf(ProtocolRefusalError);
    expect((refused as Error).message).toBe(
      "client protocol error: PSI server setup is not in strictly ascending element order",
    );
    expect(classifyFailure(refused)).toBe("partner-refused");
    expect(isPartnerProtocolRefusal(refused)).toBe(true);
    expect(failureFor("exchange", refused)).toMatchObject({
      category: "config",
      retry: "withheld",
    });
  }, 30_000);

  test("terminating the worker mid-call fires no event on the host handle", async () => {
    const events: Array<string> = [];
    const handle = createPsiCryptoWorkerHandle(
      defaultSpawnPsiCryptoWorker({
        role: "starter",
        id: "server",
        mode: "identifier-revealing",
        shard: "primary",
        helpers: 0,
      }),
    );
    handle.setHandlers({
      onMessage: (response) => events.push(`message ${response.id}`),
      onError: (error) => events.push(`error ${error.message}`),
    });

    // One answered call shows the handlers are live before the terminate.
    handle.postMessage({
      id: 1,
      body: { method: "createServerSetup", values: STARTER_VALUES },
    });
    await expect
      .poll(() => events, { timeout: 20_000 })
      .toContainEqual(expect.stringMatching(/^message 1$/));
    const answered = events.length;

    handle.postMessage({
      id: 2,
      body: { method: "createServerSetup", values: STARTER_VALUES },
    });
    handle.terminate();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(events).toHaveLength(answered);
  }, 30_000);

  // The acceptance criterion: the worker is torn down on every exchange-end path.
  // runExchange funnels success, error, and abort through the participant's dispose()
  // in its finally; at the engine boundary each is dispose() after that prior state.
  describe("the worker is torn down on each terminal path", () => {
    test("success: after a completed crypto call", async () => {
      const { spawn, terminations } = trackingSpawner();
      const engine = createBrowserPsiEngineFactory(spawn)(
        "starter",
        "server",
        "identifier-revealing",
      );
      const { setup } = await engine.createServerSetup(STARTER_VALUES);
      expect(setup.byteLength).toBeGreaterThan(0);
      engine.dispose();
      expect(terminations()).toBe(1);
    }, 30_000);

    test("error: after a crypto call the worker rejects", async () => {
      const { spawn, terminations } = trackingSpawner();
      const engine = createBrowserPsiEngineFactory(spawn)(
        "joiner",
        "client",
        "identifier-revealing",
      );
      // A role-guard violation (a joiner has no server key) rejects inside the worker
      // and shows up as a rejected call over the boundary -- the error terminal path.
      await expect(
        engine.processClientRequest(new Uint8Array()),
      ).rejects.toThrow(/server role/);
      engine.dispose();
      expect(terminations()).toBe(1);
    }, 30_000);

    test("abort: while a crypto call is still in flight", async () => {
      const { spawn, terminations } = trackingSpawner();
      const engine = createBrowserPsiEngineFactory(spawn)(
        "starter",
        "server",
        "identifier-revealing",
      );
      // Post a masking op and, without awaiting it, dispose the engine (an exchange
      // aborted mid-round): the outstanding call must reject and the worker terminate,
      // never leave the call hanging on a torn-down worker.
      const pending = engine.createServerSetup(STARTER_VALUES);
      engine.dispose();
      await expect(pending).rejects.toThrow(/disposed/);
      expect(terminations()).toBe(1);
    }, 30_000);
  });
});

// The pool's split masking against one engine under the same key, over real
// workers. The pool's workers run a test-only entry whose new keys are seeded
// (./seededKeyPsiCrypto.worker.ts), so the reference is an engine on this
// page built from the seeded key, and the page sends a helper no request.
describe("the PSI worker pool (real workers, real WASM)", () => {
  // Each case's masking is CPU time that stretches with the machine's load,
  // so the sets are the smallest that test the split. The joiner's is the
  // fewest that split three ways at core's 1024 elements a shard, plus one
  // so the shards are uneven. No split operation reads the starter's set,
  // so it is small.
  const POOL_VALUES = Array.from({ length: 3 * 1024 + 1 }, (_, i) => `v-${i}`);
  const SHARED_INDICES = POOL_VALUES.flatMap((_, i) =>
    i % 64 === 0 ? [i] : [],
  );
  const STARTER_POOL_VALUES = SHARED_INDICES.flatMap((i) => [
    POOL_VALUES[i],
    `starter-only-${i}`,
  ]);

  // Compared in place of the bytes: a mismatch between two messages this
  // large otherwise hangs the run in the diff of its failure report.
  async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    );
    return Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  // Records each split word the page posts a primary, which says split only
  // once every helper has set up.
  function seededKeyPool(
    role: "starter" | "joiner",
    id: string,
    mode: PsiEngineMode,
    splits: Array<boolean>,
  ): PsiEngine {
    const spawn: SpawnPsiCryptoWorker = (seed) => {
      const worker = new Worker(
        new URL("./seededKeyPsiCrypto.worker.ts", import.meta.url),
        { type: "module", name: encodePsiWorkerInit(seed) },
      ) as unknown as PsiCryptoWorker;
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer) => {
        if ("kind" in message && message.kind === "shard-split")
          splits.push(message.split);
        post(message, transfer);
      };
      return worker;
    };
    return startPsiWorkerPool(spawn, role, id, mode, 3, 60_000);
  }

  test.for<PsiEngineMode>(["identifier-revealing"])(
    "a %s round across three workers puts one engine's bytes on the wire",
    // 1.5x the slowest case measured at a load average of 50 to 60 on 10
    // cores, 50.6 s; the same case takes about 6 s on an idle machine.
    { timeout: 76_000 },
    async (mode) => {
      const psi = await (PSI() as Promise<PSILibrary>);
      const options = psiEngineOptionsForBackend("wasm");
      const splits: Array<boolean> = [];
      const joiner = seededKeyPool("joiner", "client", mode, splits);
      const starter = seededKeyPool("starter", "server", mode, splits);
      const joinerReference = new InProcessPsiEngine(
        psi,
        "joiner",
        "client",
        mode,
        { ...options, secretKey: Uint8Array.from(SEEDED_JOINER_KEY) },
      );
      const starterReference = new InProcessPsiEngine(
        psi,
        "starter",
        "server",
        mode,
        { ...options, secretKey: Uint8Array.from(SEEDED_STARTER_KEY) },
      );
      const engines = [joiner, starter, joinerReference, starterReference];
      try {
        const { setup } = await starter.createServerSetup(STARTER_POOL_VALUES);
        await joiner.receiveServerSetup(setup);
        const request = await joiner.createClientRequest(POOL_VALUES);
        expect(await sha256Hex(request)).toBe(
          await sha256Hex(
            await joinerReference.createClientRequest(POOL_VALUES),
          ),
        );
        const response = await starter.processClientRequest(request);
        expect(await sha256Hex(response)).toBe(
          await sha256Hex(await starterReference.processClientRequest(request)),
        );
        expect(splits).toEqual([true, true]);
        const [local] = await joiner.computeAssociationTable(response);
        expect([...local].sort((a, b) => a - b)).toEqual(SHARED_INDICES);
      } finally {
        for (const engine of engines) engine.dispose();
      }
    },
  );
});
