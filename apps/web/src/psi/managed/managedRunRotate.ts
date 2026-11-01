/**
 * The pure half of the managed exchange's run-and-rotate critical section: what
 * the rotation writes back, the `expires` restamp from the max-age policy, and
 * the run's `lastRun` bookkeeping, with no IndexedDB or Web Locks. The platform
 * half is {@link ./managedExchangeRun.ts}.
 *
 * Sequence: docs/spec/MANAGED_EXCHANGE_RECORD.md, "Persist-before-success
 * ordering". {@link storeRotatedSecret} is the write core's terms exchange awaits
 * at this side's point in the store order, so the ordering is a property of
 * the control flow.
 */

import { rotatedKeyExpires } from "@alcove/core";

import type {
  ManagedExchangeFailureKind,
  ManagedExchangeLastRun,
} from "./managedExchangeRecord";

/**
 * The fields a run's rotation advances on the stored record, and nothing
 * else, so a field-scoped write cannot overwrite a concurrent write with a
 * stale secret or document. `expires: null` clears a standing bound when no
 * policy is set, distinct from leaving it untouched.
 */
export interface RotationWriteBack {
  /** The rotated shared secret to persist as the record's current secret. */
  sharedSecret: string;
  /** `now + tokenMaxAgeDays` when a policy is set, or `null` to clear any
   * standing bound. */
  expires: string | null;
}

/**
 * Compute the rotation write-back for a run. With `tokenMaxAgeDays` set,
 * `expires` is restamped by core's {@link rotatedKeyExpires}, the rule the CLI
 * key file uses; without it, `expires` is `null`.
 *
 * @throws {RangeError} as {@link rotatedKeyExpires} does, prefixed with
 *   `rotationWriteBack: `.
 */
export function rotationWriteBack(
  rotatedSecret: string,
  tokenMaxAgeDays: number | undefined,
  now: number,
): RotationWriteBack {
  if (tokenMaxAgeDays === undefined)
    return { sharedSecret: rotatedSecret, expires: null };
  try {
    return {
      sharedSecret: rotatedSecret,
      expires: rotatedKeyExpires(tokenMaxAgeDays, now),
    };
  } catch (err: unknown) {
    if (err instanceof RangeError)
      throw new RangeError(`rotationWriteBack: ${err.message}`, { cause: err });
    throw err;
  }
}

/** Record a run that completed the data exchange, marked where its key
 * exchange healed a cut rotation. */
export function succeededRun(
  at: number,
  healedCutRotation = false,
): ManagedExchangeLastRun {
  return {
    at: new Date(at).toISOString(),
    outcome: "succeeded",
    ...(healedCutRotation && { healedCutRotation: true as const }),
  };
}

/**
 * Record a run whose partner never arrived: no handshake ran and nothing left
 * this party. It has no `failureKind`, since a no-show is the absence of a run
 * and the failure tiering keys off the `"missed"` outcome alone.
 */
export function missedRun(at: number): ManagedExchangeLastRun {
  return { at: new Date(at).toISOString(), outcome: "missed" };
}

/**
 * Record a run whose rotation could not be persisted, so the next handshake
 * failure is shown with the desync framing rather than the attack framing
 * (docs/MANAGED_EXCHANGE.md, "Telling a desync from an attack").
 */
export function storageFailureRun(at: number): ManagedExchangeLastRun {
  return {
    at: new Date(at).toISOString(),
    outcome: "failed",
    failureKind: "storage",
  };
}

/** Record a non-succeeded run with the given outcome and failure kind, for the
 * failure paths the runner classifies. */
export function failedRun(
  at: number,
  outcome: Exclude<ManagedExchangeLastRun["outcome"], "succeeded">,
  failureKind: ManagedExchangeFailureKind,
): ManagedExchangeLastRun {
  return { at: new Date(at).toISOString(), outcome, failureKind };
}

/** Raised when the rotation write-back fails to persist, before the data
 * exchange began. */
export class RotationPersistError extends Error {
  /** The `storage`-kind `lastRun` to record for this failed run. */
  readonly lastRun: ManagedExchangeLastRun;
  constructor(at: number, cause: unknown) {
    super("failed to persist the rotated shared secret", { cause });
    this.name = "RotationPersistError";
    this.lastRun = storageFailureRun(at);
  }
}

/** The durable persist, injected by the platform half. The lock is the
 * caller's and spans the whole run. */
export interface ManagedRotationPersist {
  /** Durably persist the write-back and await the write. A throw means the
   * secret did not persist. */
  persist: (writeBack: RotationWriteBack) => Promise<void>;
  /** The record's max-age policy, or `undefined` for no bound. */
  tokenMaxAgeDays: number | undefined;
  /** The clock the stamps read. */
  now: () => number;
}

/**
 * Persist the rotation write-back for the next secret the terms exchange
 * derived, and await it: the write the terms exchange awaits at this side's
 * point in the store order. Returns the secret it stored.
 *
 * @throws {RotationPersistError} if the rotation write-back fails to persist.
 */
export async function storeRotatedSecret(
  section: ManagedRotationPersist,
  nextSecret: string,
): Promise<string> {
  const writeBack = rotationWriteBack(
    nextSecret,
    section.tokenMaxAgeDays,
    section.now(),
  );
  try {
    await section.persist(writeBack);
  } catch (error) {
    throw new RotationPersistError(section.now(), error);
  }
  return writeBack.sharedSecret;
}
