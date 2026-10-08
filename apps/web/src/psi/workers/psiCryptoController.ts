import { WorkerPsiEngine } from "@alcove/core";

import { errorFromWorkerEvent } from "./workerEventError";

import type {
  PsiEngine,
  PsiEngineMode,
  PsiWorkerHandle,
  PsiWorkerInit,
  PsiWorkerRequest,
  PsiWorkerResponse,
} from "@alcove/core";

/**
 * The browser spawn adapter for core's PSI worker boundary: it wires a Web
 * Worker into core's {@link WorkerPsiEngine}, so a PSI round's masking runs off
 * the main thread and the tab stays responsive, as the CLI's `worker_threads`
 * offload does. {@link psiCrypto.worker} is the worker entry. Only bytes, value
 * lists and index lists cross the boundary; the secret key is generated and
 * kept inside the worker by core's `servePsiWorker`.
 *
 * Node-loadable, never referencing the real `Worker` constructor (that is in
 * {@link ./psiCryptoWorkerClient}), so the dispatch is unit-testable with a fake
 * worker.
 */

/** The slice of the dedicated-`Worker` API the host side drives; a unit test
 * supplies a fake. */
export interface PsiCryptoWorker {
  postMessage: (message: PsiWorkerRequest) => void;
  onmessage: ((event: { data: PsiWorkerResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  terminate: () => void;
}

/** Spawns a fresh PSI-crypto worker seeded with `init` through the Worker's
 * `name` (see {@link encodePsiWorkerInit}); the browser default is
 * {@link ./psiCryptoWorkerClient}. */
export type SpawnPsiCryptoWorker = (init: PsiWorkerInit) => PsiCryptoWorker;

/**
 * Encode the worker's role/id seed for the Web Worker's `name`, the browser
 * analogue of the CLI worker's `workerData`: it is readable as `self.name`
 * before the first message, so the message channel sends only crypto requests.
 * {@link decodePsiWorkerInit} is the worker's side.
 */
export function encodePsiWorkerInit(init: PsiWorkerInit): string {
  return JSON.stringify(init);
}

/** Decode the role/id seed the worker reads from `self.name`. */
export function decodePsiWorkerInit(name: string): PsiWorkerInit {
  // eslint-disable-next-line no-restricted-properties -- decodes the seed encodePsiWorkerInit serialized into this worker's own name
  return JSON.parse(name) as PsiWorkerInit;
}

/**
 * The worker-side request router for {@link ./psiCrypto.worker}: buffers
 * requests until the asynchronously loaded dispatcher is ready, then drains them
 * in order. If the dispatcher fails to load, every buffered and later request is
 * answered through `failRequest`, so the host's pending call fails rather than
 * hanging. Kept here, outside the browser-only entry, so the load-failure path
 * is unit-testable.
 */
export function createBufferingRequestRouter(
  startDispatcher: () => Promise<(request: PsiWorkerRequest) => void>,
  failRequest: (id: number, error: string) => void,
): (request: PsiWorkerRequest) => void {
  let dispatch: ((request: PsiWorkerRequest) => void) | undefined;
  const buffered: Array<PsiWorkerRequest> = [];
  let loadFailure: string | undefined;
  void startDispatcher().then(
    (ready) => {
      for (const request of buffered) ready(request);
      buffered.length = 0;
      dispatch = ready;
    },
    (error: unknown) => {
      loadFailure = error instanceof Error ? error.message : String(error);
      for (const request of buffered) failRequest(request.id, loadFailure);
      buffered.length = 0;
    },
  );
  return (request: PsiWorkerRequest) => {
    if (loadFailure !== undefined) {
      failRequest(request.id, loadFailure);
      return;
    }
    if (dispatch) dispatch(request);
    else buffered.push(request);
  };
}

/**
 * Wrap a Web Worker as the {@link PsiWorkerHandle} a {@link WorkerPsiEngine}
 * drives; the browser counterpart of the CLI's `createWorkerThreadHandle`, and
 * the one definition of the host-side event wiring for production and tests.
 * A Web Worker's `terminate()` fires no event, so no teardown guard is needed.
 * `onmessageerror` (a reply that fails structured-clone deserialization) is
 * routed to `onError`, since with no handler the pending call would hang.
 */
export function createPsiCryptoWorkerHandle(
  worker: PsiCryptoWorker,
): PsiWorkerHandle {
  return {
    postMessage: (request: PsiWorkerRequest) => worker.postMessage(request),
    setHandlers: ({ onMessage, onError }) => {
      worker.onmessage = (event: { data: PsiWorkerResponse }) =>
        onMessage(event.data);
      worker.onerror = (event: unknown) =>
        onError(errorFromWorkerEvent(event, "PSI crypto worker failed"));
      worker.onmessageerror = (event: unknown) =>
        onError(errorFromWorkerEvent(event, "PSI crypto worker failed"));
    },
    terminate: () => worker.terminate(),
  };
}

/**
 * Build the {@link RunExchangeOptions.psiEngineFactory} the web exchange passes
 * to core's `runExchange`: spawn a worker seeded with the resolved role and id,
 * and return a {@link WorkerPsiEngine} bound to it. `runExchange` disposes the
 * engine on every exchange-end path, and {@link WorkerPsiEngine.dispose}
 * terminates the worker.
 */
export function createBrowserPsiEngineFactory(
  spawn: SpawnPsiCryptoWorker,
): (role: "starter" | "joiner", id: string, mode: PsiEngineMode) => PsiEngine {
  return (role, id, mode) =>
    new WorkerPsiEngine(createPsiCryptoWorkerHandle(spawn({ role, id, mode })));
}
