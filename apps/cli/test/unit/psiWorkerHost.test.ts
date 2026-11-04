import { describe, expect, test, vi } from "vitest";
import {
  INBOUND_FRAME_MEMORY_MULTIPLES,
  WorkerPsiEngine,
  psiFrameHandlingBytes,
  type PsiWorkerRequest,
  type PsiWorkerResponse,
} from "@alcove/core";

import {
  PSI_WORKER_EXIT_WAIT_NOTICE,
  createWorkerThreadHandle,
  offerExitAtOnceWhilePsiWorkersStop,
  stopPsiWorkersBeforeExit,
  trackWorkerPsiEngine,
} from "../../src/psiWorkerHost";

// createWorkerThreadHandle is the single definition of the host-side worker wiring
// (psiWorkerHost.ts). Production, the integration test, and these tests all wrap a
// worker through it; a hand-rolled mirror once drifted from production unnoticed.
// A fake also emits 'messageerror' on demand, so that handler is shown here to
// route the failure rather than silently drop it, hanging the pending call.

// A stand-in for a worker_threads Worker: records posted requests and terminate()
// calls, and lets a test emit the worker's events on demand.
class FakeWorker {
  readonly posted: PsiWorkerRequest[] = [];
  terminateCalls = 0;
  private readonly listeners = new Map<string, Array<(arg: unknown) => void>>();

  on(event: string, listener: (arg: never) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as (arg: unknown) => void);
    this.listeners.set(event, list);
  }

  once(event: string, listener: (arg: never) => void): void {
    const wrapped = (arg: unknown): void => {
      this.off(event, wrapped);
      (listener as (arg: unknown) => void)(arg);
    };
    this.on(event, wrapped);
  }

  private off(event: string, listener: (arg: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      list.filter((entry) => entry !== listener),
    );
  }

  postMessage(request: PsiWorkerRequest): void {
    this.posted.push(request);
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    return Promise.resolve(0);
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg);
  }
}

describe("createWorkerThreadHandle", () => {
  test("routes replies to onMessage and every failure event to onError", () => {
    const fake = new FakeWorker();
    const handle = createWorkerThreadHandle(fake);
    const onMessage = vi.fn();
    const onError = vi.fn();
    handle.setHandlers({ onMessage, onError });

    // A normal reply routes to onMessage unchanged.
    const reply: PsiWorkerResponse = {
      id: 0,
      ok: true,
      result: new Uint8Array(),
    };
    fake.emit("message", reply);
    expect(onMessage).toHaveBeenCalledWith(reply);

    // 'error' routes to onError.
    const err = new Error("worker faulted");
    fake.emit("error", err);
    expect(onError).toHaveBeenCalledWith(err);

    // 'messageerror' -- a reply that fails structured-clone deserialization -- also
    // routes to onError. Without this wiring the event is silently dropped and the
    // pending call hangs; nothing else in the suite exercises it, so dropping the
    // listener would otherwise go unnoticed.
    const cloneErr = new Error("could not be deserialized");
    fake.emit("messageerror", cloneErr);
    expect(onError).toHaveBeenCalledWith(cloneErr);

    // An exit we did not initiate is a fault.
    fake.emit("exit", 1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("exited with code 1"),
      }),
    );
  });

  test("an expected exit after terminate() is not reported as a fault", () => {
    const fake = new FakeWorker();
    const handle = createWorkerThreadHandle(fake);
    const onError = vi.fn();
    handle.setHandlers({ onMessage: vi.fn(), onError });

    // terminate() marks the coming exit as one WE initiated.
    handle.terminate();
    expect(fake.terminateCalls).toBe(1);

    // The worker's own exit (nonzero, indistinguishable by code from a crash) must
    // therefore NOT re-enter onError -- the exit code cannot tell a clean disposal
    // from a fault, so whether we asked it to stop is what gates the fault.
    fake.emit("exit", 1);
    expect(onError).not.toHaveBeenCalled();
  });

  test("terminate() during a request waits for its reply, which dispose() asks to come early", () => {
    const fake = new FakeWorker();
    const engine = new WorkerPsiEngine(createWorkerThreadHandle(fake));
    void engine.createClientRequest(["x"]).catch(() => {});
    const request = fake.posted[0]!;

    // Terminating the worker inside a native masking call aborts the
    // process, so the worker is left running until it replies.
    engine.dispose();
    expect(fake.terminateCalls).toBe(0);
    expect(Atomics.load(request.stopFlag!, 0)).not.toBe(0);

    // A progress tick is not the reply: the call is still inside the worker.
    fake.emit("message", { id: request.id, processed: 1 });
    expect(fake.terminateCalls).toBe(0);

    fake.emit("message", {
      id: request.id,
      ok: false,
      error: "PSI operation stopped before it finished",
      stopped: true,
    });
    expect(fake.terminateCalls).toBe(1);
  });

  test("a messageerror fails the engine's pending call fast instead of hanging", async () => {
    const fake = new FakeWorker();
    const engine = new WorkerPsiEngine(createWorkerThreadHandle(fake));

    // A call posts its request to the worker and awaits the reply.
    const pending = engine.createClientRequest(["x"]);
    expect(fake.posted).toHaveLength(1);

    // The reply comes back as a messageerror (non-cloneable): the pending call must
    // reject with that cause rather than hang on a reply that will never arrive.
    fake.emit("messageerror", new Error("could not be deserialized"));
    await expect(pending).rejects.toThrow(/could not be deserialized/);
  });

  test("a messageerror does not leave dispose() waiting to terminate the worker", async () => {
    const fake = new FakeWorker();
    const engine = new WorkerPsiEngine(createWorkerThreadHandle(fake));
    const pending = engine.createClientRequest(["x"]);
    fake.emit("messageerror", new Error("could not be deserialized"));
    await expect(pending).rejects.toThrow(/could not be deserialized/);

    engine.dispose();
    expect(fake.terminateCalls).toBe(1);
  });
});

describe("a signal exit while a PSI worker request is in flight", () => {
  test.each(["SIGINT", "SIGTERM"] as const)(
    "the first signal waits and prints the notice; a further %s exits at once",
    async (signal) => {
      const fake = new FakeWorker();
      const engine = trackWorkerPsiEngine(fake);
      void engine.createClientRequest(["x"]).catch(() => {});
      const request = fake.posted[0]!;
      const announce = vi.fn();
      const exitAtOnce = vi.fn();
      const sigintListenersBefore = process.listenerCount("SIGINT");
      const sigtermListenersBefore = process.listenerCount("SIGTERM");
      const options = { announce, exitAtOnce };

      offerExitAtOnceWhilePsiWorkersStop(options);
      expect(announce).toHaveBeenCalledExactlyOnceWith(
        PSI_WORKER_EXIT_WAIT_NOTICE,
      );

      let stopped = false;
      const stopping = stopPsiWorkersBeforeExit(options).then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stopped).toBe(false);
      expect(fake.terminateCalls).toBe(0);
      expect(announce).toHaveBeenCalledOnce();
      expect(exitAtOnce).not.toHaveBeenCalled();

      process.emit(signal);
      expect(exitAtOnce).toHaveBeenCalledExactlyOnceWith(signal);

      // With process.exit mocked away the wait still ends normally once the
      // worker reaches its chunk boundary, and the listeners come off.
      fake.emit("message", {
        id: request.id,
        ok: false,
        error: "PSI operation stopped before it finished",
        stopped: true,
      });
      expect(fake.terminateCalls).toBe(1);
      fake.emit("exit", 1);
      await stopping;
      expect(process.listenerCount("SIGINT")).toBe(sigintListenersBefore);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermListenersBefore);
    },
  );

  test("a request in flight only once the wait begins still gets the notice and the exit at once", async () => {
    const fake = new FakeWorker();
    const engine = trackWorkerPsiEngine(fake);
    const announce = vi.fn();
    const exitAtOnce = vi.fn();
    const options = { announce, exitAtOnce };

    offerExitAtOnceWhilePsiWorkersStop(options);
    expect(announce).not.toHaveBeenCalled();

    void engine.createClientRequest(["x"]).catch(() => {});
    const request = fake.posted[0]!;
    const stopping = stopPsiWorkersBeforeExit(options);
    expect(announce).toHaveBeenCalledExactlyOnceWith(
      PSI_WORKER_EXIT_WAIT_NOTICE,
    );
    process.emit("SIGTERM");
    expect(exitAtOnce).toHaveBeenCalledExactlyOnceWith("SIGTERM");

    fake.emit("message", {
      id: request.id,
      ok: false,
      error: "PSI operation stopped before it finished",
      stopped: true,
    });
    fake.emit("exit", 1);
    await stopping;
  });

  test("with no request in flight there is no notice and no extra listener", async () => {
    const fake = new FakeWorker();
    trackWorkerPsiEngine(fake);
    const announce = vi.fn();
    const sigintListenersBefore = process.listenerCount("SIGINT");
    const sigtermListenersBefore = process.listenerCount("SIGTERM");
    const options = { announce, exitAtOnce: vi.fn() };

    offerExitAtOnceWhilePsiWorkersStop(options);
    const stopping = stopPsiWorkersBeforeExit(options);
    expect(announce).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGINT")).toBe(sigintListenersBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListenersBefore);
    expect(fake.terminateCalls).toBe(1);
    fake.emit("exit", 1);
    await stopping;
  });
});

describe("the memory check before the worker takes a partner frame", () => {
  const FRAME_BYTES = 100;
  const frame = () => new Uint8Array(FRAME_BYTES);

  // Each partner message the engine is given, the memory it is weighed at,
  // and the reply that settles the call.
  const calls = [
    [
      "a request",
      (engine: WorkerPsiEngine) => engine.processClientRequest(frame()),
      FRAME_BYTES,
      psiFrameHandlingBytes(FRAME_BYTES, "decode"),
      new Uint8Array(1),
    ],
    [
      "a setup",
      (engine: WorkerPsiEngine) => engine.receiveServerSetup(frame()),
      FRAME_BYTES,
      psiFrameHandlingBytes(FRAME_BYTES, "stream"),
      undefined,
    ],
    [
      "a setup piece",
      (engine: WorkerPsiEngine) => engine.receiveServerSetupPiece(frame()),
      FRAME_BYTES,
      psiFrameHandlingBytes(FRAME_BYTES, "stream"),
      undefined,
    ],
    [
      "a response",
      (engine: WorkerPsiEngine) => engine.computeAssociationTable(frame()),
      FRAME_BYTES,
      psiFrameHandlingBytes(FRAME_BYTES, "stream"),
      [[], []],
    ],
    [
      "a permuted response",
      (engine: WorkerPsiEngine) => engine.matchPermutedRound(frame()),
      FRAME_BYTES,
      psiFrameHandlingBytes(FRAME_BYTES, "stream"),
      undefined,
    ],
    [
      "an index table",
      (engine: WorkerPsiEngine) =>
        engine.receiveIndexTable(new Int32Array(FRAME_BYTES / 4)),
      FRAME_BYTES,
      FRAME_BYTES * INBOUND_FRAME_MEMORY_MULTIPLES.workerClone,
      undefined,
    ],
  ] as const;

  test.each(calls)(
    "%s is weighed at its copy and its handling before it is posted",
    async (_what, call, frameBytes, needBytes, result) => {
      const fake = new FakeWorker();
      const weighed: Array<[number, number]> = [];
      const engine = trackWorkerPsiEngine(fake, (frame, need) => {
        weighed.push([frame, need]);
      });
      const pending = call(engine);
      expect(weighed).toEqual([[frameBytes, needBytes]]);
      expect(fake.posted).toHaveLength(1);
      fake.emit("message", { id: fake.posted[0]!.id, ok: true, result });
      await pending;
      fake.emit("exit", 0);
    },
  );

  test.each(calls)(
    "%s is refused without posting when it does not fit",
    async (_what, call) => {
      const fake = new FakeWorker();
      const refusal = new Error("not enough memory");
      const engine = trackWorkerPsiEngine(fake, () => {
        throw refusal;
      });
      await expect(call(engine)).rejects.toBe(refusal);
      expect(fake.posted).toEqual([]);
      fake.emit("exit", 0);
    },
  );

  test("the handling multiples are the measured ones", () => {
    expect(psiFrameHandlingBytes(FRAME_BYTES, "decode")).toBe(
      FRAME_BYTES *
        (INBOUND_FRAME_MEMORY_MULTIPLES.workerClone +
          INBOUND_FRAME_MEMORY_MULTIPLES.psiDecode),
    );
    expect(psiFrameHandlingBytes(FRAME_BYTES, "stream")).toBe(
      FRAME_BYTES *
        (INBOUND_FRAME_MEMORY_MULTIPLES.workerClone +
          INBOUND_FRAME_MEMORY_MULTIPLES.streamedSetup),
    );
  });
});
