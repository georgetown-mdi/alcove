// The hosted web app's remedy for each cause in core's failure-cause catalog,
// for a failure this browser raised and shows with core's sentence. Total over
// FailureCauseKind, so a cause core adds fails to compile here until bound;
// `undefined` binds a kind whose failure this app states in copy of its own.

import {
  PARTNER_STOPPED_RESPONDING_REMEDY,
  failureCauseOf,
  relayRegistrarUnreachableRemedy,
  sanitizeErrorForDisplay,
  sanitizeErrorForDisplayWithStep,
  setOverLimitRemedy,
} from "@alcove/core";

import type {
  FailureCause,
  FailureCauseKind,
  FailureCauseOfKind,
} from "@alcove/core";

const WEB_FAILURE_REMEDIES: {
  readonly [K in FailureCauseKind]:
    ((cause: FailureCauseOfKind<K>) => string) | undefined;
} = {
  // A no-show is stated by this app's own copy (PartnerNoShowError).
  "partner-never-arrived": undefined,
  // A shared folder belongs to a file-sync channel, which this app does not run.
  "folder-missing": undefined,
  "relay-registrar-unreachable": relayRegistrarUnreachableRemedy,
  "partner-stopped-responding": () => PARTNER_STOPPED_RESPONDING_REMEDY,
  "set-over-limit": setOverLimitRemedy,
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
