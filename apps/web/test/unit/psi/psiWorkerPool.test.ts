import { describe, expect, test, vi } from "vitest";

import { InProcessPsiEngine } from "@alcove/core";
import PSI from "@openmined/psi.js";

import { encodePsiWorkerInit } from "../../../src/psi/workers/psiCryptoController.js";
import { runPsiCryptoWorker } from "../../../src/psi/workers/psiCryptoWorkerProgram.js";
import { startPsiWorkerPool } from "../../../src/psi/workers/psiWorkerPool.js";

import type {
  PsiEngine,
  PsiEngineMode,
  PsiWorkerRequest,
  PsiWorkerResponse,
} from "@alcove/core";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type {
  LoadPsiWorkerLibrary,
  PsiCryptoWorkerScope,
} from "../../../src/psi/workers/psiCryptoWorkerProgram.js";
import type {
  PsiCryptoWorker,
  PsiCryptoWorkerSeed,
  PsiHelperSetupReport,
  PsiKeyPortsMessage,
  SpawnPsiCryptoWorker,
} from "../../../src/psi/workers/psiCryptoController.js";

// The worker pool's key path and failure rules. The worker program runs in
// process over real MessageChannels, on the real WASM engine, so the key's
// whole route is observable: what the page posts, what reaches the page, and
// the key each helper's engine is built from. A real Worker in real Chromium
// runs the same path in test/browser/psiCryptoWorker.test.ts.

const wasm = await PSI();

const KEY = new Uint8Array(32).fill(0x37);
KEY[0] = 0x00;
const TIMEOUT_MS = 60_000;
const EMPTY_REQUEST = new wasm.request().serializeBinary();

const values = (count: number): Array<string> =>
  Array.from({ length: count }, (_, index) => `value-${index}`);
const kindOf = (message: unknown): string | undefined =>
  (message as { kind?: string }).kind;

function joinerPool(
  spawn: SpawnPsiCryptoWorker,
  mode: PsiEngineMode,
  workers: number,
): PsiEngine {
  return startPsiWorkerPool(
    spawn,
    wasm,
    "joiner",
    "client",
    mode,
    workers,
    TIMEOUT_MS,
  );
}

function engineUnderKey(mode: PsiEngineMode): InProcessPsiEngine {
  return new InProcessPsiEngine(wasm, "joiner", "client", mode, {
    secretKey: KEY,
  });
}

interface KeyLog {
  generated: number;
  given: Array<Uint8Array>;
}

// The real engine, with the generated key fixed to KEY so the test can build
// an engine under it, and every key an engine is built from recorded.
function keyLoggingLibrary(log: KeyLog): PSILibrary {
  const wrap = <
    TSide extends {
      createWithNewKey: (reveal?: boolean) => unknown;
      createFromKey: (key: Uint8Array, reveal?: boolean) => unknown;
    },
  >(
    side: TSide,
  ): TSide => ({
    ...side,
    createWithNewKey: (reveal?: boolean) => {
      log.generated += 1;
      return side.createFromKey(KEY, reveal);
    },
    createFromKey: (key: Uint8Array, reveal?: boolean) => {
      log.given.push(Uint8Array.from(key));
      return side.createFromKey(key, reveal);
    },
  });
  return { ...wasm, server: wrap(wasm.server!), client: wrap(wasm.client!) };
}

interface InProcessWorker extends PsiCryptoWorker {
  readonly seed: PsiCryptoWorkerSeed;
  terminated: boolean;
}

// Spawns the worker program in process: each message crosses as a later task,
// as a worker's does, and is recorded on the way.
function inProcessSpawner(
  load: (seed: PsiCryptoWorkerSeed) => LoadPsiWorkerLibrary,
): {
  spawn: SpawnPsiCryptoWorker;
  workers: Array<InProcessWorker>;
  toPage: Array<unknown>;
  toWorkers: Array<unknown>;
} {
  const workers: Array<InProcessWorker> = [];
  const toPage: Array<unknown> = [];
  const toWorkers: Array<unknown> = [];
  const spawn: SpawnPsiCryptoWorker = (seed) => {
    const worker: InProcessWorker = {
      seed,
      terminated: false,
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: (message) => {
        toWorkers.push(message);
        setTimeout(() => {
          if (!worker.terminated) scope.onmessage?.({ data: message });
        });
      },
      terminate: () => {
        worker.terminated = true;
      },
    };
    const scope: PsiCryptoWorkerScope = {
      name: encodePsiWorkerInit(seed),
      onmessage: null,
      postMessage: (message) => {
        toPage.push(message);
        setTimeout(() => {
          if (!worker.terminated) worker.onmessage?.({ data: message });
        });
      },
    };
    runPsiCryptoWorker(scope, load(seed));
    workers.push(worker);
    return worker;
  };
  return { spawn, workers, toPage, toWorkers };
}

function holdsKey(value: unknown): boolean {
  if (value instanceof Uint8Array)
    return value.length === KEY.length && value.every((b, i) => b === KEY[i]);
  if (typeof value !== "object" || value === null) return false;
  if (value instanceof MessagePort) return false;
  return Object.values(value).some(holdsKey);
}

describe("the PSI worker pool's key path", () => {
  test("the primary's key reaches each helper over the channels the page connects, never through the page", async () => {
    const log: KeyLog = { generated: 0, given: [] };
    const library = keyLoggingLibrary(log);
    const { spawn, workers, toPage, toWorkers } = inProcessSpawner(
      () => () => Promise.resolve({ library, backend: "wasm" }),
    );
    const pool = joinerPool(spawn, "identifier-revealing", 3);
    const single = engineUnderKey("identifier-revealing");
    try {
      expect(await pool.createClientRequest(values(3072))).toEqual(
        await single.createClientRequest(values(3072)),
      );
    } finally {
      pool.dispose();
      single.dispose();
    }

    expect(workers.map((worker) => worker.seed.shard)).toEqual([
      "primary",
      "helper",
      "helper",
    ]);
    expect(log.generated).toBe(1);
    expect(log.given).toEqual([KEY, KEY]);
    const portCounts = toWorkers
      .filter((message) => kindOf(message) === "key-ports")
      .map((message) => (message as PsiKeyPortsMessage).ports.length);
    expect(portCounts).toEqual([1, 1, 2]);
    expect(toWorkers.some(holdsKey)).toBe(false);
    expect(toPage.some(holdsKey)).toBe(false);
    expect(
      toPage.filter((message) => kindOf(message) === "helper-setup"),
    ).toEqual([
      { kind: "helper-setup", ready: true },
      { kind: "helper-setup", ready: true },
    ]);
  }, 30_000);

  test.for([
    ["a value that is not a key", ["not a key"]],
    ["two key ports", [KEY, KEY]],
  ] as const)(
    "a helper given %s refuses its setup and every request, and generates no key",
    async ([, sent]) => {
      const log: KeyLog = { generated: 0, given: [] };
      const library = keyLoggingLibrary(log);
      const posted: Array<PsiWorkerResponse | PsiHelperSetupReport> = [];
      const scope: PsiCryptoWorkerScope = {
        name: encodePsiWorkerInit({
          role: "joiner",
          id: "client",
          mode: "identifier-revealing",
          shard: "helper",
        }),
        onmessage: null,
        postMessage: (message) => posted.push(message),
      };
      runPsiCryptoWorker(scope, () =>
        Promise.resolve({ library, backend: "wasm" }),
      );
      const channels = sent.map(() => new MessageChannel());
      const ports = channels.map((channel) => channel.port2);
      scope.onmessage?.({ data: { kind: "key-ports", ports } });
      channels.forEach((channel, index) => {
        channel.port1.postMessage(sent[index]);
        channel.port1.close();
      });
      const request: PsiWorkerRequest = {
        id: 7,
        body: { method: "createClientRequest", values: ["a"] },
      };
      scope.onmessage?.({ data: request });
      await vi.waitFor(() => expect(posted).toHaveLength(2));
      expect(posted[0]).toEqual({ kind: "helper-setup", ready: false });
      expect(posted[1]).toMatchObject({
        id: 7,
        ok: false,
        error: "the PSI helper worker received no key",
      });
      expect(log.generated).toBe(0);
    },
  );

  test("a helper whose setup fails leaves the run on the primary and its worker stops", async () => {
    const library = keyLoggingLibrary({ generated: 0, given: [] });
    const { spawn, workers } = inProcessSpawner((seed) =>
      seed.shard === "helper"
        ? () => Promise.reject(new Error("the engine failed to load"))
        : () => Promise.resolve({ library, backend: "wasm" }),
    );
    const pool = joinerPool(spawn, "count-only", 2);
    const single = engineUnderKey("count-only");
    try {
      expect(await pool.createClientRequest(values(2048))).toEqual(
        await single.createClientRequest(values(2048)),
      );
      expect(workers.map((worker) => worker.terminated)).toEqual([false, true]);
    } finally {
      pool.dispose();
      single.dispose();
    }
  }, 30_000);
});

// A worker the test answers by hand.
class FakeWorker implements PsiCryptoWorker {
  onmessage:
    | ((event: { data: PsiWorkerResponse | PsiHelperSetupReport }) => void)
    | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly requests: Array<PsiWorkerRequest> = [];
  readonly keyPorts: Array<PsiKeyPortsMessage> = [];
  terminated = false;

  constructor(readonly seed: PsiCryptoWorkerSeed) {}

  postMessage(message: PsiWorkerRequest | PsiKeyPortsMessage): void {
    if ("kind" in message) this.keyPorts.push(message);
    else this.requests.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  send(data: PsiWorkerResponse | PsiHelperSetupReport): void {
    this.onmessage?.({ data });
  }

  answer(result: unknown): void {
    this.send({ id: this.requests.at(-1)!.id, ok: true, result });
  }
}

function fakeSpawner(): {
  spawn: SpawnPsiCryptoWorker;
  workers: Array<FakeWorker>;
} {
  const workers: Array<FakeWorker> = [];
  const spawn: SpawnPsiCryptoWorker = (seed) => {
    const worker = new FakeWorker(seed);
    workers.push(worker);
    return worker;
  };
  return { spawn, workers };
}

describe("the PSI worker pool's shards", () => {
  test("ticks from every shard report one running total", async () => {
    const { spawn, workers } = fakeSpawner();
    const pool = joinerPool(spawn, "identifier-revealing", 2);
    const reported: Array<number> = [];
    pool.observeProcessedElements?.((processed) => reported.push(processed));
    const [primary, helper] = workers as [FakeWorker, FakeWorker];
    helper.send({ kind: "helper-setup", ready: true });
    const done = pool.createClientRequest(values(2048));
    await vi.waitFor(() => expect(helper.requests).toHaveLength(1));
    primary.send({ id: primary.requests[0].id, processed: 300 });
    helper.send({ id: helper.requests[0].id, processed: 200 });
    primary.answer(EMPTY_REQUEST);
    helper.answer(EMPTY_REQUEST);
    await done;
    pool.dispose();
    expect(reported).toEqual([300, 500, 1224]);
  });

  test("a helper that fails mid-round fails the operation at once, and nothing is respawned", async () => {
    const { spawn, workers } = fakeSpawner();
    const pool = joinerPool(spawn, "identifier-revealing", 3);
    for (const helper of workers.slice(1))
      helper.send({ kind: "helper-setup", ready: true });
    const outcome = pool.createClientRequest(values(3072)).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(workers[2].requests).toHaveLength(1));
    workers[2].onerror?.({ message: "worker faulted" });
    expect(await outcome).toEqual(new Error("worker faulted"));
    expect(workers).toHaveLength(3);
    pool.dispose();
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  test("a helper whose setup never reports is left out once the progress timeout passes", async () => {
    vi.useFakeTimers();
    try {
      const { spawn, workers } = fakeSpawner();
      const pool = joinerPool(spawn, "identifier-revealing", 2);
      const [primary, helper] = workers as [FakeWorker, FakeWorker];
      const done = pool.createClientRequest(values(2048));
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect(helper.terminated).toBe(true);
      expect(helper.requests).toHaveLength(0);
      expect(primary.requests[0]?.body).toEqual({
        method: "createClientRequest",
        values: values(2048),
      });
      primary.answer(EMPTY_REQUEST);
      await expect(done).resolves.toEqual(EMPTY_REQUEST);
      pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
