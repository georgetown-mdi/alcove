// Two parties' PSI phases (runPsiPhase) over agreed terms, run against each
// other in memory, with the roles fixed by the caller rather than resolved
// from the terms exchange. For terms the terms-exchange parse refuses, so a
// test can drive what the run does with them past the agreed-terms boundary.
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import {
  MAX_PSI_DECODE_ELEMENTS,
  psiElementBounds,
} from "../../src/connection/frameSize";
import {
  createMessagePipe,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import { runPsiPhase } from "../../src/exchange/psiPhase";
import {
  declaredEffectiveKeyCount,
  declaredKeyWidth,
} from "../../src/fanOutFunctions";
import { linkageRounds } from "../../src/linkageKeyCondition";
import { runsSinglePassLink } from "../../src/linkageTermsPolicy";
import { InProcessPsiEngine, type PsiEngine } from "../../src/psi/psiEngine";
import { roundKeyIterable } from "../../src/standardization";

import type { LinkageTerms } from "../../src/config/linkageTermsSchema";
import type { PreparedExchange } from "../../src/exchange";
import type { AssociationTable } from "../../src/types";

/** The set a party's engine was handed to encrypt, and which one it was. */
export interface EngineSet {
  readonly kind: "setup" | "request";
  readonly values: ReadonlyArray<string>;
}

/** One party's PSI phase, settled, with the frames it sent. */
export interface PhaseOutcome {
  readonly result: PromiseSettledResult<{
    associationTable: AssociationTable | undefined;
    intersectionCount: number | undefined;
  }>;
  readonly sent: Array<unknown>;
  readonly stages: Array<string>;
  readonly sets: Array<EngineSet>;
}

// The engine, with every set it is handed to encrypt recorded first.
function recordingSets(engine: PsiEngine, sets: Array<EngineSet>): PsiEngine {
  return new Proxy(engine, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      return (...args: Array<unknown>) => {
        if (
          property === "createPermutedSetup" ||
          property === "createServerSetup" ||
          property === "createClientRequest"
        )
          sets.push({
            kind: property === "createClientRequest" ? "request" : "setup",
            values: [...(args[0] as ReadonlyArray<string>)],
          });
        return (member as (...a: Array<unknown>) => unknown).apply(
          target,
          args,
        );
      };
    },
  });
}

function recording(
  conn: MessageConnection,
  sent: Array<unknown>,
): MessageConnection {
  return {
    send: (data) => {
      sent.push(data);
      return conn.send(data);
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}

/**
 * Runs `receiver` and `sender` against each other through runPsiPhase over
 * `terms`, both parties' agreed terms. A party that fails closes its end,
 * so the other is not left waiting.
 */
export async function runPsiPhasePair(
  psiLibrary: PSILibrary,
  terms: LinkageTerms,
  receiver: PreparedExchange,
  sender: PreparedExchange,
): Promise<{ receiver: PhaseOutcome; sender: PhaseOutcome }> {
  const [receiverEnd, senderEnd] = createMessagePipe();
  const countOnly = terms.algorithm === "psi-c";
  const rounds = linkageRounds(terms.linkageKeys);
  const effectiveKeyCount = declaredEffectiveKeyCount(terms);
  const elementBounds = psiElementBounds(
    { effectiveKeyCount, recordCount: sender.rowCount },
    { effectiveKeyCount, recordCount: receiver.rowCount },
  );

  const run = async (
    end: MessageConnection,
    own: PreparedExchange,
    partner: PreparedExchange,
    isReceiver: boolean,
  ): Promise<PhaseOutcome> => {
    const sent: Array<unknown> = [];
    const stages: Array<string> = [];
    const sets: Array<EngineSet> = [];
    const conn = recording(end, sent);
    const result = await runPsiPhase({
      conn,
      psiLibrary,
      psiEngineFactory: (role, id, mode) =>
        recordingSets(new InProcessPsiEngine(psiLibrary, role, id, mode), sets),
      isReceiver,
      countOnly,
      verbosity: 0,
      elementBounds,
      onPsiProgress: undefined,
      roundsSentInParts: !runsSinglePassLink(terms),
      localReceiveCeiling: MAX_PSI_DECODE_ELEMENTS,
      partnerReceiveCeiling: MAX_PSI_DECODE_ELEMENTS,
      linkageKeyIterables: rounds.map((round) =>
        roundKeyIterable(round, own.dataset, own.rowCount, isReceiver),
      ),
      linkageTerms: terms,
      partnerTerms: terms,
      rowCount: own.rowCount,
      declaredRecordCount: own.rowCount,
      partnerRecordCount: partner.rowCount,
      cardinality: "one-to-one",
      singlePassBounds: {
        partnerRecordCount: partner.rowCount,
        keyWidths: rounds.map(({ key, keyIndex }) =>
          declaredKeyWidth(key, keyIndex),
        ),
        localFanOutFactor: 1,
      },
      withholdSenderTable: false,
      onStage: (id) => stages.push(id),
    }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => {
        conn.close();
        return { status: "rejected" as const, reason };
      },
    );
    return { result, sent, stages, sets };
  };

  const [receiverOutcome, senderOutcome] = await Promise.all([
    run(receiverEnd, receiver, sender, true),
    run(senderEnd, sender, receiver, false),
  ]);
  return { receiver: receiverOutcome, sender: senderOutcome };
}

/** A settled phase's result, or its failure thrown. */
export function phaseResult(outcome: PhaseOutcome): {
  associationTable: AssociationTable | undefined;
  intersectionCount: number | undefined;
} {
  if (outcome.result.status === "rejected") throw outcome.result.reason;
  return outcome.result.value;
}
