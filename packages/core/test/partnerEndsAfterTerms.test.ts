import { afterEach, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import {
  ConnectionError,
  createMessagePipe,
} from "../src/connection/messageConnection";
import { PeerAbortError } from "../src/errors";
import { sendAbort } from "../src/protocolSetup";
import { getLogger } from "../src/utils/logger";

import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import type { MessageConnection } from "../src/connection/messageConnection";
import type { HandshakeRole } from "../src/types";

// A party that ends the exchange at any frame past the terms exchange, by
// sending an abort in that frame's place or by dropping the connection: the
// partner, parked on whatever receive awaits that frame, must report the
// partner's abort or the lost connection, never a frame that failed to parse.

const psiLibrary = await PSI();

afterEach(() => vi.restoreAllMocks());

const REFUSAL_REASON = "a refusal this party took past the terms exchange";
const LOCAL_REFUSAL = "the ending party's own refusal";

const baseTerms = (identity: string): LinkageTerms => ({
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

interface Scenario {
  name: string;
  terms: (identity: string) => LinkageTerms;
  saveIntent?: boolean;
}

// Each scenario reaches a different set of receives past the terms exchange:
// the bootstrap frame and a cascade round's tables and acknowledgement, the
// single-pass reply and resolved table, and the count-only report.
const SCENARIOS: ReadonlyArray<Scenario> = [
  { name: "a zero-setup cascade run", terms: baseTerms, saveIntent: true },
  {
    name: "a single-pass run",
    terms: (identity) => ({
      ...baseTerms(identity),
      linkageStrategy: "single-pass",
    }),
  },
  {
    name: "a count-only run",
    terms: (identity) => ({ ...baseTerms(identity), algorithm: "psi-c" }),
  },
];

type Ending = "abort" | "loss";

// `conn` with this party's sends recorded, and its `endAt`-th send replaced:
// by the abort frame a refusal sends, or by closing the connection. The send
// then throws, as the refusal does on the party that took it.
function ending(
  conn: MessageConnection,
  endAt: number,
  how: Ending,
): { conn: MessageConnection; sent: Array<unknown> } {
  const sent: Array<unknown> = [];
  return {
    sent,
    conn: {
      send: async (data: unknown) => {
        if (sent.length === endAt) {
          sent.push(undefined);
          if (how === "abort") await sendAbort(conn, [REFUSAL_REASON]);
          else await conn.close();
          throw new Error(LOCAL_REFUSAL);
        }
        sent.push(data);
        await conn.send(data);
      },
      receive: () => conn.receive(),
      close: () => conn.close(),
    },
  };
}

async function runPair(
  scenario: Scenario,
  endingRole: HandshakeRole,
  endAt: number,
  how: Ending,
) {
  const [rawInitiator, rawResponder] = createMessagePipe();
  const wrapped = ending(
    endingRole === "initiator" ? rawInitiator : rawResponder,
    endAt,
    how,
  );
  const connOf = (role: HandshakeRole) =>
    role === endingRole
      ? wrapped.conn
      : role === "initiator"
        ? rawInitiator
        : rawResponder;
  const run = (role: HandshakeRole, identity: string) =>
    runExchange(
      connOf(role),
      role,
      prepareForExchange(
        { linkageTerms: scenario.terms(identity) },
        identity,
        rows,
        ["first_name"],
      ),
      {
        psiLibrary,
        ...(scenario.saveIntent !== undefined && {
          saveIntent: scenario.saveIntent,
        }),
      },
    );
  const [initiator, responder] = await Promise.allSettled([
    run("initiator", "Initiator Co"),
    run("responder", "Responder Co"),
  ]);
  await rawInitiator.close();
  await rawResponder.close();
  return {
    sent: wrapped.sent,
    ending: endingRole === "initiator" ? initiator : responder,
    partner: endingRole === "initiator" ? responder : initiator,
  };
}

// The index of the first frame `role` sends past the terms exchange, and how
// many it sends in all, read off a run that completes.
async function framesPastTerms(
  scenario: Scenario,
  role: HandshakeRole,
): Promise<{ first: number; total: number }> {
  const { sent, ending, partner } = await runPair(
    scenario,
    role,
    Number.MAX_SAFE_INTEGER,
    "abort",
  );
  expect(ending.status).toBe("fulfilled");
  expect(partner.status).toBe("fulfilled");
  // A party's last terms frame states its decision.
  const statesDecision = sent.map(
    (frame) =>
      typeof frame === "object" &&
      frame !== null &&
      "decision" in (frame as object),
  );
  const lastTermsFrame = statesDecision.lastIndexOf(true);
  expect(lastTermsFrame).toBeGreaterThanOrEqual(0);
  return { first: lastTermsFrame + 1, total: sent.length };
}

const reasonOf = (outcome: PromiseSettledResult<unknown>): unknown => {
  expect(outcome.status).toBe("rejected");
  return (outcome as PromiseRejectedResult).reason;
};

for (const scenario of SCENARIOS) {
  for (const role of ["initiator", "responder"] as const) {
    test(`${scenario.name}: the ${role}'s partner reports an abort or a lost connection at every frame past the terms exchange`, async () => {
      vi.spyOn(getLogger("exchange"), "warn").mockImplementation(() => {});
      const { first, total } = await framesPastTerms(scenario, role);
      expect(total).toBeGreaterThan(first);

      for (let endAt = first; endAt < total; endAt += 1) {
        const aborted = await runPair(scenario, role, endAt, "abort");
        expect((reasonOf(aborted.ending) as Error).message).toBe(LOCAL_REFUSAL);
        const abortReason = reasonOf(aborted.partner);
        expect(abortReason, `abort at frame ${endAt}`).toBeInstanceOf(
          PeerAbortError,
        );

        const lost = await runPair(scenario, role, endAt, "loss");
        const lossReason = reasonOf(lost.partner);
        expect(lossReason, `loss at frame ${endAt}`).toBeInstanceOf(
          ConnectionError,
        );
        expect(lossReason).not.toBeInstanceOf(PeerAbortError);
        expect((lossReason as ConnectionError).kind).toBe("transport");
      }
    });
  }
}
