import { describe, expect, test, vi } from "vitest";

import {
  InProcessPsiEngine,
  InternalConsistencyError,
  shardStalledError,
} from "@alcove/core";
import PSI from "@openmined/psi.js";
import { PartnerProtocolRefusalError } from "@alcove/core/testing";

import {
  createBrowserPsiEngineFactory,
  encodePsiWorkerInit,
} from "../../../src/psi/workers/psiCryptoController.js";
import {
  createPooledBrowserPsiEngineFactory,
  startPsiWorkerPool,
} from "../../../src/psi/workers/psiWorkerPool.js";
import { runPsiCryptoWorker } from "../../../src/psi/workers/psiCryptoWorkerProgram.js";

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
  PsiShardSplitMessage,
  SpawnPsiCryptoWorker,
} from "../../../src/psi/workers/psiCryptoController.js";

// The worker pool's key path and failure rules. The worker program runs in
// process over real MessageChannels, on the real WASM engine, so the key's
// whole route is observable: what the page posts, what reaches the page, the
// key each helper's engine is built from, and the parts each engine masks. A
// real Worker in real Chromium runs the same path in
// test/browser/psiCryptoWorker.test.ts.

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

// The real engine under KEY, on which every copy of the key fails.
function keyCopyFailingLibrary(): PSILibrary {
  const client = wasm.client!;
  return {
    ...wasm,
    client: {
      ...client,
      createWithNewKey: (reveal?: boolean) => ({
        ...client.createFromKey(KEY, reveal),
        getPrivateKeyBytes: () => {
          throw new Error("the key could not be copied");
        },
      }),
    },
  };
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

  test("the primary splits across its helpers and merges their parts, so the page holds only the merged message", async () => {
    const library = keyLoggingLibrary({ generated: 0, given: [] });
    const { spawn, toPage } = inProcessSpawner(
      () => () => Promise.resolve({ library, backend: "wasm" }),
    );
    const pool = joinerPool(spawn, "identifier-revealing", 3);
    const single = engineUnderKey("identifier-revealing");
    try {
      const merged = await pool.createClientRequest(values(3072));
      expect(merged).toEqual(await single.createClientRequest(values(3072)));
      // Each settled part of 1,024 counts while another still runs.
      expect(
        toPage.flatMap((message) =>
          "processed" in (message as object)
            ? [(message as { processed: number }).processed]
            : [],
        ),
      ).toEqual([1024, 2048]);
      expect(toPage.filter((message) => "ok" in (message as object))).toEqual([
        { id: 0, ok: true, result: merged },
      ]);
    } finally {
      pool.dispose();
      single.dispose();
    }
  }, 30_000);

  test.for([
    ["a value that is not a key", ["not a key"]],
    ["the primary's refusal", [null]],
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

  test("a helper whose setup fails leaves the run on the primary, and every helper's worker stops", async () => {
    const library = keyLoggingLibrary({ generated: 0, given: [] });
    let helpersSpawned = 0;
    const { spawn, workers } = inProcessSpawner((seed) => {
      if (seed.shard === "helper" && ++helpersSpawned === 1)
        return () => Promise.reject(new Error("the engine failed to load"));
      return () => Promise.resolve({ library, backend: "wasm" });
    });
    const pool = joinerPool(spawn, "identifier-revealing", 3);
    const single = engineUnderKey("identifier-revealing");
    try {
      expect(await pool.createClientRequest(values(3072))).toEqual(
        await single.createClientRequest(values(3072)),
      );
      expect(workers.map((worker) => worker.terminated)).toEqual([
        false,
        true,
        true,
      ]);
    } finally {
      pool.dispose();
      single.dispose();
    }
  }, 30_000);

  test("a helper whose key copy fails reports a failed setup at once, and the run goes on the primary", async () => {
    const library = keyCopyFailingLibrary();
    const { spawn, workers, toPage } = inProcessSpawner(
      () => () => Promise.resolve({ library, backend: "wasm" }),
    );
    const pool = joinerPool(spawn, "identifier-revealing", 2);
    const single = engineUnderKey("identifier-revealing");
    try {
      await vi.waitFor(() =>
        expect(toPage).toContainEqual({ kind: "helper-setup", ready: false }),
      );
      expect(await pool.createClientRequest(values(2048))).toEqual(
        await single.createClientRequest(values(2048)),
      );
      expect(workers.map((worker) => worker.terminated)).toEqual([false, true]);
    } finally {
      pool.dispose();
      single.dispose();
    }
  }, 30_000);

  // TIMEOUT_MS, the pool's setup timeout, is longer than this test's own.
  test("a primary whose library load fails returns its error before the setup timeout, and every helper's worker stops", async () => {
    const library = keyLoggingLibrary({ generated: 0, given: [] });
    const { spawn, workers } = inProcessSpawner((seed) =>
      seed.shard === "primary"
        ? () => Promise.reject(new Error("the engine failed to load"))
        : () => Promise.resolve({ library, backend: "wasm" }),
    );
    const pool = joinerPool(spawn, "identifier-revealing", 3);
    try {
      await expect(pool.createClientRequest(values(3072))).rejects.toEqual(
        new Error("the engine failed to load"),
      );
      expect(workers.map((worker) => worker.terminated)).toEqual([
        false,
        true,
        true,
      ]);
    } finally {
      pool.dispose();
    }
  }, 10_000);

  // TIMEOUT_MS, the primary's progress timeout for each part, is longer than
  // this test's own.
  test("a helper's port that fails a delivery after setup fails the run at once", async () => {
    const library = keyLoggingLibrary({ generated: 0, given: [] });
    const { spawn, toPage, toWorkers } = inProcessSpawner(
      () => () => Promise.resolve({ library, backend: "wasm" }),
    );
    const pool = joinerPool(spawn, "identifier-revealing", 3);
    try {
      await vi.waitFor(() =>
        expect(
          toPage.filter((message) => kindOf(message) === "helper-setup"),
        ).toHaveLength(2),
      );
      const [helperPort] = (
        toWorkers.find(
          (message) => kindOf(message) === "key-ports",
        ) as PsiKeyPortsMessage
      ).ports;
      helperPort.dispatchEvent(new MessageEvent("messageerror"));
      await expect(pool.createClientRequest(values(3072))).rejects.toEqual(
        new Error("PSI crypto worker failed"),
      );
    } finally {
      pool.dispose();
    }
  }, 10_000);
});

const primarySeed = (helpers: number): string =>
  encodePsiWorkerInit({
    role: "joiner",
    id: "client",
    mode: "identifier-revealing",
    shard: "primary",
    helpers,
  });
const HELPER_SEED = encodePsiWorkerInit({
  role: "joiner",
  id: "client",
  mode: "identifier-revealing",
  shard: "helper",
});

const loadOf =
  (library: PSILibrary): LoadPsiWorkerLibrary =>
  () =>
    Promise.resolve({ library, backend: "wasm" });

// The worker program alone, in a scope the test drives by hand.
function runProgram(
  name: string,
  load: LoadPsiWorkerLibrary,
): {
  scope: PsiCryptoWorkerScope;
  posted: Array<PsiWorkerResponse | PsiHelperSetupReport>;
} {
  const posted: Array<PsiWorkerResponse | PsiHelperSetupReport> = [];
  const scope: PsiCryptoWorkerScope = {
    name,
    onmessage: null,
    postMessage: (message) => posted.push(message),
  };
  runPsiCryptoWorker(scope, load);
  return { scope, posted };
}

// A key port whose both sides the test holds, so it keeps the very array the
// program posts or receives, where a MessageChannel would copy or detach it.
class FakeKeyPort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly posted: Array<unknown> = [];
  readonly keysAsPosted: Array<Uint8Array> = [];

  constructor(private readonly throwsOn: "nothing" | "key" | "every post") {}

  postMessage(message: unknown): void {
    this.posted.push(message);
    if (message instanceof Uint8Array)
      this.keysAsPosted.push(Uint8Array.from(message));
    if (
      this.throwsOn === "every post" ||
      (this.throwsOn === "key" && message instanceof Uint8Array)
    )
      throw new DOMException("could not be cloned", "DataCloneError");
  }

  close(): void {}
}

function giveKeyPorts(
  scope: PsiCryptoWorkerScope,
  ports: Array<MessagePort | FakeKeyPort>,
): void {
  scope.onmessage?.({
    data: { kind: "key-ports", ports: ports as Array<MessagePort> },
  });
}

function firstMessage(port: MessagePort): Promise<unknown> {
  return new Promise((resolve) => {
    port.onmessage = (event: MessageEvent<unknown>) => {
      port.close();
      resolve(event.data);
    };
  });
}

const isZeroed = (bytes: unknown): boolean =>
  bytes instanceof Uint8Array &&
  bytes.length === KEY.length &&
  bytes.every((byte) => byte === 0);

describe("the PSI worker program's key handling", () => {
  test("a single-worker primary refuses a key-ports message and still serves its requests", async () => {
    const library = keyLoggingLibrary({ generated: 0, given: [] });
    const { spawn, workers } = inProcessSpawner(() => loadOf(library));
    const engine = createBrowserPsiEngineFactory(spawn)(
      "joiner",
      "client",
      "identifier-revealing",
    );
    const single = engineUnderKey("identifier-revealing");
    const channel = new MessageChannel();
    const arrived = firstMessage(channel.port1);
    workers[0].postMessage({ kind: "key-ports", ports: [channel.port2] });
    try {
      expect(await engine.createClientRequest(values(8))).toEqual(
        await single.createClientRequest(values(8)),
      );
      expect(await arrived).toBeNull();
    } finally {
      engine.dispose();
      single.dispose();
    }
  });

  test("a pool primary sends its key down the first key-ports message only", async () => {
    const library = keyLoggingLibrary({ generated: 0, given: [] });
    const { scope } = runProgram(primarySeed(1), loadOf(library));
    const [first, second] = [new MessageChannel(), new MessageChannel()];
    const arrived = [firstMessage(first.port1), firstMessage(second.port1)];
    giveKeyPorts(scope, [first.port2]);
    giveKeyPorts(scope, [second.port2]);
    expect(await Promise.all(arrived)).toEqual([KEY, null]);
  });

  test.for([
    ["comes after a request", 1, 1, true],
    ["has more ports than the seed's helpers", 1, 2, false],
    ["has fewer ports than the seed's helpers", 2, 1, false],
  ] as const)(
    "a pool primary refuses a key-ports message that %s",
    async ([, helpers, portCount, afterRequest]) => {
      const library = keyLoggingLibrary({ generated: 0, given: [] });
      const { scope, posted } = runProgram(
        primarySeed(helpers),
        loadOf(library),
      );
      const request: PsiWorkerRequest = {
        id: 1,
        body: { method: "createClientRequest", values: ["a"] },
      };
      if (afterRequest) scope.onmessage?.({ data: request });
      const channels = Array.from(
        { length: portCount },
        () => new MessageChannel(),
      );
      const arrived = channels.map((channel) => firstMessage(channel.port1));
      giveKeyPorts(
        scope,
        channels.map((channel) => channel.port2),
      );
      expect(await Promise.all(arrived)).toEqual(channels.map(() => null));
      if (afterRequest)
        await vi.waitFor(() =>
          expect(posted).toContainEqual(
            expect.objectContaining({ id: 1, ok: true }),
          ),
        );
    },
  );

  test.for(["before", "after"] as const)(
    "a helper whose library load fails %s its key arrives zeroes the key",
    async (order) => {
      let failLoad: () => void = () => undefined;
      const { scope, posted } = runProgram(
        HELPER_SEED,
        () =>
          new Promise((_resolve, reject) => {
            failLoad = () => reject(new Error("the engine failed to load"));
          }),
      );
      const port = new FakeKeyPort("nothing");
      giveKeyPorts(scope, [port]);
      await vi.waitFor(() => expect(port.onmessage).not.toBeNull());
      const key = Uint8Array.from(KEY);
      const setupFailed = (): Promise<void> =>
        vi.waitFor(() =>
          expect(posted).toEqual([{ kind: "helper-setup", ready: false }]),
        );
      if (order === "before") {
        failLoad();
        await setupFailed();
        port.onmessage?.({ data: key });
      } else {
        port.onmessage?.({ data: key });
        failLoad();
        await setupFailed();
      }
      await vi.waitFor(() => expect(isZeroed(key)).toBe(true));
    },
  );

  test("a primary whose key post throws zeroes that copy and sends a refusal", async () => {
    const library = keyLoggingLibrary({ generated: 0, given: [] });
    const { scope } = runProgram(primarySeed(1), loadOf(library));
    const port = new FakeKeyPort("key");
    giveKeyPorts(scope, [port]);
    await vi.waitFor(() => expect(port.posted).toHaveLength(2));
    expect(port.keysAsPosted).toEqual([KEY]);
    expect(isZeroed(port.posted[0])).toBe(true);
    expect(port.posted[1]).toBeNull();
  });

  test("a port whose refusal throws leaves the next helper served", async () => {
    const library = keyLoggingLibrary({ generated: 0, given: [] });
    const { scope } = runProgram(primarySeed(2), loadOf(library));
    const broken = new FakeKeyPort("every post");
    const channel = new MessageChannel();
    const arrived = firstMessage(channel.port1);
    giveKeyPorts(scope, [broken, channel.port2]);
    expect(await arrived).toEqual(KEY);
    expect(broken.keysAsPosted).toEqual([KEY]);
    expect(isZeroed(broken.posted[0])).toBe(true);
    expect(broken.posted[1]).toBeNull();
  });

  test("a helper that set up serves the primary over its port and refuses every request from the page", async () => {
    const { scope, posted } = runProgram(
      HELPER_SEED,
      loadOf(keyLoggingLibrary({ generated: 0, given: [] })),
    );
    const channel = new MessageChannel();
    giveKeyPorts(scope, [channel.port2]);
    channel.port1.postMessage(Uint8Array.from(KEY));
    await vi.waitFor(() =>
      expect(posted).toEqual([{ kind: "helper-setup", ready: true }]),
    );
    const request = (id: number): PsiWorkerRequest => ({
      id,
      body: { method: "createClientRequest", values: values(8) },
    });
    const single = engineUnderKey("identifier-revealing");
    try {
      const fromHelper = firstMessage(channel.port1);
      channel.port1.postMessage(request(1));
      scope.onmessage?.({ data: request(2) });
      expect(await fromHelper).toEqual({
        id: 1,
        ok: true,
        result: await single.createClientRequest(values(8)),
      });
      await vi.waitFor(() => expect(posted).toHaveLength(2));
      expect(posted[1]).toEqual({
        id: 2,
        ok: false,
        error: "the PSI helper worker takes no request from the page",
      });
    } finally {
      single.dispose();
    }
  });

  test("a helper whose key fails to deserialize reports a failed setup at once", async () => {
    const log: KeyLog = { generated: 0, given: [] };
    const { scope, posted } = runProgram(
      HELPER_SEED,
      loadOf(keyLoggingLibrary(log)),
    );
    const port = new FakeKeyPort("nothing");
    giveKeyPorts(scope, [port]);
    await vi.waitFor(() => expect(port.onmessage).not.toBeNull());
    port.onmessageerror?.({ data: null });
    await vi.waitFor(() =>
      expect(posted).toEqual([{ kind: "helper-setup", ready: false }]),
    );
    expect(log).toEqual({ generated: 0, given: [] });
  });
});

describe("the PSI worker pool in the count-only-permuted mode", () => {
  const mode: PsiEngineMode = "count-only-permuted";
  const elementsOf = (bytes: Uint8Array): Array<string> =>
    wasm.response
      .deserializeBinary(bytes)
      .getEncryptedElementsList_asU8()
      .map((element) => Buffer.from(element).toString("hex"));
  const inOrderStarter = (): InProcessPsiEngine =>
    new InProcessPsiEngine(wasm, "starter", "server", "identifier-revealing", {
      secretKey: KEY,
    });

  test("a joiner pool masks the request across its workers to one engine's bytes", async () => {
    const library = keyLoggingLibrary({ generated: 0, given: [] });
    const { spawn } = inProcessSpawner(() => loadOf(library));
    const pool = joinerPool(spawn, mode, 3);
    const single = engineUnderKey(mode);
    try {
      expect(await pool.createClientRequest(values(3072))).toEqual(
        await single.createClientRequest(values(3072)),
      );
    } finally {
      pool.dispose();
      single.dispose();
    }
  }, 30_000);

  // A starter pool whose primary's every message to a helper is recorded on
  // the port the helper's key went down.
  function recordedStarterPool(poolMode: PsiEngineMode): {
    pool: PsiEngine;
    toHelpers: Array<unknown>;
  } {
    const library = keyLoggingLibrary({ generated: 0, given: [] });
    const inProcess = inProcessSpawner(() => loadOf(library));
    const toHelpers: Array<unknown> = [];
    const spawn: SpawnPsiCryptoWorker = (seed) => {
      const worker = inProcess.spawn(seed);
      if (seed.shard !== "primary") return worker;
      const post = worker.postMessage;
      worker.postMessage = (message, transfer) => {
        if (kindOf(message) === "key-ports")
          for (const port of (message as PsiKeyPortsMessage).ports) {
            const send = port.postMessage.bind(port);
            port.postMessage = (sent: unknown, sentTransfer?: unknown) => {
              toHelpers.push(sent);
              send(sent, sentTransfer as Array<Transferable>);
            };
          }
        post(message, transfer);
      };
      return worker;
    };
    const pool = startPsiWorkerPool(
      spawn,
      "starter",
      "server",
      poolMode,
      3,
      TIMEOUT_MS,
    );
    return { pool, toHelpers };
  }
  const answersSent = (toHelpers: ReadonlyArray<unknown>): number =>
    toHelpers.filter(
      (message) =>
        (message as { body?: { method?: string } }).body?.method ===
        "processClientRequest",
    ).length;

  test("a starter pool answers every round on its primary under one pi, sending no helper a part, at a size the other modes split", async () => {
    const { pool, toHelpers } = recordedStarterPool(mode);
    const control = recordedStarterPool("identifier-revealing");
    const partner = engineUnderKey(mode);
    const revealingPartner = engineUnderKey("identifier-revealing");
    const inOrder = inOrderStarter();
    try {
      const pis: Array<Array<number>> = [];
      for (const round of [0, 1]) {
        const request = await partner.createClientRequest(
          values(3072).map((value) => `${String(round)}:${value}`),
        );
        const expected = elementsOf(
          await inOrder.processClientRequest(request),
        );
        const sent = elementsOf(await pool.processClientRequest(request, 3072));
        pis.push(sent.map((element) => expected.indexOf(element)));
      }
      const identity = values(3072).map((_, index) => index);
      expect([...pis[0]].sort((a, b) => a - b)).toEqual(identity);
      expect(pis[0]).not.toEqual(identity);
      expect(pis[1]).toEqual(pis[0]);
      expect(answersSent(toHelpers)).toBe(0);

      await control.pool.processClientRequest(
        await revealingPartner.createClientRequest(values(3072)),
      );
      expect(answersSent(control.toHelpers)).toBe(2);
    } finally {
      for (const engine of [
        pool,
        control.pool,
        partner,
        revealingPartner,
        inOrder,
      ])
        engine.dispose();
    }
  }, 60_000);

  // The refusals the in-process engine raises, through a pool and the worker
  // program: each crosses to the page as the error class it was raised as.
  const permutedSender = (): InProcessPsiEngine =>
    new InProcessPsiEngine(wasm, "starter", "server", mode);
  const SENDER_VALUES = values(48);

  test("a joiner pool refuses an index table of the wrong length", async () => {
    const { spawn } = inProcessSpawner(() => loadOf(wasm));
    const pool = joinerPool(spawn, mode, 3);
    const sender = permutedSender();
    try {
      const { setup, indexTable } =
        await sender.createPermutedSetup(SENDER_VALUES);
      await pool.receiveServerSetup(setup);
      const refused = pool.receiveIndexTable(indexTable.slice(1));
      await expect(refused).rejects.toBeInstanceOf(PartnerProtocolRefusalError);
      await expect(refused).rejects.toThrow(
        /has 47 entries for a setup of 48 elements/,
      );
    } finally {
      pool.dispose();
      sender.dispose();
    }
  }, 30_000);

  test("a joiner pool refuses a response repeating an element, and then a finish", async () => {
    const { spawn } = inProcessSpawner(() => loadOf(wasm));
    const pool = joinerPool(spawn, mode, 3);
    const sender = permutedSender();
    try {
      const { setup, indexTable } =
        await sender.createPermutedSetup(SENDER_VALUES);
      await pool.receiveServerSetup(setup);
      await pool.receiveIndexTable(indexTable);
      const response = wasm.response.deserializeBinary(
        await sender.processClientRequest(
          await pool.createClientRequest(values(3072)),
          3072,
        ),
      );
      const elements = response.getEncryptedElementsList_asU8();
      elements[1] = elements[0]!;
      response.setEncryptedElementsList(elements);
      const refused = pool.matchPermutedRound(response.serializeBinary());
      await expect(refused).rejects.toBeInstanceOf(PartnerProtocolRefusalError);
      await expect(refused).rejects.toThrow(/repeats an element/);
      const count = pool.finishPermutedCount();
      await expect(count).rejects.toBeInstanceOf(PartnerProtocolRefusalError);
      await expect(count).rejects.toThrow(
        /after the partner's input was refused/,
      );
    } finally {
      pool.dispose();
      sender.dispose();
    }
  }, 60_000);

  test("a joiner pool disposed after a round refuses every later call and posts its workers nothing", async () => {
    const { spawn, toWorkers } = inProcessSpawner(() => loadOf(wasm));
    const pool = joinerPool(spawn, mode, 3);
    const sender = permutedSender();
    try {
      const { setup, indexTable } =
        await sender.createPermutedSetup(SENDER_VALUES);
      await pool.receiveServerSetup(setup);
      await pool.receiveIndexTable(indexTable);
      const response = await sender.processClientRequest(
        await pool.createClientRequest(values(64)),
        64,
      );
      pool.dispose();
      const posted = toWorkers.length;
      for (const call of [
        () => pool.receiveServerSetup(setup),
        () => pool.receiveIndexTable(indexTable),
        () => pool.createClientRequest(values(64)),
        () => pool.matchPermutedRound(response),
        () => pool.finishPermutedCount(),
      ])
        await expect(call()).rejects.toBeInstanceOf(InternalConsistencyError);
      expect(toWorkers).toHaveLength(posted);
    } finally {
      sender.dispose();
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
  readonly splits: Array<PsiShardSplitMessage> = [];
  terminated = false;

  constructor(readonly seed: PsiCryptoWorkerSeed) {}

  postMessage(message: Parameters<PsiCryptoWorker["postMessage"]>[0]): void {
    if (!("kind" in message)) this.requests.push(message);
    else if (message.kind === "key-ports") this.keyPorts.push(message);
    else this.splits.push(message);
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
  test("the page tells the primary its helpers set up, sends it the whole operation, and reports its running count", async () => {
    const { spawn, workers } = fakeSpawner();
    const pool = joinerPool(spawn, "identifier-revealing", 2);
    const reported: Array<number> = [];
    pool.observeProcessedElements?.((processed) => reported.push(processed));
    const [primary, helper] = workers as [FakeWorker, FakeWorker];
    helper.send({ kind: "helper-setup", ready: true });
    const done = pool.createClientRequest(values(2048));
    await vi.waitFor(() => expect(primary.requests).toHaveLength(1));
    expect(primary.splits).toEqual([
      { kind: "shard-split", split: true, progressTimeoutMs: TIMEOUT_MS },
    ]);
    primary.send({ id: primary.requests[0].id, processed: 500 });
    primary.answer(EMPTY_REQUEST);
    expect(await done).toEqual(EMPTY_REQUEST);
    pool.dispose();
    expect(reported).toEqual([500]);
    expect(helper.requests).toHaveLength(0);
  });

  test("a primary silent past the progress timeout fails the split at once", async () => {
    vi.useFakeTimers();
    try {
      const { spawn, workers } = fakeSpawner();
      const pool = joinerPool(spawn, "identifier-revealing", 2);
      const [primary, helper] = workers as [FakeWorker, FakeWorker];
      helper.send({ kind: "helper-setup", ready: true });
      const outcome = pool.createClientRequest(values(2048)).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      primary.send({ id: primary.requests[0].id, processed: 1 });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toEqual(shardStalledError(TIMEOUT_MS));
      expect(vi.getTimerCount()).toBe(0);
      pool.dispose();
    } finally {
      vi.useRealTimers();
    }
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
    await vi.waitFor(() => expect(workers[0].requests).toHaveLength(1));
    workers[2].onerror?.({ message: "worker faulted" });
    expect(await outcome).toEqual(new Error("worker faulted"));
    expect(workers).toHaveLength(3);
    pool.dispose();
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  test("a primary that faults before the helpers report fails the operation with its fault, and every helper stops", async () => {
    vi.useFakeTimers();
    try {
      const { spawn, workers } = fakeSpawner();
      const pool = joinerPool(spawn, "identifier-revealing", 3);
      const outcome = pool.createClientRequest(values(3072)).then(
        () => undefined,
        (error: unknown) => error,
      );
      workers[0].onerror?.({ message: "worker faulted" });
      expect(await outcome).toEqual(new Error("worker faulted"));
      expect(vi.getTimerCount()).toBe(0);
      for (const helper of workers.slice(1)) {
        expect(helper.terminated).toBe(true);
        expect(helper.requests).toHaveLength(0);
      }
      pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a helper whose setup never reports leaves the run on the primary once the progress timeout passes", async () => {
    vi.useFakeTimers();
    try {
      const { spawn, workers } = fakeSpawner();
      const pool = joinerPool(spawn, "identifier-revealing", 2);
      const [primary, helper] = workers as [FakeWorker, FakeWorker];
      const done = pool.createClientRequest(values(2048));
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect(helper.terminated).toBe(true);
      expect(primary.splits).toEqual([
        { kind: "shard-split", split: false, progressTimeoutMs: TIMEOUT_MS },
      ]);
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

describe("the web exchange's PSI engine factory", () => {
  const chrome = (platform: string, agent: string) => ({
    hardwareConcurrency: 8,
    platform,
    userAgent: `Mozilla/5.0 (${agent}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36`,
  });

  const mac = chrome("MacIntel", "Macintosh; Intel Mac OS X 10_15_7");
  const linux = chrome("Linux x86_64", "X11; Linux x86_64");

  test.each([
    ["joiner", "client"],
    ["starter", "server"],
  ] as const)(
    "on macOS runs one worker for the %s, which shares its key with no one",
    (role, id) => {
      const { spawn, workers } = fakeSpawner();
      createPooledBrowserPsiEngineFactory(spawn, mac)(
        role,
        id,
        "identifier-revealing",
      ).dispose();
      expect(workers.map((worker) => worker.seed)).toEqual([
        {
          role,
          id,
          mode: "identifier-revealing",
          shard: "primary",
          helpers: 0,
        },
      ]);
      expect(workers[0].keyPorts).toEqual([]);
    },
  );

  test("elsewhere runs the joiner on the core count up to four, one primary and the rest helpers", () => {
    const { spawn, workers } = fakeSpawner();
    createPooledBrowserPsiEngineFactory(spawn, linux)(
      "joiner",
      "client",
      "identifier-revealing",
    ).dispose();
    const seed = { role: "joiner", id: "client", mode: "identifier-revealing" };
    expect(workers.map((worker) => worker.seed)).toEqual([
      { ...seed, shard: "primary", helpers: 3 },
      { ...seed, shard: "helper" },
      { ...seed, shard: "helper" },
      { ...seed, shard: "helper" },
    ]);
    expect(workers[0].keyPorts[0]?.ports).toHaveLength(3);
  });

  test("elsewhere runs the count-only-permuted joiner on the core count up to four, as the other modes", () => {
    const { spawn, workers } = fakeSpawner();
    createPooledBrowserPsiEngineFactory(spawn, linux)(
      "joiner",
      "client",
      "count-only-permuted",
    ).dispose();
    const seed = { role: "joiner", id: "client", mode: "count-only-permuted" };
    expect(workers.map((worker) => worker.seed)).toEqual([
      { ...seed, shard: "primary", helpers: 3 },
      { ...seed, shard: "helper" },
      { ...seed, shard: "helper" },
      { ...seed, shard: "helper" },
    ]);
  });

  test("elsewhere runs the starter on one worker, which answers the request with no split", async () => {
    const { spawn, workers } = fakeSpawner();
    const engine = createPooledBrowserPsiEngineFactory(spawn, linux)(
      "starter",
      "server",
      "count-only-permuted",
    );
    expect(workers.map((worker) => worker.seed)).toEqual([
      {
        role: "starter",
        id: "server",
        mode: "count-only-permuted",
        shard: "primary",
        helpers: 0,
      },
    ]);
    const [worker] = workers as [FakeWorker];
    const done = engine.processClientRequest(EMPTY_REQUEST);
    await vi.waitFor(() => expect(worker.requests).toHaveLength(1));
    worker.answer(EMPTY_REQUEST);
    expect(await done).toEqual(EMPTY_REQUEST);
    engine.dispose();
    expect(worker.keyPorts).toEqual([]);
    expect(worker.splits).toEqual([]);
    expect(workers).toHaveLength(1);
  });
});
