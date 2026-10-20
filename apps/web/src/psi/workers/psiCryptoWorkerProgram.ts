import {
  InProcessPsiEngine,
  psiEngineOptionsForBackend,
  servePsiEngine,
} from "@alcove/core";

import {
  createBufferingRequestRouter,
  decodePsiWorkerInit,
} from "./psiCryptoController";

import type {
  PsiBackendSelection,
  PsiWorkerRequest,
  PsiWorkerResponse,
} from "@alcove/core";

import type {
  PsiCryptoWorkerSeed,
  PsiHelperSetupReport,
  PsiKeyPortsMessage,
} from "./psiCryptoController";

// The PSI worker's program, both shards of it, kept out of the browser-only
// entry so a unit test can run it in process over real MessageChannels. A
// primary generates the round's key and posts a copy down each port of the
// one key-ports message its seed admits; a helper builds its engine only from
// the key that arrives on its one port, and refuses every request without it.
// The key is never posted to the page.

/** The parts of a dedicated worker's global scope the program uses. */
export interface PsiCryptoWorkerScope {
  readonly name: string;
  onmessage:
    ((event: { data: PsiWorkerRequest | PsiKeyPortsMessage }) => void) | null;
  postMessage: (message: PsiWorkerResponse | PsiHelperSetupReport) => void;
}

/** Loads the PSI library the worker's engine runs on. */
export type LoadPsiWorkerLibrary = () => Promise<PsiBackendSelection>;

const HELPER_WITHOUT_KEY = "the PSI helper worker received no key";

/** Run the PSI worker named by `scope.name`'s seed in `scope`. */
export function runPsiCryptoWorker(
  scope: PsiCryptoWorkerScope,
  loadLibrary: LoadPsiWorkerLibrary,
): void {
  const seed = decodePsiWorkerInit(scope.name);
  const post = (response: PsiWorkerResponse): void =>
    scope.postMessage(response);
  let givePorts: ((ports: ReadonlyArray<MessagePort>) => void) | undefined;
  const keyPorts = new Promise<ReadonlyArray<MessagePort>>((resolve) => {
    givePorts = resolve;
  });
  const route = createBufferingRequestRouter(
    seed.shard === "helper"
      ? () => startHelper(seed, loadLibrary, keyPorts, scope)
      : () => startPrimary(seed, loadLibrary, keyPorts, post),
    (id, error) => post({ id, ok: false, error }),
  );
  scope.onmessage = (event) => {
    const message = event.data;
    if (!("kind" in message)) {
      if (seed.shard === "primary") givePorts = undefined;
      route(message);
      return;
    }
    if (givePorts !== undefined && admitsKeyPorts(seed, message.ports))
      givePorts(message.ports);
    else refuseKey(message.ports);
    givePorts = undefined;
  };
}

// The pool posts a primary's one key-ports message before any request, with
// a port for each helper the seed names. A primary admits only its first such
// message and only in that shape, so under the single-worker seed, which
// names no helpers, no message takes the key out of the worker.
function admitsKeyPorts(
  seed: PsiCryptoWorkerSeed,
  ports: ReadonlyArray<MessagePort>,
): boolean {
  if (seed.shard === "helper") return true;
  return seed.helpers > 0 && ports.length === seed.helpers;
}

async function startPrimary(
  seed: PsiCryptoWorkerSeed,
  loadLibrary: LoadPsiWorkerLibrary,
  keyPorts: Promise<ReadonlyArray<MessagePort>>,
  post: (response: PsiWorkerResponse) => void,
): Promise<(request: PsiWorkerRequest) => void> {
  let engine: InProcessPsiEngine;
  try {
    const { library, backend } = await loadLibrary();
    engine = new InProcessPsiEngine(
      library,
      seed.role,
      seed.id,
      seed.mode,
      psiEngineOptionsForBackend(backend),
    );
  } catch (error) {
    void keyPorts.then(refuseKey);
    throw error;
  }
  void keyPorts.then((ports) => sendKey(engine, ports));
  return servePsiEngine(engine, post);
}

// Each port takes its own copy, transferred rather than cloned, so no copy
// stays on this side. A port whose copy or post fails is sent a refusal,
// which its helper rejects and reports as a failed setup. A post that throws
// transferred nothing, so its copy is zeroed here; a detached one is empty.
function sendKey(
  engine: InProcessPsiEngine,
  ports: ReadonlyArray<MessagePort>,
): void {
  for (const port of ports) {
    let key: Uint8Array | undefined;
    try {
      key = engine.copySecretKey();
      port.postMessage(key, [key.buffer]);
      port.close();
    } catch {
      if (key !== undefined && key.byteLength > 0) key.fill(0);
      refuse(port);
    }
  }
}

// The ports of a primary that failed to start, and of a message a worker
// does not admit, get the refusal a failed copy gets: a closed port fires no
// message, so a helper left without one waits until the pool's setup timeout.
function refuseKey(ports: ReadonlyArray<MessagePort>): void {
  for (const port of ports) refuse(port);
}

function refuse(port: MessagePort): void {
  try {
    port.postMessage(null);
  } catch {
    // Nothing more reaches this helper, which fails at the setup timeout.
  }
  port.close();
}

async function startHelper(
  seed: PsiCryptoWorkerSeed,
  loadLibrary: LoadPsiWorkerLibrary,
  keyPorts: Promise<ReadonlyArray<MessagePort>>,
  scope: PsiCryptoWorkerScope,
): Promise<(request: PsiWorkerRequest) => void> {
  const received = keyPorts.then(receiveKey);
  try {
    const [{ library, backend }, key] = await Promise.all([
      loadLibrary(),
      received,
    ]);
    let engine: InProcessPsiEngine;
    try {
      engine = new InProcessPsiEngine(library, seed.role, seed.id, seed.mode, {
        ...psiEngineOptionsForBackend(backend),
        secretKey: key,
      });
    } finally {
      key.fill(0);
    }
    scope.postMessage({ kind: "helper-setup", ready: true });
    return servePsiEngine(engine, (response) => scope.postMessage(response));
  } catch (error) {
    // A library load that fails before or after the key arrives leaves the
    // key unused, so it is zeroed whenever it comes.
    void received.then(
      (key) => key.fill(0),
      () => undefined,
    );
    scope.postMessage({ kind: "helper-setup", ready: false });
    throw error;
  }
}

function receiveKey(ports: ReadonlyArray<MessagePort>): Promise<Uint8Array> {
  if (ports.length !== 1) {
    for (const each of ports) each.close();
    return Promise.reject(new Error(HELPER_WITHOUT_KEY));
  }
  const [port] = ports;
  return new Promise((resolve, reject) => {
    port.onmessage = (event: MessageEvent<unknown>) => {
      port.close();
      if (event.data instanceof Uint8Array) resolve(event.data);
      else reject(new Error(HELPER_WITHOUT_KEY));
    };
    // A key that fails to deserialize fires this rather than a message.
    port.onmessageerror = () => {
      port.close();
      reject(new Error(HELPER_WITHOUT_KEY));
    };
  });
}
