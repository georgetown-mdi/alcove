/**
 * A managed exchange's failure tier, derived from the record's own evidence
 * (never the live error), so an unattended failure tiers the same at the next
 * visit as when it failed. Rationale: docs/notes/managed-exchange-design.md,
 * "Telling a desync from an attack".
 */

import {
  answersRotationInFlight,
  raisedStandingCondition,
} from "./managedExchangeRecord";
import { managedExchangeLapsed } from "./managedExpiry";

import type {
  ManagedExchangeRecord,
  ManagedStandingCondition,
} from "./managedExchangeRecord";
import type { ManagedLocalState } from "./managedLocalStateShape";

/**
 * The failure tier a record's bookkeeping resolves to. Each benign tier names a
 * recovery; only `"unexplained"` has the out-of-band confirmation. A tier whose
 * cause recurs identically at the next window offers no retry.
 *
 * - `"expired"` -- the secret's age bound lapsed (re-invite).
 * - `"input"` -- the file was missing or unreadable (put it back and retry).
 * - `"terms-shortfall"` -- the file cannot supply every agreed linkage key (a
 *   covering file, or terms re-agreed with the partner).
 * - `"too-large"` -- this run's set exceeds what the partner can receive (split
 *   the input).
 * - `"terms-change"` -- the partner's changed terms were not taken on, before any
 *   key or data moved (apply or decline the change).
 * - `"partner-set-too-large"` -- the partner's set exceeds what this browser can
 *   match (the command-line application, or the partner splits their input).
 * - `"partner-refused-set"` -- the partner's run refused to send its set for a
 *   cause other than size (ask the partner).
 * - `"partner-refused-terms"` -- the partner's run refused this exchange's
 *   linkage terms as differing from its own, before any key or data moved
 *   (terms agreed with the partner through a terms update).
 * - `"partner-protocol-refusal"` -- this browser refused partner data that did
 *   not follow the exchange protocol (the partner checks their version).
 * - `"handed-off"` -- an export handed this copy off (none here).
 * - `"missed"` -- the partner never arrived within the wait (the next window, or
 *   run again once the partner is ready).
 * - `"custody-unreadable"` -- the hand-off entry or the stored record could not be
 *   read, before anything rotated (none here).
 * - `"storage"` -- a rotation could not be persisted and may have desynced the
 *   parties (re-invite).
 * - `"partial-rotation"` -- a rotation never saved and a later run met no partner,
 *   who probably saved a secret this device lacks (re-invite). Read only beside
 *   that no-show, so it cannot stand in for an unexplained handshake failure.
 * - `"imported"` -- a restore, import, or take-back since the last success
 *   (re-invite).
 * - `"transport"` -- a connection drop that is not a failed-closed handshake, or a
 *   cancelled run (retry).
 * - `"unexplained"` -- a failed-closed (`auth`) handshake with no benign
 *   explanation.
 * - `"none"` -- no failure recorded.
 */
export type ManagedFailureTier =
  | "expired"
  | "input"
  | "terms-shortfall"
  | "too-large"
  | "terms-change"
  | "partner-set-too-large"
  | "partner-refused-set"
  | "partner-refused-terms"
  | "partner-protocol-refusal"
  | "handed-off"
  | "custody-unreadable"
  | "missed"
  | "storage"
  | "partial-rotation"
  | "imported"
  | "transport"
  | "unexplained"
  | "none";

/**
 * Whether a record's secret came from a restore or a take-back and has not
 * succeeded since: the `imported` marker is cleared by the first rotation after
 * one, so its presence alone is the evidence.
 */
export function importedSinceLastSuccess(
  local: ManagedLocalState | undefined,
): boolean {
  return local?.imported !== undefined;
}

/**
 * Whether a rotation began and was not saved before the run stamped in
 * `lastRun`, so a later run has passed without clearing it. A marker set after
 * the stamp belongs to a run still in flight or the interrupted run itself.
 */
export function rotationInFlightBeforeLastRun(
  record: ManagedExchangeRecord,
): boolean {
  const since = record.rotationInFlightSince;
  const lastRun = record.lastRun;
  if (since === undefined || lastRun === undefined) return false;
  return Date.parse(since) < Date.parse(lastRun.at);
}

/**
 * Whether a run launched on `atLaunch` that met no partner is the
 * partial-rotation state: a rotation-in-flight marker with no standing condition
 * and no later outcome ({@link answersRotationInFlight}).
 */
export function rotationInFlightUnansweredAtLaunch(
  atLaunch: ManagedExchangeRecord,
): boolean {
  const since = atLaunch.rotationInFlightSince;
  if (since === undefined) return false;
  if (raisedStandingCondition(atLaunch) !== undefined) return false;
  const lastRun = atLaunch.lastRun;
  return lastRun === undefined || !answersRotationInFlight(lastRun, since);
}

/** A record's failure tier and whether the standing condition, rather than the
 * last run, supplied it: an earlier run's condition says nothing about the last
 * one. */
export interface ManagedFailureReading {
  /** The tier the record's evidence resolves to. */
  tier: ManagedFailureTier;
  standing: boolean;
}

/** The tiers a standing condition can resolve to. */
export type ManagedStandingTier = "storage" | "imported" | "unexplained";

/** The tier a standing condition resolves to, the same reading
 * {@link deriveManagedFailureTier} makes of the equivalent `lastRun` entry, so a
 * condition tiers identically however many runs ago it was raised. */
export function managedStandingConditionTier(
  condition: ManagedStandingCondition,
  local: ManagedLocalState | undefined,
): ManagedStandingTier {
  if (condition.kind === "storage") return "storage";
  return importedSinceLastSuccess(local) ? "imported" : "unexplained";
}

/**
 * Read a record's failure tier and its source as of `now`. The standing
 * condition supplies the tier where the last run shows no failure or a no-show
 * (so later stamps do not hide it), and where a persist failure explains an
 * `"unexplained"` reading. It never displaces a recorded benign cause, which is
 * this run's own actionable state.
 */
export function readManagedFailure(
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
): ManagedFailureReading {
  // Checked first: never routed through attack framing, matching the
  // pre-connection check.
  if (managedExchangeLapsed(record, now))
    return { tier: "expired", standing: false };
  const recorded = recordedFailureTier(record, local);
  const condition = raisedStandingCondition(record);
  if (condition === undefined) {
    if (recorded === "missed" && rotationInFlightBeforeLastRun(record))
      return { tier: "partial-rotation", standing: false };
    return { tier: recorded, standing: false };
  }
  if (recorded === "none" || recorded === "missed")
    return {
      tier: managedStandingConditionTier(condition, local),
      standing: true,
    };
  if (recorded === "unexplained" && condition.kind === "storage")
    return { tier: "storage", standing: true };
  return { tier: recorded, standing: false };
}

/** {@link readManagedFailure} without the source. */
export function deriveManagedFailureTier(
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
): ManagedFailureTier {
  return readManagedFailure(record, local, now).tier;
}

/**
 * The tier the record's last-run bookkeeping resolves to: a recorded benign
 * cause, then a restore since the last success, and only then `"unexplained"`.
 * Rationale for the order: docs/notes/managed-exchange-design.md, "Telling a
 * desync from an attack" and "Recovery: fast re-invite".
 */
function recordedFailureTier(
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
): ManagedFailureTier {
  const lastRun = record.lastRun;
  if (lastRun === undefined || lastRun.outcome === "succeeded") return "none";
  // A skipped window attempted nothing; the standing condition is read across
  // it.
  if (lastRun.outcome === "skipped") return "none";
  if (lastRun.outcome === "missed") return "missed";

  if (lastRun.failureKind === "input") return "input";
  if (lastRun.failureKind === "terms-shortfall") return "terms-shortfall";
  if (lastRun.failureKind === "too-large") return "too-large";
  if (lastRun.failureKind === "terms-change") return "terms-change";
  if (lastRun.failureKind === "partner-set-too-large")
    return "partner-set-too-large";
  if (lastRun.failureKind === "partner-refused-set")
    return "partner-refused-set";
  if (lastRun.failureKind === "partner-refused-terms")
    return "partner-refused-terms";
  if (lastRun.failureKind === "partner-protocol-refusal")
    return "partner-protocol-refusal";
  if (lastRun.failureKind === "handed-off") return "handed-off";
  if (lastRun.failureKind === "custody-unreadable") return "custody-unreadable";
  if (lastRun.failureKind === "storage") return "storage";

  // A restore explains only a failed-closed `auth` handshake, never a
  // transport drop.
  if (lastRun.failureKind === "auth" && importedSinceLastSuccess(local))
    return "imported";

  if (lastRun.failureKind === "transport") return "transport";

  if (lastRun.failureKind === "cancelled") return "transport";

  return "unexplained";
}
