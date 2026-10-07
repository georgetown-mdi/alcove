// The PSI phase of an exchange: the crypto engine and participant, the link
// run the agreed terms select, and the teardown that disposes the engine.
import { PSIParticipant } from "../psi/participant.js";
import { InProcessPsiEngine } from "../psi/psiEngine.js";
import { reportsCountToSender } from "../protocolSetup.js";
import {
  linkViaCountOnlyPSI,
  linkViaPSI,
  linkViaSinglePassPSI,
} from "../psi/link.js";
import { connectionEndReader } from "../connection/messageConnection.js";
import { getLogger } from "../utils/logger.js";
import { sanitizeErrorForDisplay } from "../utils/sanitizeErrorForDisplay.js";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { LinkageTerms } from "../config/linkageTermsSchema.js";
import type { PsiElementBounds } from "../connection/frameSize.js";
import type { MessageConnection } from "../connection/messageConnection.js";
import type { RunExchangeOptions } from "../exchange.js";
import type { EntityClusterSummary } from "../psi/entityClosure.js";
import type {
  LinkageCardinality,
  SinglePassSessionBounds,
} from "../psi/link.js";
import type { PsiEngineMode } from "../psi/psiEngine.js";
import type { StandardizedKeyIterable } from "../standardization.js";
import type { AssociationTable } from "../types.js";

/**
 * Run the PSI phase of an exchange over the agreed terms: build this party's
 * crypto engine and participant, run the count-only, single-pass or cascade
 * link the terms select, and dispose the engine and close each round's row
 * reporting on every exit path. A link failure is rethrown unchanged.
 */
export async function runPsiPhase(p: {
  conn: MessageConnection;
  psiLibrary: PSILibrary;
  psiEngineFactory: RunExchangeOptions["psiEngineFactory"];
  isReceiver: boolean;
  countOnly: boolean;
  verbosity: number;
  elementBounds: PsiElementBounds;
  onPsiProgress: RunExchangeOptions["onPsiProgress"];
  roundsSentInParts: boolean;
  localReceiveCeiling: number;
  partnerReceiveCeiling: number;
  linkageKeyIterables: StandardizedKeyIterable[];
  linkageTerms: LinkageTerms;
  partnerTerms: LinkageTerms;
  rowCount: number;
  partnerRecordCount: number;
  cardinality: LinkageCardinality;
  singlePassBounds: SinglePassSessionBounds;
  withholdSenderTable: boolean;
  onStage: (id: string) => void;
}): Promise<{
  associationTable: AssociationTable | undefined;
  intersectionCount: number | undefined;
  entityClusters: EntityClusterSummary | undefined;
}> {
  const {
    conn,
    psiLibrary,
    psiEngineFactory,
    isReceiver,
    countOnly,
    verbosity,
    elementBounds,
    onPsiProgress,
    roundsSentInParts,
    localReceiveCeiling,
    partnerReceiveCeiling,
    linkageKeyIterables,
    linkageTerms,
    partnerTerms,
    rowCount,
    partnerRecordCount,
    cardinality,
    singlePassBounds,
    withholdSenderTable,
    onStage,
  } = p;

  // Single-pass is allowlisted; any other value (including the default) runs the
  // cascade. No mismatch guard needed here -- validateCompatibility already
  // aborted upstream if the two parties' strategies differ. Single-pass takes the
  // exchanged bounds too: the partner's record count and both parties' effective
  // key counts derive the per-exchange frame cap, the abort-if-over-ceiling gate,
  // and the index-table layout, identically on both parties (see
  // linkViaSinglePassPSI and frameSize.ts).
  //
  // The engine is built before the disposing try, so a throw in the
  // PSIParticipant constructor still reaches the finally that terminates its
  // worker; only the participant is built inside. The default in-process engine
  // is built from `psiLibrary` too, since it holds the secret key.
  const psiRole = isReceiver ? "joiner" : "starter";
  const psiId = isReceiver ? "client" : "server";
  // The disclosure this round is built for, fixed once from the agreed
  // algorithm and generated into the engine's key material rather than
  // chosen when the result is read: a count-only engine refuses the
  // operations that would name a match, and an identifier-revealing one
  // refuses to report a cardinality, so a round cannot resolve to the
  // disclosure the other mode's terms agreed. It also rides the receiver's
  // request on the wire, where the partner's sender enforces agreement.
  const engineMode: PsiEngineMode = countOnly
    ? "count-only"
    : "identifier-revealing";
  const engine =
    psiEngineFactory?.(psiRole, psiId, engineMode) ??
    new InProcessPsiEngine(psiLibrary, psiRole, psiId, engineMode);

  let participant: PSIParticipant | undefined;
  let associationTable: AssociationTable | undefined;
  let intersectionCount: number | undefined;
  let entityClusters: EntityClusterSummary | undefined;
  try {
    participant = new PSIParticipant(
      psiId,
      psiLibrary,
      { role: psiRole, verbose: verbosity },
      elementBounds,
      engine,
      onPsiProgress,
      roundsSentInParts
        ? { local: localReceiveCeiling, partner: partnerReceiveCeiling }
        : undefined,
    );
    // A crypto step does not start once the connection has ended, since its
    // result has nowhere to go, and one in flight stops at its next chunk
    // boundary: terminating the CLI's worker inside a native backend call
    // aborts the process, so the worker stops itself between calls. The
    // operator is told of the loss when it happens rather than when the step
    // returns.
    participant.stopOperationsWhen(connectionEndReader(conn));
    const psiParticipant = participant; // narrowed for closure
    void conn.terminated?.().then((ended) => {
      const inFlight = psiParticipant.operationInFlight();
      const stopsAtChunk = psiParticipant.stopOperationInFlight();
      if (ended.kind !== "closed" && inFlight)
        getLogger("exchange").warn(
          `the connection to the exchange partner ended ` +
            `(${sanitizeErrorForDisplay(ended)}) while a PSI crypto step was ` +
            "running; the run stops with that error " +
            (stopsAtChunk
              ? "when the step's current chunk finishes."
              : "once the step finishes, which on a large input can take minutes."),
        );
    });
    if (countOnly)
      // One round over one key, resolving to the intersection size and nothing that
      // names a match. The count-report leg is part of the same call: both parties
      // derive whether it runs from the agreed entitlements, so the receiver never
      // sends a frame the sender will not read and the sender never awaits one the
      // receiver will not send. The reported figure is bounded by the smaller of the
      // two exchanged record counts, which is authenticated session state on both
      // sides -- an intersection cannot exceed either party's dataset.
      intersectionCount = await linkViaCountOnlyPSI(
        participant,
        conn,
        linkageKeyIterables,
        reportsCountToSender(
          linkageTerms.output.expectsOutput,
          partnerTerms.output.expectsOutput,
        ),
        Math.min(rowCount, partnerRecordCount),
        verbosity,
        onStage,
      );
    else
      associationTable =
        linkageTerms.linkageStrategy === "single-pass"
          ? await linkViaSinglePassPSI(
              { cardinality },
              participant,
              conn,
              linkageKeyIterables,
              singlePassBounds,
              withholdSenderTable,
              verbosity,
              onStage,
              (summary) => {
                entityClusters = summary;
              },
            )
          : await linkViaPSI(
              { cardinality },
              participant,
              conn,
              linkageKeyIterables,
              singlePassBounds,
              verbosity,
              onStage,
              (summary) => {
                entityClusters = summary;
              },
            );
  } finally {
    // Dispose the crypto engine once the PSI phase is done (or has thrown); the
    // participant is not used past this point. Disposing the participant frees its
    // engine -- the default in-process engine frees its library server/client objects
    // (the secret key among the WASM-heap state they hold), and a worker-backed engine
    // terminates its worker, so a ref'd worker handle can never hold the process open
    // at teardown. If the constructor threw before the participant took ownership,
    // dispose the engine directly -- whether psiEngineFactory spawned a worker or the
    // default in-process engine was built above, it is a live engine here and never
    // orphaned.
    if (participant !== undefined) participant.dispose();
    else engine.dispose();
    // Every round has been read as far as it ever will be, so each one states
    // the drop and wide-row totals its per-row lines stopped short of. Inside
    // the finally so a round that reached either sink before the PSI phase
    // threw still reports it, and after the disposal, which frees key material
    // and is not to be risked on a diagnostic line. closeRowReporting never
    // throws, so this teardown's own exception -- the failure the operator
    // needs -- is never at risk of being replaced by a diagnostic sink's.
    for (const round of linkageKeyIterables) round.closeRowReporting();
  }

  return { associationTable, intersectionCount, entityClusters };
}
