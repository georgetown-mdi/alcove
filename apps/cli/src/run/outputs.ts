import path from "node:path";

import {
  getLogger,
  runExchange,
  countIsPartnerReported,
  buildOutputTable,
  resultCsvDelimiter,
  undeclaredColumnsForOwnResult,
  describeEntityClusters,
  sanitizeErrorForDisplay,
} from "@alcove/core";
import type { PreparedExchange } from "@alcove/core";

import type { RecordDelivery, ResultDelivery } from "../exchangeOutcome";
import type { FileSyncRuntimeOptions, SigningPersist } from "../protocol";
import { writeExchangeRecord } from "../recordFile";
import { resultFilePath, runArtifactFolder } from "../resultFile";
import { writeDualSignedRecord } from "../receiptFile";
import { writeOutput } from "../util/dataIo";
import { withPersistenceLossExitCode } from "../util/exit";
import { reportPersistenceLoss, type EventStreamEmitter } from "../eventStream";

/** What {@link runExchange} resolves with, threaded into the output stage. */
export type ExchangeOutcome = Awaited<ReturnType<typeof runExchange>>;

/**
 * The run's local output stage: report the outcome, write the result CSV, then
 * the audit record, the signed receipt, and finally the caller's own
 * post-exchange persistence. Runs only after the two-party exchange completed,
 * so every failure here is local and none of it may be re-run.
 *
 * Each artifact after the result CSV is non-fatal and reports its own loss:
 * a missing one is a persistence-loss warning rather than a failed exchange.
 * The result CSV is the exception -- a result that does not reach where it was
 * owed throws, carrying `PERSISTENCE_LOSS_EXIT_CODE` so a command boundary
 * reports the loss rather than the exit code a transport fault gets. That
 * throw is raised after the audit artifacts have been written and not at the
 * write that failed: the exchange disclosed, and what it disclosed is owed its
 * record whether or not this party got to keep the result
 * (docs/notes/record-durability-point.md).
 *
 * Returns whether every artifact it owed reached disk: false once any of the
 * non-fatal losses above has been reported, the caller's own persistence
 * included -- whether that step threw or caught its failure and reported
 * `persisted: false` -- so what the run tells the operator afterwards about
 * its files keys on the artifacts rather than on this stage returning.
 */
export async function writeExchangeOutputs(params: {
  outcome: ExchangeOutcome;
  prepared: PreparedExchange;
  output: string | undefined;
  csvDelimiter: string | undefined;
  writeRecord: boolean;
  signing: SigningPersist | null;
  loggerName: string;
  log: ReturnType<typeof getLogger>;
  eventStream: EventStreamEmitter | undefined;
  onOutputComplete: FileSyncRuntimeOptions["onOutputComplete"];
  onRemoteFollowUp: FileSyncRuntimeOptions["onRemoteFollowUp"];
}): Promise<ExchangeOutputs> {
  const {
    outcome,
    prepared,
    output,
    csvDelimiter,
    writeRecord,
    signing,
    loggerName,
    log,
    eventStream,
    onOutputComplete,
    onRemoteFollowUp,
  } = params;
  const {
    associationTable,
    intersectionCount,
    entityClusters,
    resolvedRole,
    partnerPayload,
    audit,
    bootstrap,
    signedReceipt,
  } = outcome;

  // The one timestamp this run's file names share: the record's createdAt when
  // there is one, so a result named per run, the record, and the receipt pair
  // by name.
  const runCreatedAt = audit?.record.createdAt ?? new Date().toISOString();
  const artifactFolder = runArtifactFolder(output);
  const resultPath =
    output === undefined ? undefined : resultFilePath(output, runCreatedAt);

  // The result's failure -- a table that could not be built from the partner's
  // payload, or a write that did not deliver it -- held until the audit
  // artifacts below have been written. A box rather than the error itself,
  // since a thrower may raise any value, `undefined` included.
  let resultFailure: { error: unknown; notice: string } | undefined;
  let result: ResultDelivery = { kind: "withheld" };

  // A count-only exchange produces no matched pairing for either party,
  // so there is no result file to write and nothing was withheld from
  // this party: its whole result is the count, which the outcome line
  // states (describeExchangeOutcome). Checked first, since a count-only
  // receiver holds no association table either and would otherwise be
  // told it receives nothing.
  if (intersectionCount !== undefined) {
    result = {
      kind: "count",
      intersectionCount,
      reportedByPartner: countIsPartnerReported({
        intersectionCount,
        resolvedRole,
      }),
    };
  }
  // The result table is withheld (associationTable undefined) when this
  // party's agreed terms give it no output -- a one-sided exchange
  // where it is the PSI sender/helper. It contributed its records to
  // find the match but is not entitled to the result, so report that
  // plainly rather than writing an empty CSV that could be mistaken for
  // a zero-match run. The audit record below is still written (the
  // helper's record does not bind the table).
  else if (associationTable === undefined) {
    log.info(
      "your records contributed to the match, but by the " +
        "agreed terms you receive no result, so no result file was written.",
    );
  } else {
    // buildOutputTable is outside the stamp below on purpose: its
    // integrity throws (duplicate partner row indices, rows missing for
    // association indices) are partner-shaped faults, and 73's
    // published meaning is that what failed is a local write on this
    // machine. They are core's ProtocolRefusalError, exit 76, and the
    // terminal event's `output` category covers the whole stage.
    // One delimiter for the escaping and the join: buildOutputTable quotes
    // each field against it and writeOutput joins the fields with it, so the
    // file reads back through the delimiter this party chose. A party that
    // named none, or chose detection, gets a comma-separated result.
    const resultDelimiter = resultCsvDelimiter(csvDelimiter);
    let table: ReturnType<typeof buildOutputTable> | undefined;
    try {
      table = buildOutputTable(
        associationTable,
        prepared.rawRows,
        prepared.metadata,
        partnerPayload,
        prepared.includeOwnColumns,
        undeclaredColumnsForOwnResult(prepared),
        resultDelimiter,
      );
    } catch (err) {
      resultFailure = {
        error: err,
        notice:
          "the result could not be built from your partner's payload, so " +
          "no result was written",
      };
    }
    try {
      if (table !== undefined) {
        await writeOutput(
          resultPath,
          table.headers,
          table.rows,
          log,
          undefined,
          resultDelimiter,
        );
        result =
          resultPath === undefined
            ? { kind: "stdout", matchedRows: table.rows.length }
            : {
                kind: "file",
                matchedRows: table.rows.length,
                path: path.resolve(resultPath),
              };
      }
    } catch (err) {
      // The result did not reach where it was owed -- a file that did
      // not reach disk, or a stdout reader that stopped taking it before
      // the drain's ceiling -- the terminal form of the same loss the
      // persistence-loss reports share: the exchange completed, only
      // local delivery failed, and re-running would re-send this party's
      // data for an exchange that already happened. Set the
      // persistence-loss code on the error so a command boundary reports
      // it instead of the 69 a transport fault gets; exitCodeForError
      // (util/exit.ts) reads the annotated code, measured (not asserted)
      // by exchange.test.ts and zeroSetup.test.ts driving each handler to
      // a trapped process.exit.
      withPersistenceLossExitCode(err);
      // Raised below, after the record and the receipt: a disclosure that
      // occurred is owed its record whatever became of the result
      // (docs/notes/record-durability-point.md), and a result the reader of
      // a pipe refused leaves the disk the record goes to untouched.
      resultFailure = {
        error: err,
        notice: "the result was not delivered",
      };
    }
  }

  // How the entity closure grouped the pairs this party just wrote, stated
  // after the result it describes and only where that result was delivered.
  // Core hands one to a party that ran the closure over a many-to-many table
  // -- both parties under the cascade, the receiver alone under single-pass --
  // and none otherwise, so the cardinality is not re-read here. The sentence
  // is core's own composition over integers it formats itself -- the same one
  // the browser seat renders, so no two sinks drift -- and holds no
  // partner-authored text.
  if (entityClusters !== undefined && resultFailure === undefined)
    log.info(describeEntityClusters(entityClusters));

  // Every audit artifact this run was asked for and could not produce,
  // as the messages the machine-interface stream states below.
  const missingArtifacts: string[] = [];

  // Persist the self-attested record after the results: a secondary
  // audit artifact, written last, whose failure is non-fatal (see
  // writeExchangeRecord). Skipped when records are disabled, and written
  // even where the result was not delivered, since the disclosure it
  // accounts for happened either way; on a disk that failed mid-write the
  // write fails too and reports itself as a missing artifact. A withheld
  // result writes no CSV but still records the exchange. An audit
  // runExchange did not return is a record that could not be built
  // (warned there, with the cause), so it reports as a missing artifact
  // exactly as a failed write does.
  let record: RecordDelivery;
  if (!writeRecord) record = { kind: "disabled" };
  else if (audit === undefined) {
    missingArtifacts.push(
      "no exchange record could be built for this exchange, so none was " +
        "written; the exchange and its results succeeded and need not be " +
        "re-run",
    );
    record = { kind: "notWritten" };
  } else {
    const written = writeExchangeRecord(
      artifactFolder,
      audit.record,
      audit.keys,
      loggerName,
      audit.agreedTerms,
    );
    if (written.kind === "failed") {
      missingArtifacts.push(written.message);
      record = { kind: "notWritten" };
    } else
      record = {
        kind: "written",
        path: path.resolve(written.paths.recordFilePath),
      };
  }

  // Persist the signed receipt after the self-attested record.
  // Written only when the signing step ran and the signature exchange
  // completed (runExchange returns signedReceipt undefined otherwise,
  // and throws to the catch on a verification failure, so no partial
  // artifact is written for a terminated swap). Independent of the
  // self-attested record: core signs the receipt from the
  // mutually-verifiable facts regardless of whether this party's local
  // record built, so a record-build failure must not discard it. Its
  // stamp is the run's shared one above. Non-fatal, like the record write.
  if (signing !== null && signedReceipt !== undefined) {
    const failure = writeDualSignedRecord(
      signedReceipt,
      artifactFolder,
      runCreatedAt,
      loggerName,
    );
    if (failure !== undefined) missingArtifacts.push(failure);
  }

  // A lost audit artifact is not a failed exchange -- the result is written and
  // must not be re-run -- so the terminal event below stays `result`. But it is
  // not a success either: an unattended supervisor that discards stderr, or an
  // operator running at --log-level error, would otherwise read a clean exit 0
  // for a run that produced no record. Each failure therefore takes the same
  // persistence-loss report every other completed-run loss takes: a warning on
  // the machine stream and the exit code that separates "do not re-run this"
  // from a transport failure. The caller's own remaining work (a bootstrap's
  // config write) still runs and still reports what it loses.
  for (const missing of missingArtifacts)
    reportPersistenceLoss(missing, eventStream);

  let everyArtifactOnDisk = missingArtifacts.length === 0;

  // The result went nowhere, so the run fails on it and the caller's own
  // persistence below does not run: it writes configuration for a run whose
  // operator never received the result. What it would have saved is named
  // before the throw, on the same two channels every other completed-run loss
  // takes, since the partner may hold the recurring setup this side skipped
  // and the terminal error alone names only the result.
  if (resultFailure !== undefined) {
    if (onOutputComplete !== undefined) {
      const skipped =
        `${resultFailure.notice}, so the post-exchange persistence ` +
        "step did not run: what this run would have saved after the result " +
        "-- a configuration, a key file, or the payload set recorded for a " +
        "later run -- did not reach disk, and your partner may have saved a " +
        "recurring exchange this side did not. The exchange itself " +
        "completed, so do not re-run it; confirm with your partner what " +
        "each side saved before setting up a recurring exchange.";
      log.error(skipped);
      reportPersistenceLoss(skipped, eventStream);
    }
    throw resultFailure.error;
  }

  // The caller's own last persistence, run here rather than after this function
  // returns so that whatever it loses is reported BEFORE the terminal event
  // below -- the stream's terminal-is-last guarantee, and the only ordering a
  // supervisor that stops reading at the terminal event can observe.
  if (onOutputComplete !== undefined) {
    try {
      const hookOutcome = await onOutputComplete({ bootstrap });
      if (!hookOutcome.persisted) everyArtifactOnDisk = false;
    } catch (hookErr) {
      // The hook reports its own losses; reaching here means one escaped it.
      // The exchange is already complete and cannot be undone by a local
      // write, so this is non-fatal -- but a run that silently swallowed it
      // would read as a clean success to the supervisor the stream exists for.
      log.error(
        "the post-exchange persistence step failed after the exchange and " +
          "its results completed; what that step writes did not reach disk: " +
          sanitizeErrorForDisplay(hookErr),
      );
      reportPersistenceLoss(
        "a post-exchange persistence step did not complete; the exchange " +
          "and its results succeeded and must not be re-run, and the error " +
          "logged beside this notice names the step",
        eventStream,
      );
      everyArtifactOnDisk = false;
    }
  }

  if (onRemoteFollowUp !== undefined) {
    try {
      await onRemoteFollowUp();
    } catch (followUpErr) {
      log.error(
        "a post-exchange step failed after the exchange and its results " +
          "completed: " +
          sanitizeErrorForDisplay(followUpErr),
      );
      reportPersistenceLoss(
        "a post-exchange step did not complete; the exchange and its " +
          "results succeeded and must not be re-run, and the error logged " +
          "beside this notice names the step",
        eventStream,
      );
    }
  }

  return { everyArtifactOnDisk, result, record };
}

/** What {@link writeExchangeOutputs} delivered, for the run's outcome line. */
export interface ExchangeOutputs {
  /** Whether every artifact the stage owed reached disk. */
  everyArtifactOnDisk: boolean;
  /** Where this party's result went. */
  result: ResultDelivery;
  /** What became of the exchange record. */
  record: RecordDelivery;
}
