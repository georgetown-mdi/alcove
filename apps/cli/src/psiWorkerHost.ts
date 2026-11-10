import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker, isMarkedAsUntransferable } from "node:worker_threads";

import {
  INBOUND_FRAME_MEMORY_MULTIPLES,
  InProcessPsiEngine,
  WorkerPsiEngine,
  psiFrameHandlingBytes,
  type InboundFrameMemoryCheck,
  type InboundPsiFrameUse,
  type PsiEngine,
  type PsiEngineMode,
  type PsiFrameHandOff,
  type PsiWorkerHandle,
  type PsiWorkerRequest,
  type PsiWorkerResponse,
} from "@alcove/core";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type { CliPsiWorkerInit } from "./psiBackend";
import { raisePsiWorkerHeapLimit, type PsiBackend } from "./psiMemoryBudget";

// The host side of the CLI's PSI worker: it spawns the
// worker_threads worker that runs the masking off the event-loop-owning thread and
// exposes it as a PsiEngine, so a long round does not starve the SFTP heartbeat or
// the liveness timers. Wired through RunExchangeOptions.psiEngineFactory in
// protocol.ts.

// dist/psiWorker.worker.js sits beside this module only in the built CJS bundle,
// so __dirname resolves it there; running from src (the test runner, where no
// compiled .js sits beside the source) or wherever __dirname is undefined yields
// undefined here, and the caller falls back to the in-process engine.
function resolveWorkerEntry(): string | undefined {
  try {
    const entry = path.join(__dirname, "psiWorker.worker.js");
    return existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether {@link createPsiEngine} runs the PSI engine in a worker (the shipped
 * CLI) rather than on this thread (dev, tests): the worker runs under the
 * raised heap limit ({@link raisePsiWorkerHeapLimit}), this thread under the
 * process's own.
 */
export function psiEngineRunsInWorker(): boolean {
  return resolveWorkerEntry() !== undefined;
}

/**
 * Start the PSI worker thread at `entry`, seeded with `init`, under the heap
 * limit `heapBytes` asks for, {@link raisePsiWorkerHeapLimit}'s default when
 * unset.
 * @internal
 */
export function startPsiWorkerThread(
  entry: string,
  init: CliPsiWorkerInit,
  heapBytes?: number,
): Worker {
  raisePsiWorkerHeapLimit(heapBytes);
  return new Worker(entry, { workerData: init });
}

/** How a CLI exchange's PSI worker is sized and guarded, from its counts. */
export interface PsiWorkerSizing {
  /** The worker heap the run's counts need, in bytes. */
  heapBytes?: number;
  /** Weighs each partner frame against the memory the process has before the worker takes it. */
  frameMemoryCheck?: InboundFrameMemoryCheck;
}

/**
 * Build the PSI crypto engine for a CLI exchange. When the bundled worker entry is
 * present (the shipped CLI), the masking runs in a worker_threads worker off the
 * event-loop-owning thread; otherwise it falls back to the in-process engine (dev,
 * tests). `library` backs only that fallback; the worker loads `backend`, the
 * library the caller selected, and fails to start if that one does not load.
 */
export function createPsiEngine(
  library: PSILibrary,
  backend: PsiBackend,
  role: "starter" | "joiner",
  id: string,
  mode: PsiEngineMode,
  sizing: PsiWorkerSizing = {},
): PsiEngine {
  const entry = resolveWorkerEntry();
  if (entry !== undefined)
    return spawnWorkerPsiEngine(entry, backend, role, id, mode, sizing);
  return new InProcessPsiEngine(library, role, id, mode);
}

// A worker engine that weighs each partner frame it is given against the
// memory the process has, before posting the frame to the worker.
class MemoryCheckedWorkerPsiEngine extends WorkerPsiEngine {
  readonly #checkFrame: InboundFrameMemoryCheck;

  constructor(handle: PsiWorkerHandle, checkFrame: InboundFrameMemoryCheck) {
    super(handle);
    this.#checkFrame = checkFrame;
  }

  #checked<T>(
    frameBytes: number,
    needBytes: number,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      this.#checkFrame(frameBytes, needBytes);
    } catch (error) {
      return Promise.reject(error);
    }
    return run();
  }

  #checkedFrame<T>(
    bytes: Uint8Array,
    use: InboundPsiFrameUse,
    run: () => Promise<T>,
    handOff?: PsiFrameHandOff,
  ): Promise<T> {
    return this.#checked(
      bytes.byteLength,
      psiFrameHandlingBytes(bytes.byteLength, use, handOff?.transfer === true),
      run,
    );
  }

  override processClientRequest(
    requestBytes: Uint8Array,
    declaredElements?: number,
    width?: number,
    handOff?: PsiFrameHandOff,
  ): Promise<Uint8Array> {
    return this.#checkedFrame(
      requestBytes,
      "decode",
      () =>
        super.processClientRequest(
          requestBytes,
          declaredElements,
          width,
          handOff,
        ),
      handOff,
    );
  }

  override receiveServerSetup(setupBytes: Uint8Array): Promise<void> {
    return this.#checkedFrame(setupBytes, "stream", () =>
      super.receiveServerSetup(setupBytes),
    );
  }

  override receiveServerSetupPiece(
    piece: Uint8Array,
    handOff?: PsiFrameHandOff,
  ): Promise<void> {
    return this.#checkedFrame(
      piece,
      "stream",
      () => super.receiveServerSetupPiece(piece, handOff),
      handOff,
    );
  }

  override computeAssociationTable(
    responseBytes: Uint8Array,
    handOff?: PsiFrameHandOff,
  ): Promise<[Array<number>, Array<number>]> {
    return this.#checkedFrame(
      responseBytes,
      "stream",
      () => super.computeAssociationTable(responseBytes, handOff),
      handOff,
    );
  }

  override receiveIndexTable(
    indexTable: Int32Array,
    width?: number,
  ): Promise<void> {
    return this.#checked(
      indexTable.byteLength,
      indexTable.byteLength * INBOUND_FRAME_MEMORY_MULTIPLES.workerClone,
      () => super.receiveIndexTable(indexTable, width),
    );
  }

  override matchPermutedRound(responseBytes: Uint8Array): Promise<void> {
    return this.#checkedFrame(responseBytes, "stream", () =>
      super.matchPermutedRound(responseBytes),
    );
  }
}

// The minimal worker_threads Worker surface {@link createWorkerThreadHandle} drives.
// Node's Worker satisfies it structurally; a unit test supplies a fake so the failure
// routing below can be exercised deterministically -- a real 'messageerror' cannot be
// provoked with today's cloneable payloads.
interface WorkerThreadLike {
  on(event: "message", listener: (value: PsiWorkerResponse) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "messageerror", listener: (error: Error) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  postMessage(
    value: PsiWorkerRequest,
    transferList?: ReadonlyArray<ArrayBuffer>,
  ): void;
  terminate(): unknown;
}

// A worker the host tracks until it exits: {@link WorkerThreadLike} plus the
// one-shot exit listener the tracking registers.
interface TrackedWorkerThreadLike extends WorkerThreadLike {
  once(event: "exit", listener: () => void): void;
}

/** {@link PsiWorkerHandle} plus whether a request has not yet had its reply. */
interface WorkerThreadHandle extends PsiWorkerHandle {
  requestInFlight(): boolean;
}

/**
 * Wrap a worker_threads Worker as the runtime-agnostic {@link PsiWorkerHandle} the
 * {@link WorkerPsiEngine} drives. This is the single definition of the host-side
 * event wiring -- message-reply routing plus the error / messageerror / exit
 * failure paths: the real-worker integration test wraps an actual Worker through
 * it and a unit test wraps a fake, so neither re-implements a mirror that can
 * drift from production.
 */
export function createWorkerThreadHandle(
  worker: WorkerThreadLike,
): WorkerThreadHandle {
  // Set when dispose() drives the teardown, so the worker's own 'exit' event is
  // recognized as the expected stop rather than a crash. terminate() reports the
  // same nonzero code (1) that psiWorker.worker.ts's startup failure exits with,
  // so the code alone cannot tell a clean disposal from a fault -- only whether
  // dispose() initiated it can. dispose() has already failed every pending call
  // before terminating, so an expected exit must not re-enter onError.
  let terminating = false;
  // Terminating the worker inside a native masking call aborts the whole
  // process, so a terminate() while a request is in flight waits for that
  // request's reply; dispose() has asked the operation to stop at its next
  // masking chunk or match call boundary.
  const inFlight = new Set<number>();
  let terminated = false;
  const terminateWhenIdle = (): void => {
    if (!terminating || terminated || inFlight.size > 0) return;
    terminated = true;
    void worker.terminate();
  };
  return {
    postMessage: (request, transfer) => {
      inFlight.add(request.id);
      // Node marks the buffer pool small Buffers share untransferable, and
      // refuses to move one, so a buffer marked that way is copied.
      const movable = (transfer ?? []).filter(
        (buffer) => !isMarkedAsUntransferable(buffer),
      );
      if (movable.length > 0) worker.postMessage(request, movable);
      else worker.postMessage(request);
    },
    setHandlers: ({ onMessage, onError }) => {
      worker.on("message", (response: PsiWorkerResponse) => {
        if ("ok" in response) inFlight.delete(response.id);
        onMessage(response);
        terminateWhenIdle();
      });
      worker.on("error", (error) => onError(error));
      // A message that fails structured-clone deserialization is emitted as
      // 'messageerror', NOT 'error'; with no listener it is silently dropped and the
      // pending call would hang. Route it to onError so the call fails fast. Not
      // reachable with today's cloneable payloads (byte arrays and index lists), but
      // a boundary hardening against a future non-cloneable message. The failed
      // message may be a reply (the native call is over) or a progress tick the
      // worker posts between chunks (the next call has not started), so clearing
      // the set never terminates a worker inside a native call today.
      worker.on("messageerror", (error) => {
        inFlight.clear();
        onError(error);
        terminateWhenIdle();
      });
      worker.on("exit", (code) => {
        // A worker that exits on its own -- a failed startup or a crash -- must fail
        // the exchange rather than let it hang on a dead worker. A terminate()'d
        // worker also exits nonzero, so an exit is a fault only when we did not
        // initiate it; an expected teardown is one dispose() has already settled.
        if (!terminating)
          onError(new Error(`PSI worker exited with code ${code}`));
      });
    },
    terminate: () => {
      terminating = true;
      terminateWhenIdle();
    },
    requestInFlight: () => inFlight.size > 0,
  };
}

// Every PSI worker this process has spawned that has not exited.
const liveWorkers = new Map<
  WorkerPsiEngine,
  { exited: Promise<void>; requestInFlight: () => boolean }
>();

/**
 * The seed a PSI worker starts with.
 * @internal
 */
export function psiWorkerInit(
  backend: PsiBackend,
  role: "starter" | "joiner",
  id: string,
  mode: PsiEngineMode,
): CliPsiWorkerInit {
  return { role, id, mode, backend };
}

function spawnWorkerPsiEngine(
  entry: string,
  backend: PsiBackend,
  role: "starter" | "joiner",
  id: string,
  mode: PsiEngineMode,
  sizing: PsiWorkerSizing,
): WorkerPsiEngine {
  const init = psiWorkerInit(backend, role, id, mode);
  // The worker exposes gc() for the single-pass memory relief itself, at startup
  // (see psiWorker.worker.ts): --expose-gc cannot be passed through a worker's
  // execArgv (Node rejects it), so nothing gc-related is set here.
  // The worker is not unref'd: while crypto is in flight the process must stay
  // alive, exactly as the synchronous masking kept it. dispose() (driven by the
  // exchange's teardown finally) calls terminate(), which releases the process
  // at the end, so a ref'd worker handle never outlives the exchange.
  return trackWorkerPsiEngine(
    startPsiWorkerThread(entry, init, sizing.heapBytes),
    sizing.frameMemoryCheck,
  );
}

/**
 * Wrap `worker` as a {@link WorkerPsiEngine} that
 * {@link stopPsiWorkersBeforeExit} waits for until the worker exits, and that
 * weighs each partner frame with `frameMemoryCheck` when one is given.
 * @internal
 */
export function trackWorkerPsiEngine(
  worker: TrackedWorkerThreadLike,
  frameMemoryCheck?: InboundFrameMemoryCheck,
): WorkerPsiEngine {
  const handle = createWorkerThreadHandle(worker);
  const engine =
    frameMemoryCheck === undefined
      ? new WorkerPsiEngine(handle)
      : new MemoryCheckedWorkerPsiEngine(handle, frameMemoryCheck);
  liveWorkers.set(engine, {
    exited: new Promise<void>((resolve) =>
      worker.once("exit", () => {
        liveWorkers.delete(engine);
        resolve();
      }),
    ),
    requestInFlight: handle.requestInFlight,
  });
  return engine;
}

/**
 * The line a signal handler prints when it waits for a PSI worker's current
 * native call before exiting.
 */
export const PSI_WORKER_EXIT_WAIT_NOTICE =
  "finishing the current PSI step before exiting (up to one encryption " +
  "chunk, or the whole match); press Ctrl-C again or send the signal " +
  "again to exit at once, which can end with a different exit code";

/** The signals whose repeat ends the wait for a PSI worker at once. */
export type PsiWorkerExitSignal = "SIGINT" | "SIGTERM";

const EXIT_SIGNALS: readonly PsiWorkerExitSignal[] = ["SIGINT", "SIGTERM"];

/** How a signal handler reports and ends the wait for a PSI worker. */
export interface PsiWorkerExitWaitOptions {
  announce: (line: string) => void;
  exitAtOnce: (signal: PsiWorkerExitSignal) => void;
}

let exitAtOnceListeners: Map<PsiWorkerExitSignal, () => void> | undefined;

/**
 * Called by a signal handler as it begins, and again by
 * {@link stopPsiWorkersBeforeExit}: when a PSI worker has a request in
 * flight, print {@link PSI_WORKER_EXIT_WAIT_NOTICE} through `announce` and,
 * until {@link stopPsiWorkersBeforeExit} finishes, call `exitAtOnce` on a
 * further SIGINT or SIGTERM.
 * The operator is the bound on the wait: there is no timeout.
 */
export function offerExitAtOnceWhilePsiWorkersStop(
  options: PsiWorkerExitWaitOptions,
): void {
  if (exitAtOnceListeners !== undefined) return;
  const inFlight = [...liveWorkers.values()].some((worker) =>
    worker.requestInFlight(),
  );
  if (!inFlight) return;
  options.announce(PSI_WORKER_EXIT_WAIT_NOTICE);
  exitAtOnceListeners = new Map();
  for (const signal of EXIT_SIGNALS) {
    const listener = (): void => {
      options.exitAtOnce(signal);
    };
    exitAtOnceListeners.set(signal, listener);
    // Ahead of the exchange's own handler, which would otherwise print its
    // interrupt lines again before this exit.
    process.prependListener(signal, listener);
  }
}

/**
 * Dispose every live PSI worker engine and resolve once each worker has
 * exited. A signal handler awaits this before `process.exit`, which would
 * otherwise tear a worker down inside a native call and abort the process.
 * An operation in flight stops at its next boundary: at most one masking
 * chunk during encryption, one response piece during the match -- for a
 * match whose response is one piece, the whole match. When it has
 * to wait, a repeated signal ends the wait as
 * {@link offerExitAtOnceWhilePsiWorkersStop} describes. Never rejects.
 */
export async function stopPsiWorkersBeforeExit(
  options: PsiWorkerExitWaitOptions,
): Promise<void> {
  offerExitAtOnceWhilePsiWorkersStop(options);
  const exits = [...liveWorkers].map(([engine, { exited }]) => {
    // The caller exits once this settles, so a dispose that throws must not
    // reject it; there is then no stop to wait for.
    try {
      engine.dispose();
      return exited;
    } catch {
      return Promise.resolve();
    }
  });
  await Promise.all(exits);
  if (exitAtOnceListeners !== undefined) {
    for (const [signal, listener] of exitAtOnceListeners)
      process.off(signal, listener);
    exitAtOnceListeners = undefined;
  }
}
