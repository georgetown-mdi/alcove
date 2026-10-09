import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { PSIParticipant } from "../../src/psi/participant";
import { linkViaPSI, linkViaSinglePassPSI } from "../../src/psi/link";
import { createMessagePipe } from "../../src/connection/messageConnection";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import type {
  InProcessPsiEngineOptions,
  PsiEngine,
} from "../../src/psi/psiEngine";
import {
  isPsiLibraryFailure,
  ConnectionError,
  PartnerProtocolRefusalError,
  ProtocolRefusalError,
} from "../../src/errors";
import {
  WorkerPsiEngine,
  servePsiWorker,
  type PsiWorkerHandle,
  type PsiWorkerResponse,
} from "../../src/psi/psiWorkerEngine";
import type { Config } from "../../src/types";
import { sortAssociationTable } from "../../src/testing";
import { classifyFailure } from "../../src/failureClass";
import { serializeSetup } from "../../src/psi/psiChunks";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";
import { loadNativeAddonOrSkip } from "../utils/nativeAddon";
import { fanOutFreeBounds } from "../utils/singlePassBounds";

const psiLibrary = await PSI();
const nativeLibrary = await loadNativeAddonOrSkip();

// A WorkerPsiEngine wired to an in-process dispatcher instead of a real
// thread, so the request/response protocol, id correlation, and (via
// structuredClone at the boundary) the clonability of everything that
// crosses it are all exercised without spawning a worker. A value that is
// not clonable -- a live library handle leaking across the boundary --
// would throw here exactly as it would in production.
function inProcessWorkerEngine(
  role: Config["role"],
  id: string,
  options: InProcessPsiEngineOptions = {},
  library: PSILibrary = psiLibrary,
): WorkerPsiEngine {
  let deliver: (response: PsiWorkerResponse) => void = () => {};
  const dispatch = servePsiWorker(
    library,
    { role, id, mode: "identifier-revealing" },
    (response) => deliver(structuredClone(response)),
    options,
  );
  const handle: PsiWorkerHandle = {
    postMessage: (request) => dispatch(structuredClone(request)),
    setHandlers: ({ onMessage }) => {
      deliver = onMessage;
    },
    terminate: () => {},
  };
  return new WorkerPsiEngine(handle);
}

function repliesWith(
  failure: Omit<Extract<PsiWorkerResponse, { ok: false }>, "id" | "ok">,
): WorkerPsiEngine {
  let deliver: (response: PsiWorkerResponse) => void = () => {};
  return new WorkerPsiEngine({
    postMessage: (request) =>
      deliver({ id: request.id, ok: false, ...failure }),
    setHandlers: ({ onMessage }) => {
      deliver = onMessage;
    },
    terminate: () => {},
  });
}

describe("the refusal discriminant of a failed worker reply", () => {
  test("a plain refusal is rebuilt as a protocol refusal that is not the partner's", async () => {
    const engine = repliesWith({
      error: "refused",
      refusal: { kind: "protocol" },
    });
    const refused = await rejection(engine.createServerSetup(["a"]));
    expect(refused).toBeInstanceOf(ProtocolRefusalError);
    expect(refused).not.toBeInstanceOf(PartnerProtocolRefusalError);
  });

  test.for([undefined, "partner", "this-party", "unknown"] as const)(
    "a partner refusal keeps its older version (%s)",
    async (olderVersion) => {
      const engine = repliesWith({
        error: "refused",
        refusal: { kind: "partner-protocol", olderVersion },
      });
      const refused = await rejection(engine.createServerSetup(["a"]));
      expect(refused).toBeInstanceOf(PartnerProtocolRefusalError);
      expect((refused as PartnerProtocolRefusalError).olderVersion).toBe(
        olderVersion,
      );
    },
  );

  test("a reply with no refusal is a plain error", async () => {
    const engine = repliesWith({ error: "boom" });
    const refused = await rejection(engine.createServerSetup(["a"]));
    expect(refused).not.toBeInstanceOf(ProtocolRefusalError);
  });
});

function workerParticipant(
  id: string,
  role: "starter" | "joiner",
): PSIParticipant {
  return new PSIParticipant(
    id,
    psiLibrary,
    { role, verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
    inProcessWorkerEngine(role, id),
  );
}

// A joiner participant over `engine`, for driving a fault raised inside the
// engine through the PSI frame boundary the participant's methods wrap.
function joinerOver(engine: PsiEngine): PSIParticipant {
  return new PSIParticipant(
    "receiver",
    psiLibrary,
    { role: "joiner", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
    engine,
  );
}

// The frames computeValueMatches takes: well-formed and within the element
// bounds, so the fault under test is the only thing that can fail the call.
function joinerMatchFrames(): [Uint8Array, Uint8Array] {
  return [
    new psiLibrary.serverSetup().serializeBinary(),
    new psiLibrary.response().serializeBinary(),
  ];
}

async function rejection(call: Promise<unknown>): Promise<Error | undefined> {
  return call.then(
    () => undefined,
    (err: unknown) => err as Error,
  );
}

// The same inputs and known-correct result as the in-process cascade in
// link.test.ts; a worker-backed exchange must reproduce them exactly.
const serverData = [
  ["Alice", "Bob", "Carol", "David", "Elizabeth", "Frank", "Greta"],
  ["1", "2", "1", "1", "1", "1", "1"],
];
const clientData = [
  ["Carol", "Elizabeth", "Henry"],
  ["3", "3", "2"],
];

test("a worker-backed cascade exchange yields the correct result", async () => {
  const [serverConn, clientConn] = createMessagePipe();
  const server = workerParticipant("server", "starter");
  const client = workerParticipant("client", "joiner");

  const [serverResultRaw, clientResultRaw] = await Promise.all([
    linkViaPSI(
      { cardinality: "one-to-one" },
      server,
      serverConn,
      serverData,
      fanOutFreeBounds(serverData.length, clientData[0].length),
      -1,
    ),
    linkViaPSI(
      { cardinality: "one-to-one" },
      client,
      clientConn,
      clientData,
      fanOutFreeBounds(clientData.length, serverData[0].length),
      -1,
    ),
  ]);
  const serverResult = sortAssociationTable(serverResultRaw);
  const clientResult = sortAssociationTable(clientResultRaw, true);

  expect(serverResult[0]).toStrictEqual([1, 2, 4]);
  expect(serverResult[1]).toStrictEqual([2, 0, 1]);
  // Both parties agree.
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
});

test("a worker-backed single-pass exchange yields the correct result", async () => {
  const [serverConn, clientConn] = createMessagePipe();
  const server = workerParticipant("server", "starter");
  const client = workerParticipant("client", "joiner");

  const [serverResultRaw, clientResultRaw] = await Promise.all([
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      server,
      serverConn,
      serverData,
      fanOutFreeBounds(serverData.length, clientData[0].length),
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      client,
      clientConn,
      clientData,
      fanOutFreeBounds(clientData.length, serverData[0].length),
      false,
      -1,
    ),
  ]);
  const serverResult = sortAssociationTable(serverResultRaw);
  const clientResult = sortAssociationTable(clientResultRaw, true);

  expect(serverResult[0]).toStrictEqual([1, 2, 4]);
  expect(serverResult[1]).toStrictEqual([2, 0, 1]);
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
});

test("an engine error propagates across the worker boundary", async () => {
  const engine = inProcessWorkerEngine("joiner", "receiver");
  // A well-formed server setup with no data structure set: the engine's Raw-check
  // must reject, and the rejection must survive the round trip.
  const nonRaw = new psiLibrary.serverSetup().serializeBinary();
  await expect(engine.receiveServerSetup(nonRaw)).rejects.toThrow(
    /server setup is not a Raw data structure/,
  );
});

test("an engine refusal keeps its own message after the worker round trip", async () => {
  const participant = joinerOver(inProcessWorkerEngine("joiner", "receiver"));
  const [nonRaw, response] = joinerMatchFrames();

  const refused = await rejection(
    participant.computeValueMatches(nonRaw, response),
  );

  expect(refused?.message).toMatch(/server setup is not a Raw data structure/);
  expect(refused?.message).not.toMatch(/failed to decode/);
});

test("a library failure stays recognizable after the worker round trip", async () => {
  // Only the message crosses the boundary, so without the reply's own flag a
  // worker-backed run would raise the library's message with no frame named.
  const participant = joinerOver(inProcessWorkerEngine("joiner", "receiver"));
  const [, response] = joinerMatchFrames();

  const failure = await rejection(
    participant.computeValueMatches(
      new Uint8Array([0x0a, 0x02, 0x10, 0x01]),
      response,
    ),
  );

  expect(failure).toBeInstanceOf(ConnectionError);
  expect(failure?.message).toBe(
    "receiver protocol error: inbound PSI serverSetup failed to decode",
  );
  expect(isPsiLibraryFailure(failure?.cause)).toBe(true);
});

test("a response refused as the partner's stays a protocol refusal after the worker round trip", async () => {
  const starter = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "sender",
    "identifier-revealing",
  );
  const { setup } = await starter.createServerSetup(["a", "b", "c"]);
  starter.dispose();
  const engine = inProcessWorkerEngine("joiner", "receiver");
  try {
    await engine.receiveServerSetup(setup);
    const refused = await rejection(
      engine.computeAssociationTable(new Uint8Array([0x0b])),
    );
    expect(refused).toBeInstanceOf(PartnerProtocolRefusalError);
    expect(refused?.message).toBe(
      "receiver protocol error: malformed inbound PSI response frame",
    );
  } finally {
    engine.dispose();
  }
});

describe.each([
  { backend: "wasm", library: psiLibrary as PSILibrary | undefined },
  { backend: "native", library: nativeLibrary },
])("on the $backend backend", ({ library }) => {
  // A starter's setup over `values` with its first two elements swapped, and
  // the response to a request from `engine`, a receiver that holds no setup.
  async function swappedRound(
    psi: PSILibrary,
    engine: PsiEngine,
  ): Promise<{ setup: Uint8Array; response: Uint8Array }> {
    const starter = new InProcessPsiEngine(
      psi,
      "starter",
      "sender",
      "identifier-revealing",
    );
    try {
      const { setup } = await starter.createServerSetup(["a", "b", "c", "d"]);
      const elements = [
        ...psi.serverSetup
          .deserializeBinary(setup)
          .getRaw()!
          .getEncryptedElementsList_asU8(),
      ];
      [elements[0], elements[1]] = [elements[1]!, elements[0]!];
      const request = await engine.createClientRequest(["b", "c", "e"]);
      const response = await starter.processClientRequest(request);
      return { setup: serializeSetup(psi, elements), response };
    } finally {
      starter.dispose();
    }
  }

  const named = {
    ascending:
      "receiver protocol error: PSI server setup is not in strictly ascending element order",
    raw: "receiver protocol error: PSI server setup is not a Raw data structure",
  };

  test("a setup out of ascending order, refused as it arrives, stays the partner's refusal after the worker round trip", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    const engine = inProcessWorkerEngine("joiner", "receiver", {}, library);
    try {
      const { setup } = await swappedRound(library, engine);
      const refused = await rejection(engine.receiveServerSetup(setup));
      expect(refused).toBeInstanceOf(ProtocolRefusalError);
      expect(refused?.message).toBe(named.ascending);
      expect(classifyFailure(refused)).toBe("partner-refused");
    } finally {
      engine.dispose();
    }
  });

  test("a setup that is not a Raw data structure stays the partner's refusal after the worker round trip", async (ctx) => {
    if (!library) {
      ctx.skip();
      return;
    }
    const engine = inProcessWorkerEngine("joiner", "receiver", {}, library);
    try {
      const refused = await rejection(
        engine.receiveServerSetup(new library.serverSetup().serializeBinary()),
      );
      expect(refused).toBeInstanceOf(ProtocolRefusalError);
      expect(refused?.message).toBe(named.raw);
      expect(classifyFailure(refused)).toBe("partner-refused");
    } finally {
      engine.dispose();
    }
  });
});

test("a discarded setup is freed inside the worker, so a new setup can be received", async () => {
  const starter = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "sender",
    "identifier-revealing",
  );
  const { setup } = await starter.createServerSetup(["a", "b", "c"]);
  starter.dispose();
  const engine = inProcessWorkerEngine("joiner", "receiver");
  try {
    await engine.receiveServerSetup(setup);
    await expect(engine.receiveServerSetup(setup)).rejects.toThrow(
      /arrived while a completed setup awaits its match/,
    );
    await engine.discardServerSetup();
    await engine.receiveServerSetup(setup);
  } finally {
    engine.dispose();
  }
});

test("a disposed engine is reported as the local fault it is", async () => {
  // The decode callback wraps the whole worker round trip, so a fault of this
  // party's own -- nothing the partner sent -- reaches the frame boundary on
  // the same path a library decode failure does.
  const engine = new WorkerPsiEngine({
    postMessage: () => {},
    setHandlers: () => {},
    terminate: () => {},
  });
  const participant = joinerOver(engine);
  const [setup, response] = joinerMatchFrames();
  engine.dispose();

  const failure = await rejection(
    participant.computeValueMatches(setup, response),
  );

  expect(failure?.message).toBe("PSI worker engine is disposed");
  expect(failure?.message).not.toMatch(/failed to decode/);
  expect(failure).not.toBeInstanceOf(ConnectionError);
});

test("a worker crash mid-call is reported as the local fault it is", async () => {
  // An out-of-memory kill or an early exit reaches the engine as a worker
  // death while a call is in flight. The exchange must send the operator to
  // their own machine, not to their partner's frame.
  let fireError: (error: Error) => void = () => {};
  const engine = new WorkerPsiEngine({
    postMessage: () => fireError(new Error("PSI worker exited with code 1")),
    setHandlers: ({ onError }) => {
      fireError = onError;
    },
    terminate: () => {},
  });
  const participant = joinerOver(engine);
  const [setup, response] = joinerMatchFrames();

  const failure = await rejection(
    participant.computeValueMatches(setup, response),
  );

  expect(failure?.message).toBe("PSI worker exited with code 1");
  expect(failure?.message).not.toMatch(/failed to decode/);
  expect(failure).not.toBeInstanceOf(ConnectionError);
});

test("dispose rejects pending calls and terminates the worker", async () => {
  let terminated = false;
  // A handle that never replies, so the call stays pending until dispose settles it.
  const handle: PsiWorkerHandle = {
    postMessage: () => {},
    setHandlers: () => {},
    terminate: () => {
      terminated = true;
    },
  };
  const engine = new WorkerPsiEngine(handle);

  const pending = engine.createClientRequest(["x"]);
  engine.dispose();

  await expect(pending).rejects.toThrow(/disposed/);
  expect(terminated).toBe(true);
  // A call after dispose fails fast rather than posting to a terminated worker.
  await expect(engine.createClientRequest(["y"])).rejects.toThrow(/disposed/);
});

test("a worker error fails every outstanding call", async () => {
  let fireError: (error: Error) => void = () => {};
  const handle: PsiWorkerHandle = {
    postMessage: () => {},
    setHandlers: ({ onError }) => {
      fireError = onError;
    },
    terminate: () => {},
  };
  const engine = new WorkerPsiEngine(handle);

  const pending = engine.createServerSetup(["a", "b"]);
  fireError(new Error("worker exited unexpectedly"));

  await expect(pending).rejects.toThrow(/worker exited unexpectedly/);
});

test("a fault that is not an Error keeps the original value as its cause", async () => {
  // onError is typed for an Error, so only a JavaScript caller reaches the
  // coercion. What it produces must still hold the value it was given: String()
  // alone renders most objects "[object Object]" and loses the fault entirely.
  let fireError: (error: Error) => void = () => {};
  const handle: PsiWorkerHandle = {
    postMessage: () => {},
    setHandlers: ({ onError }) => {
      fireError = onError;
    },
    terminate: () => {},
  };
  const engine = new WorkerPsiEngine(handle);

  const pending = engine.createServerSetup(["a"]);
  const raw = { code: "ERR_WORKER_OUT_OF_MEMORY" };
  (fireError as (error: unknown) => void)(raw);

  const failure = await rejection(pending);
  expect(failure?.message).toBe("[object Object]");
  expect(failure?.cause).toBe(raw);
  expect(isPsiLibraryFailure(failure)).toBe(false);
});

test("a call after a worker error fails fast with the crash cause", async () => {
  let fireError: (error: Error) => void = () => {};
  const handle: PsiWorkerHandle = {
    postMessage: () => {},
    setHandlers: ({ onError }) => {
      fireError = onError;
    },
    terminate: () => {},
  };
  const engine = new WorkerPsiEngine(handle);

  fireError(new Error("worker exited unexpectedly"));

  // A fresh call must reject immediately with the crash cause, not hang waiting
  // for a reply from the dead worker.
  await expect(engine.createServerSetup(["a"])).rejects.toThrow(
    /worker exited unexpectedly/,
  );
});

test("a second concurrent call is rejected as a lockstep violation", async () => {
  const handle: PsiWorkerHandle = {
    // Never replies, so the first request stays in flight.
    postMessage: () => {},
    setHandlers: () => {},
    terminate: () => {},
  };
  const engine = new WorkerPsiEngine(handle);

  void engine.createServerSetup(["a"]);
  const failure = await rejection(engine.createClientRequest(["b"]));

  expect(failure?.message).toMatch(/lockstep/);
  // A caller bug on this side, so the frame boundary above states it rather
  // than re-labeling it a decode failure.
  expect(isPsiLibraryFailure(failure)).toBe(false);
});

test("a worker serves its engine options: a match fed in pieces equals the in-process one", async () => {
  const values = Array.from({ length: 200 }, (_, index) => `v-${index}`);
  const joinerValues = values.map((value, index) =>
    index % 2 === 0 ? value : `joiner-only-${index}`,
  );
  const starter = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "starter",
    "identifier-revealing",
  );
  const pieced = inProcessWorkerEngine("joiner", "pieced", {
    chunkElements: 40,
  });
  const whole = new InProcessPsiEngine(
    psiLibrary,
    "joiner",
    "whole",
    "identifier-revealing",
  );
  const ticks: Array<number> = [];
  pieced.observeProcessedElements((processed) => ticks.push(processed));
  try {
    const { setup } = await starter.createServerSetup(values);
    const match = async (joiner: PsiEngine) => {
      const response = await starter.processClientRequest(
        await joiner.createClientRequest(joinerValues),
      );
      await joiner.receiveServerSetup(setup);
      ticks.length = 0;
      return joiner.computeAssociationTable(response);
    };
    const expected = await match(whole);
    expect(expected[0]).toHaveLength(100);
    expect(await match(pieced)).toStrictEqual(expected);
    expect(ticks).toStrictEqual([40, 80, 120, 160]);
  } finally {
    starter.dispose();
    pieced.dispose();
    whole.dispose();
  }
});
