import { describe, expect, test } from "vitest";
import PSI from "@openmined/psi.js";

import { MAX_PSI_DECODE_ELEMENTS } from "../../src/connection/frameSize";
import { partnerStepWaitMs } from "../../src/connection/partnerStepWait";
import { prepareForExchange, type PreparedExchange } from "../../src/exchange";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import {
  phaseResult,
  runPsiPhasePair,
  type EngineFor,
} from "../utils/psiPhasePair";

import type { LinkageTerms } from "../../src/config/linkageTermsSchema";

// The PSI phase raises its connection's inactivity budget once, from the
// agreed sizes, before either party waits on the other. A partner step longer
// than the connection's default is then waited through, at a lowered scale:
// the default here is a fraction of a second, and the partner's setup step is
// held past it.

const psiLibrary = await PSI();

const TERMS: LinkageTerms = {
  version: "1.0.0",
  date: "2026-11-07",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "last_name", type: "last_name" },
    { name: "ssn4", type: "ssn4" },
  ],
  linkageKeys: [
    {
      name: "LN + SSN4",
      elements: [{ field: "last_name" }, { field: "ssn4" }],
    },
  ],
};
const COLUMNS = ["last_name", "ssn4"];

function preparedParty(
  identity: string,
  rows: Array<Record<string, string>>,
): PreparedExchange {
  return prepareForExchange(
    { linkageTerms: { ...TERMS, identity } },
    identity,
    rows,
    COLUMNS,
  );
}

const RECEIVER = preparedParty("Receiver Co", [
  { last_name: "Moss", ssn4: "1001" },
  { last_name: "Hart", ssn4: "3003" },
  { last_name: "Lund", ssn4: "5005" },
]);
const SENDER = preparedParty("Sender Co", [
  { last_name: "Moss", ssn4: "1001" },
  { last_name: "Ross", ssn4: "6006" },
]);

const DEFAULT_BUDGET_MS = 200;
const SETUP_STEP_MS = 4 * DEFAULT_BUDGET_MS;

// The starter's setup, held for `delayMs` before it runs, standing in for a
// partner's long PSI step.
const slowSetup =
  (delayMs: number): EngineFor =>
  (role, id, mode) => {
    const engine = new InProcessPsiEngine(psiLibrary, role, id, mode);
    return new Proxy(engine, {
      get(target, property) {
        const member: unknown = Reflect.get(target, property, target);
        if (typeof member !== "function") return member;
        const bound = (member as (...a: Array<unknown>) => unknown).bind(
          target,
        );
        if (property !== "createServerSetup") return bound;
        return async (...args: Array<unknown>) => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return bound(...args);
        };
      },
    });
  };

describe("the wait through a partner's PSI step", () => {
  test("each party raises its budget once, to the wait the agreed sizes derive", async () => {
    const outcome = await runPsiPhasePair(psiLibrary, TERMS, RECEIVER, SENDER);
    const expected = partnerStepWaitMs({
      localValueSlots: 3,
      partnerValueSlots: 2,
      localReceiveCeiling: MAX_PSI_DECODE_ELEMENTS,
      partnerReceiveCeiling: MAX_PSI_DECODE_ELEMENTS,
    });
    expect(expected).toBe(60 * 60 * 1000);
    expect(outcome.receiver.raisedTo).toEqual([expected]);
    expect(outcome.sender.raisedTo).toEqual([expected]);
  });

  test("a partner step past the transport's default budget does not end the run", async () => {
    const outcome = await runPsiPhasePair(
      psiLibrary,
      TERMS,
      RECEIVER,
      SENDER,
      slowSetup(SETUP_STEP_MS),
      undefined,
      undefined,
      {
        inactivityTimeoutMs: DEFAULT_BUDGET_MS,
        inactivityTimeoutRaisable: true,
      },
    );
    expect(phaseResult(outcome.receiver).associationTable).toEqual([[0], [0]]);
  });

  test("the same step past a budget the operator set ends the run with the peer-inactivity refusal", async () => {
    const outcome = await runPsiPhasePair(
      psiLibrary,
      TERMS,
      RECEIVER,
      SENDER,
      slowSetup(SETUP_STEP_MS),
      undefined,
      undefined,
      { inactivityTimeoutMs: DEFAULT_BUDGET_MS },
    );
    expect(outcome.receiver.result.status).toBe("rejected");
    expect(() => phaseResult(outcome.receiver)).toThrow(
      `no message arrived within ${DEFAULT_BUDGET_MS} ms; the partner appears to have gone silent`,
    );
  });
});
