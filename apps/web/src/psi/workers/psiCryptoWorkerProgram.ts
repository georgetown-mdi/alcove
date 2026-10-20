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
// primary generates the round's key and posts a copy down each port the page
// gives it; a helper builds its engine only from the key that arrives on its
// one port, and refuses every request without it. The key is never posted
// to the page.

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
  let givePorts: (ports: ReadonlyArray<MessagePort>) => void = () => undefined;
  let portsGiven = false;
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
      route(message);
      return;
    }
    if (portsGiven) for (const port of message.ports) port.close();
    else givePorts(message.ports);
    portsGiven = true;
  };
}

async function startPrimary(
  seed: PsiCryptoWorkerSeed,
  loadLibrary: LoadPsiWorkerLibrary,
  keyPorts: Promise<ReadonlyArray<MessagePort>>,
  post: (response: PsiWorkerResponse) => void,
): Promise<(request: PsiWorkerRequest) => void> {
  const { library, backend } = await loadLibrary();
  const engine = new InProcessPsiEngine(
    library,
    seed.role,
    seed.id,
    seed.mode,
    psiEngineOptionsForBackend(backend),
  );
  void keyPorts.then((ports) => sendKey(engine, ports));
  return servePsiEngine(engine, post);
}

// Each port takes its own copy, transferred rather than cloned, so no copy
// stays on this side. A port whose copy fails closes without one, and its
// helper then reports a failed setup.
function sendKey(
  engine: InProcessPsiEngine,
  ports: ReadonlyArray<MessagePort>,
): void {
  for (const port of ports) {
    try {
      const key = engine.copySecretKey();
      port.postMessage(key, [key.buffer]);
    } catch {
      // The helper's setup report states the failure.
    } finally {
      port.close();
    }
  }
}

async function startHelper(
  seed: PsiCryptoWorkerSeed,
  loadLibrary: LoadPsiWorkerLibrary,
  keyPorts: Promise<ReadonlyArray<MessagePort>>,
  scope: PsiCryptoWorkerScope,
): Promise<(request: PsiWorkerRequest) => void> {
  try {
    const [{ library, backend }, key] = await Promise.all([
      loadLibrary(),
      keyPorts.then(receiveKey),
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
  });
}
