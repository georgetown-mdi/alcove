import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

import {
  InProcessPsiEngine,
  WorkerPsiEngine,
  type PsiEngine,
  type PsiEngineMode,
  type PsiWorkerHandle,
  type PsiWorkerInit,
  type PsiWorkerRequest,
  type PsiWorkerResponse,
} from "@alcove/core";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { raisePsiWorkerHeapLimit } from "./psiMemoryBudget";

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
 * Start the PSI worker thread at `entry`, seeded with `init`, under the raised
 * heap limit.
 * @internal
 */
export function startPsiWorkerThread(
  entry: string,
  init: PsiWorkerInit,
): Worker {
  raisePsiWorkerHeapLimit();
  return new Worker(entry, { workerData: init });
}

/**
 * Build the PSI crypto engine for a CLI exchange. When the bundled worker entry is
 * present (the shipped CLI), the masking runs in a worker_threads worker off the
 * event-loop-owning thread; otherwise it falls back to the in-process engine (dev,
 * tests). `library` backs only that fallback -- the worker loads its own backend.
 */
export function createPsiEngine(
  library: PSILibrary,
  role: "starter" | "joiner",
  id: string,
  mode: PsiEngineMode,
): PsiEngine {
  const entry = resolveWorkerEntry();
  if (entry !== undefined) return spawnWorkerPsiEngine(entry, role, id, mode);
  return new InProcessPsiEngine(library, role, id, mode);
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
  postMessage(value: PsiWorkerRequest): void;
  terminate(): unknown;
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
): PsiWorkerHandle {
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
  // chunk boundary, which bounds the wait to one chunk.
  const inFlight = new Set<number>();
  let terminated = false;
  const terminateWhenIdle = (): void => {
    if (!terminating || terminated || inFlight.size > 0) return;
    terminated = true;
    void worker.terminate();
  };
  return {
    postMessage: (request: PsiWorkerRequest) => {
      inFlight.add(request.id);
      worker.postMessage(request);
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
      // a boundary hardening against a future non-cloneable reply.
      worker.on("messageerror", (error) => onError(error));
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
  };
}

// Every PSI worker this process has spawned that has not exited, with the
// promise its exit resolves.
const liveWorkerEngines = new Map<WorkerPsiEngine, Promise<void>>();

function spawnWorkerPsiEngine(
  entry: string,
  role: "starter" | "joiner",
  id: string,
  mode: PsiEngineMode,
): WorkerPsiEngine {
  // Typed as the seed the worker reads back, so an added required field is a
  // compile error here rather than a value the worker silently misses.
  const init: PsiWorkerInit = { role, id, mode };
  // The worker exposes gc() for the single-pass memory relief itself, at startup
  // (see psiWorker.worker.ts): --expose-gc cannot be passed through a worker's
  // execArgv (Node rejects it), so nothing gc-related is set here.
  const worker = startPsiWorkerThread(entry, init);
  // The worker is not unref'd: while crypto is in flight the process must stay
  // alive, exactly as the synchronous masking kept it. dispose() (driven by the
  // exchange's teardown finally) calls terminate(), which releases the process
  // at the end, so a ref'd worker handle never outlives the exchange.
  const engine = new WorkerPsiEngine(createWorkerThreadHandle(worker));
  liveWorkerEngines.set(
    engine,
    new Promise<void>((resolve) =>
      worker.once("exit", () => {
        liveWorkerEngines.delete(engine);
        resolve();
      }),
    ),
  );
  return engine;
}

/**
 * Dispose every live PSI worker engine and resolve once each worker has
 * exited. A signal handler awaits this before `process.exit`, which would
 * otherwise tear a worker down inside a native masking call and abort the
 * process; an operation in flight stops at its next chunk boundary, so the
 * wait is at most one chunk. Never rejects.
 */
export async function stopPsiWorkersBeforeExit(): Promise<void> {
  const exits = [...liveWorkerEngines].map(([engine, exited]) => {
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
}
