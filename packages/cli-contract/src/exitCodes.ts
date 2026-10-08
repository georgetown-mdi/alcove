// The CLI's process exit codes. What each means and what a supervisor does
// with it: docs/CLI.md#exit-codes, which lists EXIT_CODE_TABLE row for row.

/**
 * `EX_USAGE` (64): refused for something the operator supplied. Every
 * `UsageError` reports it.
 */
export const USAGE_EXIT_CODE = 64;

/**
 * `EX_UNAVAILABLE` (69): a failure no other code names, transport failures
 * among them. The one failure code a supervisor retries.
 */
export const UNAVAILABLE_EXIT_CODE = 69;

/**
 * `EX_SOFTWARE` (70): a check on Alcove's own state failed, core's
 * `InternalConsistencyError`.
 */
export const INTERNAL_FAULT_EXIT_CODE = 70;

/**
 * `EX_PROTOCOL` (76): the partner or the agreed terms refused the run. The code
 * for a `protocol`-kind `ConnectionError`, a `PeerAbortError`, a
 * `ReceiptVerificationError` and core's `ProtocolRefusalError`.
 */
export const PARTNER_REFUSED_EXIT_CODE = 76;

/**
 * `EX_NOPERM` (77): authentication failed. The code for core's
 * `AuthenticationError`, and for the refusal of a rotated shared secret this
 * party could not save.
 */
export const AUTHENTICATION_FAILED_EXIT_CODE = 77;

/**
 * `EX_DATAERR` (65): `alcove verify-receipt` reached a definite verification
 * failure. `worseReceiptVerdictExitCode` reports it when either half of a
 * record fails.
 */
export const RECEIPT_VERIFICATION_FAILED_EXIT_CODE = 65;

/**
 * `EX_NOINPUT` (66): `alcove verify-receipt` found nothing wrong but could not
 * run a check for want of an input.
 */
export const RECEIPT_VERIFICATION_INCOMPLETE_EXIT_CODE = 66;

/**
 * `EX_NOINPUT` (66): an input file the run reads is not there
 * (`InputNotFoundError`).
 */
export const INPUT_NOT_FOUND_EXIT_CODE = 66;

/**
 * `EX_CANTCREAT` (73): the exchange completed and a local write did not. See
 * docs/spec/CLI_EVENTS.md#persistence-loss.
 */
export const PERSISTENCE_LOSS_EXIT_CODE = 73;

/** `EX_CONFIG` (78): `alcove doctor` only, its checks found something to fix. */
export const DOCTOR_FINDINGS_EXIT_CODE = 78;

/** A run interrupted by `SIGINT`: 128 plus the signal number. */
export const INTERRUPTED_EXIT_CODE = 130;

/** A run terminated by `SIGTERM`: 128 plus the signal number. */
export const TERMINATED_EXIT_CODE = 143;

/** An error that escaped every command handler. */
export const UNCAUGHT_ERROR_EXIT_CODE = 1;

/** One row of {@link EXIT_CODE_TABLE}. */
export interface ExitCodeTableRow {
  /** The process exit code. */
  readonly code: number;
  /** The `sysexits` name, or a short label for a code outside it. */
  readonly name: string;
  /** `platform` when the process was ended from outside. */
  readonly setBy: "alcove" | "platform";
}

/** Every exit code a supervisor can see, in docs/CLI.md#exit-codes order. */
export const EXIT_CODE_TABLE: readonly ExitCodeTableRow[] = [
  { code: 0, name: "success", setBy: "alcove" },
  { code: USAGE_EXIT_CODE, name: "EX_USAGE", setBy: "alcove" },
  {
    code: RECEIPT_VERIFICATION_FAILED_EXIT_CODE,
    name: "EX_DATAERR",
    setBy: "alcove",
  },
  { code: INPUT_NOT_FOUND_EXIT_CODE, name: "EX_NOINPUT", setBy: "alcove" },
  { code: UNAVAILABLE_EXIT_CODE, name: "EX_UNAVAILABLE", setBy: "alcove" },
  { code: INTERNAL_FAULT_EXIT_CODE, name: "EX_SOFTWARE", setBy: "alcove" },
  { code: PERSISTENCE_LOSS_EXIT_CODE, name: "EX_CANTCREAT", setBy: "alcove" },
  { code: PARTNER_REFUSED_EXIT_CODE, name: "EX_PROTOCOL", setBy: "alcove" },
  {
    code: AUTHENTICATION_FAILED_EXIT_CODE,
    name: "EX_NOPERM",
    setBy: "alcove",
  },
  { code: DOCTOR_FINDINGS_EXIT_CODE, name: "EX_CONFIG", setBy: "alcove" },
  {
    code: INTERRUPTED_EXIT_CODE,
    name: "interrupted (SIGINT)",
    setBy: "alcove",
  },
  { code: TERMINATED_EXIT_CODE, name: "terminated (SIGTERM)", setBy: "alcove" },
  { code: 134, name: "aborted (SIGABRT)", setBy: "platform" },
  { code: 137, name: "killed (SIGKILL)", setBy: "platform" },
  { code: UNCAUGHT_ERROR_EXIT_CODE, name: "unexpected error", setBy: "alcove" },
];
