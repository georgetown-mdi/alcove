/**
 * Changing a saved exchange's terms between runs: the operator's choice of the
 * columns this party sends, and the terms update `alcove update` makes, which
 * a command-line partner applies before its next run
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "A terms update").
 */

import {
  encodeTermsUpdate,
  termsUpdateFor,
  unnamedPartyIdentity,
} from "@alcove/core";

import {
  managedExchangeRunLockHeld,
  withManagedExchangeLock,
} from "./managedExchangeLock";
import { managedExchangeLapsed } from "./managedExpiry";
import { persistManagedExchangeSentColumns } from "./managedExchangeStore";

import type {
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "./managedExchangeRecord";

/**
 * Save which of the exchange's offered columns it sends
 * (`applyManagedExchangeSentColumns`). Held under the run lock without
 * waiting: a run of this exchange in flight refuses the save rather than
 * having its terms rewritten under it.
 *
 * @throws {ManagedExchangeLockUnavailableError} while a run holds the lock;
 *   nothing is written.
 * @throws {UsageError} where the exchange offers no such choice.
 * @throws {ZodError} if the resulting record is invalid; nothing is written.
 */
export async function saveManagedSentColumns(
  id: string,
  sent: ReadonlyArray<string>,
): Promise<ManagedExchangeRecord> {
  return withManagedExchangeLock(
    id,
    () => persistManagedExchangeSentColumns(id, sent),
    { ifAvailable: true },
  );
}

/** Why a terms update is not made from an exchange. */
export type ManagedTermsUpdateRefusal =
  "lapsed" | "no-identity" | "run-in-flight";

/**
 * Why a terms update cannot be made from `record` at `now`, or null where it
 * can: a lapsed secret cannot authenticate one; terms naming no identity for
 * this party (`unnamedPartyIdentity`) leave the partner's apply no way to tell
 * the update from its own; and a run in flight is about to replace the secret
 * the update would be made under.
 */
export function managedTermsUpdateRefusal(
  record: ManagedExchangeRecord,
  now: number,
  runInFlight: boolean,
): ManagedTermsUpdateRefusal | null {
  if (managedExchangeLapsed(record, now)) return "lapsed";
  if (
    unnamedPartyIdentity(record.exchangeFile.linkageTerms.identity) !==
    undefined
  )
    return "no-identity";
  if (runInFlight) return "run-in-flight";
  return null;
}

/** Raised when {@link makeManagedTermsUpdate} refuses, naming the reason. */
export class ManagedTermsUpdateRefusedError extends Error {
  constructor(readonly refusal: ManagedTermsUpdateRefusal) {
    super(`a terms update cannot be made from this exchange: ${refusal}`);
    this.name = "ManagedTermsUpdateRefusedError";
  }
}

/**
 * The terms update this exchange's stored document makes: the same update
 * `alcove update` prints for a configuration holding the same terms and
 * metadata under the same shared secret, since both compose it through
 * core's `termsUpdateFor`. Refused as {@link managedTermsUpdateRefusal}
 * decides at the time of the call, with a run in flight read from the run
 * lock.
 *
 * @throws {ManagedTermsUpdateRefusedError} where it is refused.
 */
export async function makeManagedTermsUpdate(
  record: RunnableManagedExchangeRecord,
): Promise<string> {
  const refusal = managedTermsUpdateRefusal(
    record,
    Date.now(),
    await managedExchangeRunLockHeld(record.id),
  );
  if (refusal !== null) throw new ManagedTermsUpdateRefusedError(refusal);
  const { linkageTerms, metadata } = record.exchangeFile;
  return encodeTermsUpdate(
    termsUpdateFor(linkageTerms, metadata),
    record.sharedSecret,
  );
}
