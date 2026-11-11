// The hosted web app's remedy for each cause in core's failure-cause catalog,
// for a failure this browser raised and shows with core's sentence. Total over
// FailureCauseKind, so a cause core adds fails to compile here until bound;
// `undefined` binds a kind whose failure this app states in copy of its own.

import {
  MATCHES_OVER_LIMIT_REMEDY,
  PARTNER_STOPPED_AT_MATCHING_REMEDY,
  PARTNER_STOPPED_RESPONDING_REMEDY,
  failureCauseOf,
  relayRegistrarUnreachableRemedy,
  sanitizeErrorForDisplay,
  sanitizeErrorForDisplayWithStep,
  sanitizeForDisplay,
  setOverLimitRemedy,
  singlePassOverLimitRemedy,
} from "@alcove/core";

import type {
  FailureCause,
  FailureCauseKind,
  FailureCauseOfKind,
} from "@alcove/core";

const NEW_INVITATION_STEP =
  "Ask your partner for a new invitation, or start over and create one for " +
  "your partner to accept.";

const WEB_FAILURE_REMEDIES: {
  readonly [K in FailureCauseKind]:
    ((cause: FailureCauseOfKind<K>) => string) | undefined;
} = {
  // A no-show is stated by this app's own copy (PartnerNoShowError).
  "partner-never-arrived": undefined,
  // A shared folder belongs to a file-sync channel, which this app does not
  // run, as do the two other file-sync kinds below.
  "folder-missing": undefined,
  // The host is escaped: webFailureMessage adds the remedy after escaping.
  "relay-registrar-unreachable": (cause) =>
    relayRegistrarUnreachableRemedy({
      ...cause,
      host: sanitizeForDisplay(cause.host),
    }),
  "partner-stopped-responding": () => PARTNER_STOPPED_RESPONDING_REMEDY,
  "set-over-limit": setOverLimitRemedy,
  "single-pass-over-limit": singlePassOverLimitRemedy,
  "matches-over-limit": () => MATCHES_OVER_LIMIT_REMEDY,
  "shared-secret-unusable": () => NEW_INVITATION_STEP,
  "partner-stopped-at-matching": () => PARTNER_STOPPED_AT_MATCHING_REMEDY,
  "message-write-unconfirmed": undefined,
  "shared-name-at-entry": undefined,
};

/** The web app's remedy for `cause`, else `undefined`. */
export function webRemedyForCause(cause: FailureCause): string | undefined {
  const remedy = Object.hasOwn(WEB_FAILURE_REMEDIES, cause.kind)
    ? (WEB_FAILURE_REMEDIES[cause.kind] as
        ((c: FailureCause) => string) | undefined)
    : undefined;
  return remedy?.(cause);
}

/**
 * `error` as the display sanitizer renders it, with the web app's remedy for
 * the catalog cause it holds after its own message and before its cause chain;
 * rendered alone where it holds none, or one this app binds no remedy for.
 */
export function webFailureMessage(error: unknown): string {
  const cause = failureCauseOf(error);
  const remedy = cause === undefined ? undefined : webRemedyForCause(cause);
  return remedy === undefined
    ? sanitizeErrorForDisplay(error)
    : sanitizeErrorForDisplayWithStep(error, remedy);
}
