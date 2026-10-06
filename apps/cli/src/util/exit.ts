// Classifying a caught error into a process exit code, and the two boundaries
// that apply it: the classification a boundary reads when its errors vary.
// The named codes are declared in @alcove/cli-contract.

import {
  AUTHENTICATION_FAILED_EXIT_CODE,
  INPUT_NOT_FOUND_EXIT_CODE,
  INTERNAL_FAULT_EXIT_CODE,
  PARTNER_REFUSED_EXIT_CODE,
  RECEIPT_VERIFICATION_FAILED_EXIT_CODE,
  RECEIPT_VERIFICATION_INCOMPLETE_EXIT_CODE,
} from "@alcove/cli-contract";
import {
  classifyFailure,
  firstLinkBehindTransportWraps,
  getLogger,
  sanitizeErrorForDisplay,
} from "@alcove/core";
import type { FailureClass } from "@alcove/core";

import { failureRemedy } from "../failureRemedy";
import { holdsRecoveryHintTag } from "./recoveryHint";

/**
 * The next step shown beneath an `internal-fault` failure
 * ({@link classifyFailure}) whose message states none of its own: the same
 * step for every internal fault, since no input the operator controls moves
 * one and a retry reaches the same refusal.
 */
export const INTERNAL_FAULT_NEXT_STEP =
  "This is a fault in Alcove itself: report it with this message; retrying " +
  "will not help.";

/**
 * {@link INTERNAL_FAULT_NEXT_STEP} when core classifies `err` as an
 * `internal-fault` ({@link classifyFailure}) and nothing in its cause chain
 * holds core's `alcoveRecoveryHintEmitted` tag; otherwise `undefined`. A
 * tagged fault's message already states its step, so adding this one would
 * give the operator two.
 */
export function internalFaultNextStep(err: unknown): string | undefined {
  if (classifyFailure(err) !== "internal-fault") return undefined;
  return holdsRecoveryHintTag(err) ? undefined : INTERNAL_FAULT_NEXT_STEP;
}

/**
 * The next step shown beneath a partner or terms refusal whose message states
 * none of its own: the same step for every such refusal, since a retry meets
 * the same partner and the same terms.
 */
export const PARTNER_REFUSED_NEXT_STEP =
  "Contact your partner before running again: the partner or the agreed " +
  "terms refused this exchange, and retrying unchanged will fail the same way.";

/**
 * {@link PARTNER_REFUSED_NEXT_STEP} when core's class for `err`
 * ({@link classifyFailure}) takes {@link PARTNER_REFUSED_EXIT_CODE} and
 * nothing in its cause chain holds core's `alcoveRecoveryHintEmitted` tag;
 * otherwise `undefined`, for the reason {@link internalFaultNextStep} gives.
 */
export function partnerRefusalNextStep(err: unknown): string | undefined {
  if (
    exitCodeForFailureClass(classifyFailure(err)) !== PARTNER_REFUSED_EXIT_CODE
  )
    return undefined;
  return holdsRecoveryHintTag(err) ? undefined : PARTNER_REFUSED_NEXT_STEP;
}

/**
 * The fixed next step the CLI adds beneath `err`:
 * {@link internalFaultNextStep} for an exit-70 fault,
 * {@link partnerRefusalNextStep} for an exit-76 refusal, otherwise
 * `undefined`.
 */
export function fixedNextStep(err: unknown): string | undefined {
  return internalFaultNextStep(err) ?? partnerRefusalNextStep(err);
}

/**
 * The display-safe text a command boundary shows for a failure: the
 * sanitized error chain, followed on its own line by {@link fixedNextStep}
 * when that applies, else by the CLI's remedy for a catalog cause the chain
 * holds ({@link failureRemedy}). The terminal event's `message` is this same
 * text, so stderr and the event stream state the same step.
 */
export function renderFailureForOperator(err: unknown): string {
  const text = sanitizeErrorForDisplay(err);
  const nextStep = fixedNextStep(err) ?? failureRemedy(err);
  return nextStep === undefined ? text : `${text}\n${nextStep}`;
}

/**
 * An input file named on the command line or in the configuration that does
 * not exist. {@link exitCodeForError} maps it to
 * {@link INPUT_NOT_FOUND_EXIT_CODE}.
 */
export class InputNotFoundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InputNotFoundError";
  }
}

/**
 * The exit code for two verify-receipt verdicts one run reports: a failure
 * outranks an incomplete verdict, which outranks a verified one. Not a
 * numeric maximum, since the incomplete code is the larger number.
 */
export function worseReceiptVerdictExitCode(a: number, b: number): number {
  const rank = (code: number): number =>
    code === RECEIPT_VERIFICATION_FAILED_EXIT_CODE
      ? 2
      : code === RECEIPT_VERIFICATION_INCOMPLETE_EXIT_CODE
        ? 1
        : 0;
  return rank(a) >= rank(b) ? a : b;
}

/**
 * The exit code each core {@link FailureClass} reports, or `undefined` for a
 * class with no code of its own, which {@link exitCodeForError} resolves from
 * the error's own `exitCode` or EX_UNAVAILABLE (69).
 */
function exitCodeForFailureClass(
  failureClass: FailureClass,
): number | undefined {
  switch (failureClass) {
    case "usage-error":
      return 64;
    case "internal-fault":
      return INTERNAL_FAULT_EXIT_CODE;
    case "partner-refused":
    case "receipt-not-verified":
      return PARTNER_REFUSED_EXIT_CODE;
    case "authentication-failed":
      return AUTHENTICATION_FAILED_EXIT_CODE;
    case "trust-check-failed":
    case "cancelled":
    case "unavailable":
      return undefined;
  }
}

/**
 * The process exit code a caught command error reports:
 * {@link INPUT_NOT_FOUND_EXIT_CODE} (66) for an {@link InputNotFoundError},
 * bare or behind `transport`-kind wraps ({@link firstLinkBehindTransportWraps});
 * else the code of core's class for it ({@link classifyFailure}): EX_USAGE (64)
 * for `usage-error`, {@link INTERNAL_FAULT_EXIT_CODE} (70) for
 * `internal-fault`, {@link PARTNER_REFUSED_EXIT_CODE} (76) for
 * `partner-refused` and `receipt-not-verified`, and
 * {@link AUTHENTICATION_FAILED_EXIT_CODE} (77) for `authentication-failed`;
 * otherwise the error's own numeric `exitCode` when it has one, else
 * EX_UNAVAILABLE (69). The classification a boundary reads when its errors
 * vary; a boundary whose errors are all usage faults exits 64 outright.
 *
 * The own-`exitCode` rung is what gives a run whose exchange completed while
 * its result file did not reach disk `PERSISTENCE_LOSS_EXIT_CODE` (73). The
 * rung is typed rather than `??`-defaulted so a non-numeric `exitCode` on some
 * other object cannot reach `process.exit`.
 */
export function exitCodeForError(err: unknown): number {
  if (firstLinkBehindTransportWraps(err) instanceof InputNotFoundError)
    return INPUT_NOT_FOUND_EXIT_CODE;
  const classCode = exitCodeForFailureClass(classifyFailure(err));
  if (classCode !== undefined) return classCode;
  const own = (err as { exitCode?: unknown } | null | undefined)?.exitCode;
  return typeof own === "number" ? own : 69;
}

/**
 * Log a caught error ({@link renderFailureForOperator}) at error level and exit the process with
 * `code`. The single log-and-exit boundary the bootstrap-style command handlers
 * route a caught error through, so the error-level routing and the sanitized
 * formatting cannot drift between call sites. `code` is supplied by the caller
 * because the classification is site-specific: a command whose errors are all
 * local usage faults passes 64 outright, while a command whose errors vary
 * resolves the code through {@link exitCodeForError}. Typed `never` so a
 * caller's definite-assignment narrowing treats it like `process.exit`.
 */
export function exitWithError(
  log: { error: (message: string) => void },
  err: unknown,
  code: number,
): never {
  log.error(renderFailureForOperator(err));
  return exitOnFailure(err, code);
}

/**
 * Where the exit boundary reports the failure it ends the process on, with
 * the exit code it ends it with. Installed by the machine-interface stream
 * once its fd-3 preflight has passed ({@link installTerminalFailureReporter}),
 * so every failure reaching a boundary after that point is reported on the
 * stream; `undefined` while no stream is open.
 */
let terminalFailureReporter:
  ((err: unknown, exitCode: number) => void) | undefined;

/**
 * Install the function {@link exitOnFailure} hands each failure to before
 * the process exits, replacing any installed before it; `undefined` removes
 * it. Called by the machine-interface stream when it opens.
 */
export function installTerminalFailureReporter(
  reporter: ((err: unknown, exitCode: number) => void) | undefined,
): void {
  terminalFailureReporter = reporter;
}

/**
 * Report `err` to the installed terminal-failure reporter, when one is
 * installed, and exit the process with `code` even if the reporter throws, in
 * which case its failure is written to stderr on one line.
 */
function exitOnFailure(err: unknown, code: number): never {
  try {
    terminalFailureReporter?.(err, code);
  } catch (reportErr) {
    process.stderr.write(
      `Could not write the failure to the event stream: ${sanitizeErrorForDisplay(reportErr).replace(/\s+/g, " ")}\n`,
    );
  } finally {
    process.exit(code);
  }
}

/**
 * The last-resort exit for an error that escaped every command handler:
 * shown through {@link renderFailureForOperator} on stderr, reported as
 * {@link exitWithError} reports a failure, and exit 1.
 */
export function exitOnUncaughtError(err: unknown): never {
  console.error(renderFailureForOperator(err));
  return exitOnFailure(err, 1);
}

/**
 * Run a command body, mapping any thrown error to a process exit through
 * {@link exitCodeForError}. This is the single error->exit boundary for the
 * bootstrap-style commands: routing the whole handler body through it means a
 * thrown or rejected step exits cleanly rather than crashing with an
 * unhandled rejection.
 *
 * The error logger is created from `loggerName` lazily in the catch, so it
 * picks up whatever sink and level the body installed rather than binding to
 * the defaults before the command has parsed its flags. `process.exit` is
 * typed `never`, so values produced inside `body` keep their
 * definite-assignment narrowing.
 */
export async function runOrExit(
  loggerName: string,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (err) {
    getLogger(loggerName).error(renderFailureForOperator(err));
    exitOnFailure(err, exitCodeForError(err));
  }
}
