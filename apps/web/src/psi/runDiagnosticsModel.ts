/**
 * The pure model behind the console's "Diagnostics and recovery" card: the two
 * per-run controls for a run that misbehaves (capture a detailed log, sweep a
 * shared folder's leftover protocol files) and what the card refuses before
 * the run starts (docs/spec/SERVER_JOB_API.md, "The per-run controls").
 */

/** The operator's per-run diagnostic and recovery choices for one exchange. */
export interface RunDiagnosticsDraft {
  /** Run at debug verbosity and capture the CLI's log on the console. */
  diagnosticRun: boolean;
  /** Sweep the shared folder's leftover protocol files before the run. */
  sweepExchangeFiles: boolean;
  /** The operator's confirmation that no other session is using the directory,
   * required before a sweep may run. */
  sweepConfirmed: boolean;
}

/** The card's starting state: neither control on. */
export const RUN_DIAGNOSTICS_DEFAULT: RunDiagnosticsDraft = {
  diagnosticRun: false,
  sweepExchangeFiles: false,
  sweepConfirmed: false,
};

/** The sweep control's visible label, which the rendezvous preflight's
 * leftover-files warning quotes. */
export const SWEEP_CONTROL_LABEL =
  "Clear leftover exchange files before starting";

/** What the card states before a sweep runs: the sweep deletes only Alcove's
 * own protocol files, but nothing locks the directory while it does. */
export const SWEEP_CONFIRMATION_NOTICE =
  "This deletes the exchange's own leftover files - the hellos, locks, " +
  "acknowledgements, and messages a crashed or mismatched run left behind. " +
  "Anything else in the folder is left alone. Confirm no other session is " +
  "using this directory first: sweeping while an exchange is running there " +
  "destroys it.";

/** The acknowledgement the operator ticks to confirm the notice above. */
export const SWEEP_CONFIRMATION_LABEL =
  "No other session is using this directory";

/** What the card says about the CLI's retain guard before the run: the console
 * never emits `--force-retain-sweep`, so the override is the command line's. */
export const SWEEP_RETAIN_ESCALATION_NOTICE =
  "If this directory holds a retain-mode transcript - yours, or your " +
  "partner's - the sweep is refused, and only the command line can overrule " +
  "that: run the exchange with --sweep-exchange-files --force-retain-sweep, " +
  "which loses the prior transcript permanently.";

/** The problem shown while the sweep is on and unconfirmed. */
export const SWEEP_UNCONFIRMED_PROBLEM =
  "Confirm that no other session is using this directory before sweeping it.";

/** What the console says about a debug-level log before the operator asks for
 * one; the CLI creates the file owner-only for the same reason. */
export const DIAGNOSTIC_LOG_NOTICE =
  "A detailed log records what the exchange did step by step, including your " +
  "partner's identity, the linkage keys in play, and the columns involved. " +
  "It stays with this run's files on the console until you discard the " +
  "run; treat a copy you download like the results themselves.";

/**
 * The draft with one control set to a new value, the only way a surface changes
 * it. A draft whose sweep is off has no confirmation, so turning the sweep
 * back on asks again: the draft outlives any one visit to the card.
 */
export function runDiagnosticsWithControl<
  TField extends keyof RunDiagnosticsDraft,
>(
  draft: RunDiagnosticsDraft,
  field: TField,
  value: RunDiagnosticsDraft[TField],
): RunDiagnosticsDraft {
  const changed = { ...draft, [field]: value };
  return changed.sweepExchangeFiles
    ? changed
    : { ...changed, sweepConfirmed: false };
}

/** The draft after the directory a sweep would run against changes (a
 * transport switch, or an SFTP connection authored afresh): the confirmation
 * attests one directory, so it is cleared. */
export function runDiagnosticsAfterRetarget(
  draft: RunDiagnosticsDraft,
): RunDiagnosticsDraft {
  return { ...draft, sweepConfirmed: false };
}

/** The subset of a job intent this card contributes: each control present only
 * when it is on, and only ever `true`. */
export interface RunDiagnosticsIntentFields {
  diagnosticRun?: true;
  sweepExchangeFiles?: true;
}

/** The per-run fields a draft contributes to a job intent. Only an enabled
 * control is emitted, and the sweep only once confirmed, so an unconfirmed
 * draft cannot produce a sweeping intent. */
export function runDiagnosticsIntentFields(
  draft: RunDiagnosticsDraft,
): RunDiagnosticsIntentFields {
  return {
    ...(draft.diagnosticRun ? { diagnosticRun: true } : {}),
    ...(draft.sweepExchangeFiles && draft.sweepConfirmed
      ? { sweepExchangeFiles: true }
      : {}),
  };
}

/** Everything wrong with the draft, as messages to show beside the card -- empty
 * when it is admissible. The run is blocked while this is non-empty. */
export function runDiagnosticsProblems(
  draft: RunDiagnosticsDraft,
): Array<string> {
  return draft.sweepExchangeFiles && !draft.sweepConfirmed
    ? [SWEEP_UNCONFIRMED_PROBLEM]
    : [];
}
