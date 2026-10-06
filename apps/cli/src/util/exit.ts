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
  AuthenticationError,
  ConnectionError,
  getLogger,
  InternalConsistencyError,
  MAX_ERROR_CAUSE_DEPTH,
  PeerAbortError,
  ProtocolRefusalError,
  ReceiptVerificationError,
  sanitizeErrorForDisplay,
  UsageError,
} from "@alcove/core";

import { failureRemedy } from "../failureRemedy";
import { holdsRecoveryHintTag } from "./recoveryHint";

/**
 * The next step shown beneath an {@link InternalConsistencyError} whose message
 * states none of its own: the same step for every internal fault, since no
 * input the operator controls moves one and a retry reaches the same refusal.
 */
export const INTERNAL_FAULT_NEXT_STEP =
  "This is a fault in Alcove itself: report it with this message; retrying " +
  "will not help.";

/**
 * {@link INTERNAL_FAULT_NEXT_STEP} when `err` is an
 * {@link InternalConsistencyError}, bare or behind `transport`-kind wraps as
 * {@link exitCodeForError} reads it, and nothing in its cause chain holds
 * core's `alcoveRecoveryHintEmitted` tag; otherwise `undefined`. A tagged
 * fault's message already states its step, so adding this one would give the
 * operator two.
 */
export function internalFaultNextStep(err: unknown): string | undefined {
  if (!(firstLinkBehindTransportWraps(err) instanceof InternalConsistencyError))
    return undefined;
  return holdsRecoveryHintTag(err) ? undefined : INTERNAL_FAULT_NEXT_STEP;
}

/**
 * The next step shown beneath a partner or terms refusal
 * ({@link isPartnerRefusal}) whose message states none of its own: the same
 * step for every such refusal, since a retry meets the same partner and the
 * same terms.
 */
export const PARTNER_REFUSED_NEXT_STEP =
  "Contact your partner before running again: the partner or the agreed " +
  "terms refused this exchange, and retrying unchanged will fail the same way.";

/**
 * {@link PARTNER_REFUSED_NEXT_STEP} when `err` is a partner or terms refusal
 * ({@link isPartnerRefusal}), bare or behind `transport`-kind wraps as
 * {@link exitCodeForError} reads it, and nothing in its cause chain holds
 * core's `alcoveRecoveryHintEmitted` tag; otherwise `undefined`, for the
 * reason {@link internalFaultNextStep} gives.
 */
export function partnerRefusalNextStep(err: unknown): string | undefined {
  if (!isPartnerRefusal(firstLinkBehindTransportWraps(err))) return undefined;
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
 * The process exit code a caught command error reports: EX_USAGE (64) for a
 * {@link UsageError} or a {@link ConnectionError} of kind `usage`, bare or
 * behind `transport`-kind wraps ({@link firstLinkBehindTransportWraps}),
 * {@link INTERNAL_FAULT_EXIT_CODE} (70) for an {@link InternalConsistencyError},
 * {@link PARTNER_REFUSED_EXIT_CODE} (76) for a partner or terms refusal
 * ({@link isPartnerRefusal}), and {@link AUTHENTICATION_FAILED_EXIT_CODE} (77)
 * for an {@link AuthenticationError}, each bare or behind the same wraps,
 * {@link INPUT_NOT_FOUND_EXIT_CODE} (66) for an {@link InputNotFoundError},
 * otherwise the error's own numeric `exitCode` when it has one, else
 * EX_UNAVAILABLE (69). The classification a boundary
 * reads when its errors vary; a boundary whose errors are all usage faults
 * exits 64 outright.
 *
 * A {@link ConnectionError}'s taxonomy is a FIELD (`kind`) rather than a
 * subclass, so it is read here rather than left to the 69 default: a `usage`
 * kind names a caller, protocol, or terms correction that a re-run cannot
 * supply, and a `protocol` kind names a partner that broke the message
 * contract. The `security`-kind subclasses read here are
 * {@link AuthenticationError} and {@link ReceiptVerificationError}; every
 * other `security`-kind failure, and `transport` and `closed`, stay 69.
 *
 * The own-`exitCode` rung is what gives a run whose exchange completed while
 * its result file did not reach disk `PERSISTENCE_LOSS_EXIT_CODE` (73). The
 * rung is typed rather than `??`-defaulted so a non-numeric `exitCode` on some
 * other object cannot reach `process.exit`.
 */
export function exitCodeForError(err: unknown): number {
  const unwrapped = firstLinkBehindTransportWraps(err);
  if (isUsageFault(unwrapped)) return 64;
  if (unwrapped instanceof InternalConsistencyError)
    return INTERNAL_FAULT_EXIT_CODE;
  if (isPartnerRefusal(unwrapped)) return PARTNER_REFUSED_EXIT_CODE;
  if (unwrapped instanceof AuthenticationError)
    return AUTHENTICATION_FAILED_EXIT_CODE;
  if (unwrapped instanceof InputNotFoundError) return INPUT_NOT_FOUND_EXIT_CODE;
  const own = (err as { exitCode?: unknown } | null | undefined)?.exitCode;
  return typeof own === "number" ? own : 69;
}

function isUsageFault(err: unknown): boolean {
  return (
    err instanceof UsageError ||
    (err instanceof ConnectionError && err.kind === "usage")
  );
}

/**
 * Whether `err` is a partner or terms refusal, the class
 * {@link exitCodeForError} maps to {@link PARTNER_REFUSED_EXIT_CODE}: a
 * {@link ProtocolRefusalError}, a {@link PeerAbortError}, a
 * {@link ReceiptVerificationError}, or a `protocol`-kind
 * {@link ConnectionError}. Reads `err` itself; a caller holding a possibly
 * wrapped error passes {@link firstLinkBehindTransportWraps} of it.
 */
export function isPartnerRefusal(err: unknown): boolean {
  return (
    err instanceof ProtocolRefusalError ||
    err instanceof PeerAbortError ||
    err instanceof ReceiptVerificationError ||
    (err instanceof ConnectionError && err.kind === "protocol")
  );
}

/**
 * The first link of `err`'s cause chain that is not a `transport`-kind
 * {@link ConnectionError}, walking at most {@link MAX_ERROR_CAUSE_DEPTH}
 * links; `err` itself when it is not one. The message bridge
 * (`fromEventConnection`) wraps every send and poll failure that way, so a
 * {@link UsageError} the file-sync transport raised, an
 * {@link InternalConsistencyError}, a partner refusal, an
 * {@link AuthenticationError}, or an {@link InputNotFoundError} reaches a
 * command boundary behind it. Any other kind ends the walk, so a `security`
 * failure keeps its own code whatever it wraps. A {@link PeerAbortError} is
 * `transport`-kind but ends the walk too: it is the failure itself, not a
 * wrap.
 */
export function firstLinkBehindTransportWraps(err: unknown): unknown {
  let link: unknown = err;
  for (
    let depth = 0;
    depth < MAX_ERROR_CAUSE_DEPTH &&
    link instanceof ConnectionError &&
    link.kind === "transport" &&
    !(link instanceof PeerAbortError);
    depth++
  )
    link = link.cause;
  return link;
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
