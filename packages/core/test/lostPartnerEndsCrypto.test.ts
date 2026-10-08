import { ConnectionError } from "../src/errors";
import { afterEach, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { EncryptedMessageConnection } from "../src/connection/encryptedMessageConnection";
import { createMessagePipe } from "../src/connection/messageConnection";
import { InProcessPsiEngine } from "../src/psi/psiEngine";
import { PsiOperationStoppedError } from "../src/psi/psiWorkerEngine";
import { getLogger } from "../src/utils/logger";

import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import type { MessageConnection } from "../src/connection/messageConnection";
import type { PsiEngine } from "../src/psi/psiEngine";

// A partner lost while this party's crypto step is in flight: the step runs to
// its end, the operator is told of the loss when it happens, and the run then
// fails with the connection's error.

const psiLibrary = await PSI();
const logger = getLogger("exchange");

afterEach(() => vi.restoreAllMocks());

const LOSS_NOTICE = "while a PSI crypto step was running";

const terms = (identity: string): LinkageTerms => ({
  version: "1.0.0",
  identity,
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
});

const rows = [
  { first_name: "Alice" },
  { first_name: "Carol" },
  { first_name: "Henry" },
];

// The PSI sender's engine, whose `held` step finishes only when the test says
// so: it stands for a masking that takes minutes. `started` resolves when the
// step is asked for. A `stoppable` engine ends the held step when asked to
// stop, as the worker-backed engine does at its next chunk boundary.
function heldSenderEngine({
  stoppable = false,
  held = "createServerSetup",
}: {
  stoppable?: boolean;
  held?: "createServerSetup" | "processClientRequest";
} = {}) {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let finish!: () => void;
  let stop: (() => void) | undefined;
  let disposed = false;
  const inner = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "server",
    "identifier-revealing",
  );
  const hold = <T>(run: () => Promise<T>): Promise<T> => {
    markStarted();
    return new Promise((resolve, reject) => {
      finish = () => run().then(resolve, reject);
      stop = () => reject(new PsiOperationStoppedError());
    });
  };
  const engine: PsiEngine = {
    createServerSetup: (values) =>
      held === "createServerSetup"
        ? hold(() => inner.createServerSetup(values))
        : inner.createServerSetup(values),
    ...(stoppable && {
      stopInFlight: () => {
        if (stop === undefined) return false;
        stop();
        stop = undefined;
        return true;
      },
    }),
    processClientRequest: (bytes) =>
      held === "processClientRequest"
        ? hold(() => inner.processClientRequest(bytes))
        : inner.processClientRequest(bytes),
    createClientRequest: (values) => inner.createClientRequest(values),
    receiveServerSetup: (bytes) => inner.receiveServerSetup(bytes),
    receiveServerSetupPiece: (piece) => inner.receiveServerSetupPiece(piece),
    completeServerSetup: () => inner.completeServerSetup(),
    computeAssociationTable: (bytes) => inner.computeAssociationTable(bytes),
    computeIntersectionCardinality: (bytes) =>
      inner.computeIntersectionCardinality(bytes),
    dispose: () => {
      disposed = true;
      inner.dispose();
    },
  };
  return {
    engine,
    started,
    finish: () => finish(),
    isDisposed: () => disposed,
  };
}

const SESSION_KEY = new Uint8Array(32).fill(0x42) as Uint8Array<ArrayBuffer>;

// Both ends of one pipe, each wrapped in the encrypted channel the CLI runs an
// exchange over.
async function encryptedPipe(): Promise<
  [MessageConnection, MessageConnection]
> {
  const [rawA, rawB] = createMessagePipe();
  return Promise.all([
    EncryptedMessageConnection.create(rawA, SESSION_KEY, "initiator"),
    EncryptedMessageConnection.create(rawB, SESSION_KEY, "responder"),
  ]);
}

// Runs both parties over one pipe. `sender` and `receiver` resolve to the
// connections of the parties that resolved to those PSI roles.
// `onSenderEngine` takes the receiver's connection once the sender's engine is
// built, before the sender's first crypto step.
function runPair(
  senderEngine?: PsiEngine,
  onSenderEngine?: (receiver: MessageConnection) => void,
  pipe: [MessageConnection, MessageConnection] = createMessagePipe(),
) {
  const [connInitiator, connResponder] = pipe;
  const conns = { sender: connInitiator, receiver: connResponder };
  const factoryFor =
    (conn: typeof connInitiator, other: typeof connInitiator) =>
    (role: "starter" | "joiner"): PsiEngine => {
      if (role === "starter") {
        conns.sender = conn;
        conns.receiver = other;
        onSenderEngine?.(other);
        if (senderEngine !== undefined) return senderEngine;
      }
      return new InProcessPsiEngine(
        psiLibrary,
        role,
        role === "starter" ? "server" : "client",
        "identifier-revealing",
      );
    };
  const run = (
    conn: typeof connInitiator,
    other: typeof connInitiator,
    role: "initiator" | "responder",
    identity: string,
  ) =>
    runExchange(
      conn,
      role,
      prepareForExchange({ linkageTerms: terms(identity) }, identity, rows, [
        "first_name",
      ]),
      { psiLibrary, psiEngineFactory: factoryFor(conn, other) },
    );
  return {
    conns,
    outcomes: Promise.allSettled([
      run(connInitiator, connResponder, "initiator", "Initiator Co"),
      run(connResponder, connInitiator, "responder", "Responder Co"),
    ]),
  };
}

const lossNotices = (warn: { mock: { calls: Array<Array<unknown>> } }) =>
  warn.mock.calls.filter((call) => String(call[0]).includes(LOSS_NOTICE));

test("a partner lost during the sender's setup is reported at once, and the run fails once the step ends", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const held = heldSenderEngine();
  const { conns, outcomes } = runPair(held.engine);

  await held.started;
  // The pipe fails the far end as a dropped transport when this end closes.
  await conns.receiver.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(lossNotices(warn)).toHaveLength(1);
  // A worker inside a native masking call aborts the process when terminated,
  // so the engine outlives the loss until its step returns.
  expect(held.isDisposed()).toBe(false);

  held.finish();
  const settled = await outcomes;
  for (const outcome of settled) expect(outcome.status).toBe("rejected");
  expect(
    settled.some(
      (outcome) =>
        (outcome as PromiseRejectedResult).reason instanceof ConnectionError,
    ),
  ).toBe(true);
  expect(lossNotices(warn)).toHaveLength(1);
  expect(held.isDisposed()).toBe(true);
});

test("a local close during the sender's setup reports no partner loss", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const held = heldSenderEngine();
  const { conns, outcomes } = runPair(held.engine);

  await held.started;
  await conns.sender.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  held.finish();
  for (const outcome of await outcomes) expect(outcome.status).toBe("rejected");
  expect(lossNotices(warn)).toHaveLength(0);
});

test("a local close of the encrypted channel during the sender's setup reports no partner loss", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const held = heldSenderEngine();
  const { conns, outcomes } = runPair(
    held.engine,
    undefined,
    await encryptedPipe(),
  );

  await held.started;
  await conns.sender.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  held.finish();
  const settled = await outcomes;
  for (const outcome of settled) expect(outcome.status).toBe("rejected");
  const senderOutcome = settled.find(
    (outcome) =>
      (outcome as PromiseRejectedResult).reason instanceof ConnectionError &&
      (outcome as PromiseRejectedResult).reason.kind === "usage",
  );
  expect(senderOutcome).toBeDefined();
  expect(lossNotices(warn)).toHaveLength(0);
});

test("a run that completes reports no loss when its connection closes", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const { conns, outcomes } = runPair();
  const settled = await outcomes;
  for (const outcome of settled) expect(outcome.status).toBe("fulfilled");
  await conns.sender.close();
  await conns.receiver.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(lossNotices(warn)).toHaveLength(0);
});

test("a partner lost before the sender's setup starts fails the run without starting it", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const held = heldSenderEngine();
  let setupStarted = false;
  void held.started.then(() => (setupStarted = true));
  const { outcomes } = runPair(held.engine, (receiver) => {
    void receiver.close();
  });

  const settled = await outcomes;
  for (const outcome of settled) expect(outcome.status).toBe("rejected");
  expect(
    settled.some(
      (outcome) =>
        (outcome as PromiseRejectedResult).reason instanceof ConnectionError,
    ),
  ).toBe(true);
  expect(setupStarted).toBe(false);
  expect(lossNotices(warn)).toHaveLength(0);
  expect(held.isDisposed()).toBe(true);
});

test("a partner lost during a stoppable sender's setup stops the step and fails the run without waiting for it", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const held = heldSenderEngine({ stoppable: true });
  const { conns, outcomes } = runPair(held.engine);

  await held.started;
  await conns.receiver.close();
  const settled = await outcomes;
  for (const outcome of settled) expect(outcome.status).toBe("rejected");
  expect(
    settled.some(
      (outcome) =>
        (outcome as PromiseRejectedResult).reason instanceof ConnectionError,
    ),
  ).toBe(true);
  expect(
    settled.some(
      (outcome) =>
        (outcome as PromiseRejectedResult).reason instanceof
        PsiOperationStoppedError,
    ),
  ).toBe(false);
  expect(lossNotices(warn)).toHaveLength(1);
  expect(String(lossNotices(warn)[0]![0])).toContain(
    "when the step's current chunk finishes",
  );
  expect(held.isDisposed()).toBe(true);
});

test("a partner lost while the sender processes its request reports the lost connection, not a frame that failed to decode", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const held = heldSenderEngine({
    stoppable: true,
    held: "processClientRequest",
  });
  const pipe = createMessagePipe();
  const { conns, outcomes } = runPair(held.engine, undefined, pipe);

  await held.started;
  await conns.receiver.close();
  const settled = await outcomes;
  const senderOutcome = settled[conns.sender === pipe[0] ? 0 : 1]!;

  expect(senderOutcome.status).toBe("rejected");
  const reason = (senderOutcome as PromiseRejectedResult).reason as Error;
  // The stop the lost connection raised is replaced by that connection's own
  // error, rather than the partner's request being blamed.
  expect(reason).toBeInstanceOf(ConnectionError);
  expect((reason as ConnectionError).kind).toBe("transport");
  expect(reason).not.toBeInstanceOf(PsiOperationStoppedError);
  expect(reason.message).not.toMatch(/failed to decode/);
  expect(lossNotices(warn)).toHaveLength(1);
  expect(held.isDisposed()).toBe(true);
});

test("an engine is disposed when building its participant throws", async () => {
  const refusal = new Error("progress observer refused");
  const disposed: Array<"starter" | "joiner"> = [];
  // The participant registers the progress observer in its constructor, so an
  // engine that refuses it makes that constructor throw.
  const factory = (role: "starter" | "joiner"): PsiEngine => {
    const inner = new InProcessPsiEngine(
      psiLibrary,
      role,
      role === "starter" ? "server" : "client",
      "identifier-revealing",
    );
    return {
      createServerSetup: (values) => inner.createServerSetup(values),
      processClientRequest: (bytes) => inner.processClientRequest(bytes),
      createClientRequest: (values) => inner.createClientRequest(values),
      receiveServerSetup: (bytes) => inner.receiveServerSetup(bytes),
      receiveServerSetupPiece: (piece) => inner.receiveServerSetupPiece(piece),
      completeServerSetup: () => inner.completeServerSetup(),
      computeAssociationTable: (bytes) => inner.computeAssociationTable(bytes),
      computeIntersectionCardinality: (bytes) =>
        inner.computeIntersectionCardinality(bytes),
      observeProcessedElements: () => {
        throw refusal;
      },
      dispose: () => {
        disposed.push(role);
        inner.dispose();
      },
    };
  };
  const [connInitiator, connResponder] = createMessagePipe();
  const run = (
    conn: MessageConnection,
    role: "initiator" | "responder",
    identity: string,
  ) =>
    runExchange(
      conn,
      role,
      prepareForExchange({ linkageTerms: terms(identity) }, identity, rows, [
        "first_name",
      ]),
      { psiLibrary, psiEngineFactory: factory, onPsiProgress: () => {} },
    );

  const settled = await Promise.allSettled([
    run(connInitiator, "initiator", "Initiator Co"),
    run(connResponder, "responder", "Responder Co"),
  ]);
  for (const outcome of settled) {
    expect(outcome.status).toBe("rejected");
    expect((outcome as PromiseRejectedResult).reason).toBe(refusal);
  }
  expect(disposed.sort()).toEqual(["joiner", "starter"]);
});
