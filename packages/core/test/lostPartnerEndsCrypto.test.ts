import { afterEach, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import {
  ConnectionError,
  createMessagePipe,
} from "../src/connection/messageConnection";
import { InProcessPsiEngine } from "../src/psi/psiEngine";
import { getLogger } from "../src/utils/logger";

import type { LinkageTerms } from "../src/config/linkageTermsSchema";
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

// The PSI sender's engine, whose setup finishes only when the test says so: it
// stands for a masking that takes minutes. `started` resolves when the setup
// is asked for.
function heldSenderEngine() {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let finish!: () => void;
  let disposed = false;
  const inner = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "server",
    "identifier-revealing",
  );
  const engine: PsiEngine = {
    createServerSetup: (values) => {
      markStarted();
      return new Promise((resolve, reject) => {
        finish = () => inner.createServerSetup(values).then(resolve, reject);
      });
    },
    processClientRequest: (bytes) => inner.processClientRequest(bytes),
    createClientRequest: (values) => inner.createClientRequest(values),
    receiveServerSetup: (bytes) => inner.receiveServerSetup(bytes),
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

// Runs both parties over one pipe. `sender` and `receiver` resolve to the
// connections of the parties that resolved to those PSI roles.
function runPair(senderEngine?: PsiEngine) {
  const [connInitiator, connResponder] = createMessagePipe();
  const conns = { sender: connInitiator, receiver: connResponder };
  const factoryFor =
    (conn: typeof connInitiator, other: typeof connInitiator) =>
    (role: "starter" | "joiner"): PsiEngine => {
      if (role === "starter") {
        conns.sender = conn;
        conns.receiver = other;
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
