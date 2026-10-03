import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../../src/psi/participant";
import {
  PsiOperationStoppedError,
  WorkerPsiEngine,
  servePsiWorker,
  type PsiWorkerHandle,
  type PsiWorkerResponse,
} from "../../src/psi/psiWorkerEngine";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

// A stop requested while an operation runs takes effect at the next chunk
// boundary, so at most one more chunk runs after the request: the worker is
// never torn down inside a library call.

const psiLibrary = await PSI();

const CHUNK_ELEMENTS = 20;
const VALUES = Array.from({ length: 100 }, (_, index) => `v-${index}`);

// A WorkerPsiEngine over an in-process dispatcher, cloning each message as a
// real worker boundary does; the shared stop flag survives the clone as shared
// memory, as it does across worker_threads.
function chunkingWorkerEngine(): {
  engine: WorkerPsiEngine;
  posted: Array<PsiWorkerResponse>;
  terminated: () => number;
} {
  const posted: Array<PsiWorkerResponse> = [];
  let terminateCalls = 0;
  let deliver: (response: PsiWorkerResponse) => void = () => {};
  const dispatch = servePsiWorker(
    psiLibrary,
    { role: "starter", id: "server", mode: "identifier-revealing" },
    (response) => {
      const cloned = structuredClone(response);
      posted.push(cloned);
      deliver(cloned);
    },
    { chunkElements: CHUNK_ELEMENTS },
  );
  const handle: PsiWorkerHandle = {
    postMessage: (request) => dispatch(structuredClone(request)),
    setHandlers: ({ onMessage }) => {
      deliver = onMessage;
    },
    terminate: () => {
      terminateCalls += 1;
    },
  };
  return {
    engine: new WorkerPsiEngine(handle),
    posted,
    terminated: () => terminateCalls,
  };
}

test("a stop requested at the first chunk boundary ends the operation at the next one", async () => {
  const { engine, posted } = chunkingWorkerEngine();
  const seen: Array<number> = [];
  const accepted: Array<boolean> = [];
  engine.observeProcessedElements((processed) => {
    seen.push(processed);
    accepted.push(engine.stopInFlight());
  });
  try {
    await expect(engine.createServerSetup(VALUES)).rejects.toBeInstanceOf(
      PsiOperationStoppedError,
    );
  } finally {
    engine.dispose();
  }
  expect(seen).toStrictEqual([CHUNK_ELEMENTS]);
  expect(accepted).toStrictEqual([true]);
  expect(posted.at(-1)).toMatchObject({ ok: false, stopped: true });
});

test("a stop between operations does nothing, and the next operation runs to its end", async () => {
  const { engine } = chunkingWorkerEngine();
  try {
    expect(engine.stopInFlight()).toBe(false);
    const { setup } = await engine.createServerSetup(VALUES);
    expect(setup.byteLength).toBeGreaterThan(0);
  } finally {
    engine.dispose();
  }
});

test("dispose during an operation asks it to stop before terminating the worker", async () => {
  const { engine, posted, terminated } = chunkingWorkerEngine();
  engine.observeProcessedElements(() => engine.dispose());
  await expect(engine.createServerSetup(VALUES)).rejects.toThrow(
    "PSI worker engine is disposed",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(terminated()).toBe(1);
  expect(posted.at(-1)).toMatchObject({ ok: false, stopped: true });
});

test("a participant's stopped operation fails with the stop reason it was given", async () => {
  const { engine } = chunkingWorkerEngine();
  const participant = new PSIParticipant(
    "server",
    psiLibrary,
    { role: "starter", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
    engine,
  );
  const partnerLost = new Error("partner lost");
  let lost = false;
  participant.stopOperationsWhen(() => (lost ? partnerLost : undefined));
  engine.observeProcessedElements(() => {
    lost = true;
    expect(participant.stopOperationInFlight()).toBe(true);
  });
  try {
    await expect(participant.createServerSetup(VALUES)).rejects.toBe(
      partnerLost,
    );
  } finally {
    participant.dispose();
  }
});
