import { afterEach, expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import type { MessageConnection } from "../src/connection/messageConnection";
import type { TermsRotation } from "../src/protocolSetup";
import type { NextSecretInputs } from "../src/nextSecret";
import { NEXT_SECRET_STORE_FAILED_ABORT_REASON } from "../src/partnerAbortFrame";
import { PeerAbortError } from "../src/errors";
import { randomBytes } from "../src/utils/crypto";
import { getLogger } from "../src/utils/logger";
import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import type { HandshakeRole, PsiRole } from "../src/types";

// The initiator drops the previous secret it kept on the responder's first
// frame after terms message 3 that is not an abort (docs/spec/PROTOCOL.md, "The
// rotation at the terms exchange"). A completed run in every exchange mode, in
// either PSI role, must give it one, or the previous secret would outlive
// every completed run.

const psiLibrary = await PSI();

afterEach(() => vi.restoreAllMocks());

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

const MODES: ReadonlyArray<{
  name: string;
  terms: (identity: string) => LinkageTerms;
}> = [
  { name: "cascade", terms: baseTerms },
  {
    name: "single-pass",
    terms: (identity) => ({
      ...baseTerms(identity),
      linkageStrategy: "single-pass",
    }),
  },
  {
    name: "count-only",
    terms: (identity) => ({ ...baseTerms(identity), algorithm: "psi-c" }),
  },
];

const names = ["Alice", "Carol", "Henry", "Irene", "Oscar"];
const rowsOf = (count: number) =>
  names.slice(0, count).map((first_name) => ({ first_name }));

interface Recorded {
  events: string[];
  resolvedRoles: Partial<Record<HandshakeRole, PsiRole>>;
}

function rotationFor(
  role: HandshakeRole,
  inputs: NextSecretInputs,
  recorded: Recorded,
  responderStoreFails = false,
): TermsRotation {
  return {
    inputs,
    store: () => {
      if (role === "responder" && responderStoreFails)
        throw new Error("the store failed");
      recorded.events.push(`${role} stored`);
    },
    partnerStored: () => {
      recorded.events.push(`${role} dropped`);
    },
  };
}

async function runPair(
  mode: (typeof MODES)[number],
  initiatorRows: number,
  responderRows: number,
  responderStoreFails = false,
) {
  const inputs: NextSecretInputs = {
    sessionKey: randomBytes(32),
    keyAgreementOutput: randomBytes(32),
    initiatorValue: randomBytes(32),
    expires: undefined,
  };
  const recorded: Recorded = { events: [], resolvedRoles: {} };
  const [rawI, rawR] = createMessagePipe();
  // The responder's sends past its store are recorded, to order them against
  // the initiator's drop.
  const responderConn: MessageConnection = {
    send: async (data) => {
      if (recorded.events.includes("responder stored"))
        recorded.events.push("responder sent");
      await rawR.send(data);
    },
    receive: (t) => rawR.receive(t),
    close: () => rawR.close(),
  };
  const run = (
    role: HandshakeRole,
    conn: MessageConnection,
    identity: string,
    rows: number,
  ) =>
    runExchange(
      conn,
      role,
      prepareForExchange(
        { linkageTerms: mode.terms(identity) },
        identity,
        rowsOf(rows),
        ["first_name"],
      ),
      {
        psiLibrary,
        rotation: rotationFor(role, inputs, recorded, responderStoreFails),
        onProtocolConfirmed: (_terms, resolvedRole) => {
          recorded.resolvedRoles[role] = resolvedRole;
        },
      },
    );
  const outcomes = await Promise.allSettled([
    run("initiator", rawI, "Initiator Co", initiatorRows),
    run("responder", responderConn, "Responder Co", responderRows),
  ]);
  await rawI.close();
  await rawR.close();
  return { outcomes, recorded };
}

for (const mode of MODES) {
  test(`a completed ${mode.name} run gives the initiator a frame past the terms exchange in either PSI role, and it drops once, after the responder stored`, async () => {
    vi.spyOn(getLogger("exchange"), "warn").mockImplementation(() => {});
    const seen = new Set<PsiRole | undefined>();
    for (const [initiatorRows, responderRows] of [
      [2, 5],
      [5, 2],
    ] as const) {
      const { outcomes, recorded } = await runPair(
        mode,
        initiatorRows,
        responderRows,
      );
      expect(outcomes.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
      seen.add(recorded.resolvedRoles.initiator);
      const drops = recorded.events.filter((e) => e.endsWith("dropped"));
      expect(drops).toEqual(["initiator dropped"]);
      const at = (event: string) => recorded.events.indexOf(event);
      expect(at("initiator stored")).toBeLessThan(at("responder stored"));
      expect(at("responder stored")).toBeLessThan(at("responder sent"));
      expect(at("responder sent")).toBeLessThan(at("initiator dropped"));
    }
    // The two record-count orders put the initiator in each PSI role.
    expect(seen.size).toBe(2);
  });
}

test("an abort from the responder after proceed does not drop the previous secret", async () => {
  vi.spyOn(getLogger("exchange"), "warn").mockImplementation(() => {});
  const { outcomes, recorded } = await runPair(MODES[0]!, 2, 5, true);
  expect(outcomes[0].status).toBe("rejected");
  const reason = (outcomes[0] as PromiseRejectedResult).reason as unknown;
  expect(reason).toBeInstanceOf(PeerAbortError);
  expect((reason as PeerAbortError).partnerReason).toBe(
    NEXT_SECRET_STORE_FAILED_ABORT_REASON,
  );
  expect(recorded.events).toContain("initiator stored");
  expect(recorded.events.filter((e) => e.endsWith("dropped"))).toEqual([]);
});
