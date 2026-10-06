// One classification of a failed run, read by every application that has to
// decide what a failure means: the CLI's exit code and event-stream category,
// and the web's security alert and retry decisions.

import {
  AuthenticationError,
  ConnectionError,
  InternalConsistencyError,
  PeerAbortError,
  ProtocolRefusalError,
  UsageError,
} from "./errors";
import { ReceiptVerificationError } from "./records/signedReceipt";
import { MAX_ERROR_CAUSE_DEPTH } from "./utils/sanitizeErrorForDisplay";

/**
 * What a failure means to the operator, one class per failure
 * ({@link classifyFailure}):
 *
 * - `usage-error`: something the operator supplied must change; running again
 *   unchanged fails the same way. A {@link UsageError} or a `usage`-kind
 *   {@link ConnectionError}.
 * - `internal-fault`: a fault in Alcove itself. An
 *   {@link InternalConsistencyError}.
 * - `partner-refused`: the partner or the agreed terms refused the run. A
 *   {@link ProtocolRefusalError}, a {@link PeerAbortError}, or a
 *   `protocol`-kind {@link ConnectionError}.
 * - `receipt-not-verified`: the partner's receipt or certificate did not
 *   verify. A {@link ReceiptVerificationError}.
 * - `authentication-failed`: the shared secret, the SFTP host key, or the
 *   relay registrar refused this party. An {@link AuthenticationError}.
 * - `trust-check-failed`: any other `security`-kind {@link ConnectionError},
 *   such as a frame that failed its integrity or ordering check.
 * - `cancelled`: a local close cancelled the wait. A `closed`-kind
 *   {@link ConnectionError}.
 * - `unavailable`: everything else, a `transport`-kind
 *   {@link ConnectionError} and any unrecognized error among them.
 */
export type FailureClass =
  | "usage-error"
  | "internal-fault"
  | "partner-refused"
  | "receipt-not-verified"
  | "authentication-failed"
  | "trust-check-failed"
  | "cancelled"
  | "unavailable";

/**
 * The class of `err`, read from {@link firstLinkBehindTransportWraps} of it,
 * so a failure the message bridge wrapped as a `transport`-kind
 * {@link ConnectionError} keeps the class it had bare.
 */
export function classifyFailure(err: unknown): FailureClass {
  const link = firstLinkBehindTransportWraps(err);
  if (link instanceof UsageError) return "usage-error";
  if (link instanceof InternalConsistencyError) return "internal-fault";
  if (link instanceof ProtocolRefusalError || link instanceof PeerAbortError)
    return "partner-refused";
  if (!(link instanceof ConnectionError)) return "unavailable";
  switch (link.kind) {
    case "usage":
      return "usage-error";
    case "protocol":
      return "partner-refused";
    case "security":
      if (link instanceof AuthenticationError) return "authentication-failed";
      if (link instanceof ReceiptVerificationError)
        return "receipt-not-verified";
      return "trust-check-failed";
    case "closed":
      return "cancelled";
    case "transport":
      return "unavailable";
  }
}

/**
 * Whether a {@link FailureClass} is a trust-boundary failure, the classes a
 * `security`-kind {@link ConnectionError} takes: `authentication-failed`,
 * `receipt-not-verified`, and `trust-check-failed`. A consumer must not
 * silently retry one, and reports it as a possible attack.
 */
export function isTrustBoundaryFailure(failureClass: FailureClass): boolean {
  return (
    failureClass === "authentication-failed" ||
    failureClass === "receipt-not-verified" ||
    failureClass === "trust-check-failed"
  );
}

/**
 * The first link of `err`'s cause chain that is not a `transport`-kind
 * {@link ConnectionError}, walking at most {@link MAX_ERROR_CAUSE_DEPTH}
 * links; `err` itself when it is not one. The message bridge
 * (`fromEventConnection`) wraps every send and poll failure that way, so a
 * {@link UsageError} the file-sync transport raised, an
 * {@link InternalConsistencyError}, a partner refusal, or an
 * {@link AuthenticationError} reaches a command boundary behind it. Any other
 * kind ends the walk, so a `security` failure keeps its own class whatever it
 * wraps. A {@link PeerAbortError} is `transport`-kind but ends the walk too:
 * it is the failure itself, not a wrap.
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
