import {
  InProcessPsiEngine,
  ShardedPsiEngine,
  WorkerPsiEngine,
  psiEngineOptionsForBackend,
  servePsiEngine,
} from "@alcove/core";

import {
  createBufferingRequestRouter,
  decodePsiWorkerInit,
} from "./psiCryptoController";

import type {
  PsiBackendSelection,
  PsiWorkerHandle,
  PsiWorkerRequest,
  PsiWorkerResponse,
} from "@alcove/core";

import type {
  PsiCryptoWorkerSeed,
  PsiHelperSetupReport,
  PsiKeyPortsMessage,
  PsiShardSplitMessage,
} from "./psiCryptoController";

// The PSI worker's program, both shards of it, kept out of the browser-only
// entry so a unit test can run it in process over real MessageChannels. A
// primary generates the round's key and posts a copy down each port of the
// one key-ports message its seed admits; a helper builds its engine only from
// the key that arrives on its one port, and refuses every request without it.
// The key is never posted to the page. A split runs over the same ports: the
// primary sends each helper its part and merges the answers itself, so the
// page sees only the merged message.

/** The parts of a dedicated worker's global scope the program uses. */
export interface PsiCryptoWorkerScope {
  readonly name: string;
  onmessage:
    | ((event: {
        data: PsiWorkerRequest | PsiKeyPortsMessage | PsiShardSplitMessage;
      }) => void)
    | null;
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
  let giveSplit: (message: PsiShardSplitMessage) => void = () => undefined;
  const split = new Promise<PsiShardSplitMessage>((resolve) => {
    giveSplit = resolve;
  });
  const route = createBufferingRequestRouter(
    seed.shard === "helper"
      ? () => startHelper(seed, loadLibrary, keyPorts, scope)
      : () => startPrimary(seed, loadLibrary, keyPorts, split, post),
    (id, error) => post({ id, ok: false, error }),
  );
  scope.onmessage = (event) => {
    const message = event.data;
    if (!("kind" in message)) {
      if (seed.shard === "primary") givePorts = undefined;
      route(message);
      return;
    }
    if (message.kind === "shard-split") {
      giveSplit(message);
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

// The page sends a split only once every helper has set up, after the key's
// delivery, so its ports are known by then and the switch to the sharded
// engine is made before the split request behind it is read.
async function startPrimary(
  seed: PsiCryptoWorkerSeed,
  loadLibrary: LoadPsiWorkerLibrary,
  keyPorts: Promise<ReadonlyArray<MessagePort>>,
  split: Promise<PsiShardSplitMessage>,
  post: (response: PsiWorkerResponse) => void,
): Promise<(request: PsiWorkerRequest) => void> {
  let engine: InProcessPsiEngine;
  let loaded: PsiBackendSelection;
  try {
    loaded = await loadLibrary();
    engine = new InProcessPsiEngine(
      loaded.library,
      seed.role,
      seed.id,
      seed.mode,
      psiEngineOptionsForBackend(loaded.backend),
    );
  } catch (error) {
    void keyPorts.then(refuseKey);
    throw error;
  }
  const helperPorts = keyPorts.then((ports) => sendKey(engine, ports));
  let serve = servePsiEngine(engine, post);
  void Promise.all([helperPorts, split]).then(([ports, message]) => {
    if (!message.split) {
      for (const port of ports) port.close();
      return;
    }
    const sharded = new ShardedPsiEngine(
      loaded.library,
      seed.id,
      seed.mode,
      engine,
      ports.map((port) => new WorkerPsiEngine(helperOverPort(port))),
      { shardProgressTimeoutMs: message.progressTimeoutMs },
    );
    serve = servePsiEngine(sharded, post);
  });
  return (request) => serve(request);
}

// Each port takes its own copy, transferred rather than cloned, so this code
// keeps no buffer of it. psi.js keeps an unzeroed copy of the key bytes in a JS
// array and in WASM temporaries, out of this code's reach. A port whose copy
// or post fails is sent a refusal, which its helper rejects and reports as a
// failed setup. A post that throws transferred nothing, so its copy is zeroed
// here; a detached one is empty. Returns the ports the key went down, which
// stay open for the split.
function sendKey(
  engine: InProcessPsiEngine,
  ports: ReadonlyArray<MessagePort>,
): Array<MessagePort> {
  const keyed: Array<MessagePort> = [];
  for (const port of ports) {
    let key: Uint8Array | undefined;
    try {
      key = engine.copySecretKey();
      port.postMessage(key, [key.buffer]);
      keyed.push(port);
    } catch {
      if (key !== undefined && key.byteLength > 0) key.fill(0);
      refuse(port);
    }
  }
  return keyed;
}

// A helper as the primary drives it, over the port its key went down. A
// stop the page raised throws from the progress sink a helper's tick
// reaches, and fails that helper's call rather than escaping the handler.
function helperOverPort(port: MessagePort): PsiWorkerHandle {
  return {
    postMessage: (request) => port.postMessage(request),
    setHandlers: ({ onMessage, onError }) => {
      port.onmessage = (event: MessageEvent<PsiWorkerResponse>) => {
        try {
          onMessage(event.data);
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      };
      port.onmessageerror = () =>
        onError(new Error("PSI crypto worker failed"));
    },
    terminate: () => port.close(),
  };
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
    const [{ library, backend }, { key, port }] = await Promise.all([
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
    // The primary sends its parts down the port the key came on, and takes
    // each answer on it.
    const servePrimary = servePsiEngine(engine, (response) =>
      port.postMessage(response),
    );
    port.onmessage = (event: MessageEvent<PsiWorkerRequest>) =>
      servePrimary(event.data);
    scope.postMessage({ kind: "helper-setup", ready: true });
    return servePsiEngine(engine, (response) => scope.postMessage(response));
  } catch (error) {
    // A library load that fails before or after the key arrives leaves the
    // key unused, so it is zeroed whenever it comes.
    void received.then(
      ({ key, port }) => {
        key.fill(0);
        port.close();
      },
      () => undefined,
    );
    scope.postMessage({ kind: "helper-setup", ready: false });
    throw error;
  }
}

function receiveKey(
  ports: ReadonlyArray<MessagePort>,
): Promise<{ key: Uint8Array; port: MessagePort }> {
  if (ports.length !== 1) {
    for (const each of ports) each.close();
    return Promise.reject(new Error(HELPER_WITHOUT_KEY));
  }
  const [port] = ports;
  return new Promise((resolve, reject) => {
    port.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data instanceof Uint8Array) {
        resolve({ key: event.data, port });
        return;
      }
      port.close();
      reject(new Error(HELPER_WITHOUT_KEY));
    };
    // A key that fails to deserialize fires this rather than a message.
    port.onmessageerror = () => {
      port.close();
      reject(new Error(HELPER_WITHOUT_KEY));
    };
  });
}
