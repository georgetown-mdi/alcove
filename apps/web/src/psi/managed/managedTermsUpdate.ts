/**
 * Changing a saved exchange's terms between runs: the operator's choice of the
 * columns this party sends, the terms update `alcove update` makes, and
 * applying a partner's update as `alcove apply` does
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "A terms update").
 */

import {
  TermsUpdateRefusedError,
  UsageError,
  compareTerms,
  decodeTermsUpdate,
  encodeTermsUpdate,
  stripInvitationWhitespace,
  termsUpdateFor,
  unnamedPartyIdentity,
} from "@alcove/core";
import { ZodError } from "zod";

import {
  applyManagedExchangeTermsChange,
  runnableManagedExchange,
} from "./managedExchangeRecord";
import {
  getManagedExchange,
  persistManagedExchangeSentColumns,
  persistManagedExchangeTermsChange,
} from "./managedExchangeStore";
import {
  managedExchangeRunLockHeld,
  withManagedExchangeLock,
} from "./managedExchangeLock";
import { clearManagedExchangeTermsProposal } from "./managedLocalState";
import { managedExchangeLapsed } from "./managedExpiry";

import type {
  LinkageTerms,
  TermsDelta,
  TermsUpdate,
  TermsUpdateCheck,
} from "@alcove/core";
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

/**
 * Why a partner's terms update is not applied to an exchange: a reason
 * {@link managedTermsUpdateRefusal} gives, a check the decode refused it on
 * (`TermsUpdateCheck`), or
 *
 * - `own-terms`: it names this party's own identity as the party that made
 *   it, so it was made from this exchange's own terms (`alcove apply`'s
 *   identity check).
 * - `not-applicable`: the stored exchange cannot hold its terms.
 * - `changed`: the stored exchange changed after the update was read, so the
 *   change shown is not the one applying it would make.
 */
export type ManagedTermsUpdateApplyRefusal =
  | ManagedTermsUpdateRefusal
  | TermsUpdateCheck
  | "own-terms"
  | "not-applicable"
  | "changed";

/** Raised when a partner's terms update is refused, naming the reason;
 * nothing is written. */
export class ManagedTermsUpdateNotAppliedError extends Error {
  constructor(readonly refusal: ManagedTermsUpdateApplyRefusal) {
    super(`the terms update was not applied to this exchange: ${refusal}`);
    this.name = "ManagedTermsUpdateNotAppliedError";
  }
}

/** A partner's terms update, checked against the exchange it was read for. */
export interface ManagedTermsUpdateReading {
  /** The update as pasted, with the whitespace a wrapped paste adds removed. */
  encoded: string;
  /** The partner's own terms the update states. */
  partnerTerms: LinkageTerms;
  /** How they differ from the stored exchange's, as a run compares them. */
  delta: TermsDelta;
}

async function checkedTermsUpdate(
  record: RunnableManagedExchangeRecord,
  encoded: string,
  runInFlight: boolean,
): Promise<{ update: TermsUpdate; delta: TermsDelta }> {
  const refusal = managedTermsUpdateRefusal(record, Date.now(), runInFlight);
  if (refusal !== null) throw new ManagedTermsUpdateNotAppliedError(refusal);
  let update: TermsUpdate;
  try {
    update = await decodeTermsUpdate(encoded, record.sharedSecret);
  } catch (error) {
    if (error instanceof TermsUpdateRefusedError)
      throw new ManagedTermsUpdateNotAppliedError(error.check);
    throw error;
  }
  const { exchangeFile } = record;
  if (update.linkageTerms.identity === exchangeFile.linkageTerms.identity)
    throw new ManagedTermsUpdateNotAppliedError("own-terms");
  try {
    applyManagedExchangeTermsChange(record, { scope: "update", update });
  } catch (error) {
    if (error instanceof UsageError || error instanceof ZodError)
      throw new ManagedTermsUpdateNotAppliedError("not-applicable");
    throw error;
  }
  const { delta } = compareTerms(
    exchangeFile.linkageTerms,
    update.linkageTerms,
    {
      partnerDeduplicate: exchangeFile.expectedPartnerDeduplicate,
    },
  );
  return { update, delta };
}

/**
 * Read a partner's terms update for `record`, as `alcove apply` checks one:
 * refused as {@link managedTermsUpdateRefusal} decides, with a run in flight
 * read from the run lock; decoded under the record's shared secret; refused
 * where it names this party's own identity or the exchange cannot hold its
 * terms. Nothing is written.
 *
 * @throws {ManagedTermsUpdateNotAppliedError} where it is refused.
 */
export async function readManagedTermsUpdate(
  record: RunnableManagedExchangeRecord,
  pasted: string,
): Promise<ManagedTermsUpdateReading> {
  const encoded = stripInvitationWhitespace(pasted);
  const { update, delta } = await checkedTermsUpdate(
    record,
    encoded,
    await managedExchangeRunLockHeld(record.id),
  );
  return { encoded, partnerTerms: update.linkageTerms, delta };
}

/**
 * Apply the partner's terms update `shown` holds to the stored exchange
 * (the `update` scope of `applyManagedExchangeTermsChange`), then drop any
 * terms change a scheduled run kept, which this answers. The stored record is
 * read and checked again under the lock, and applied only where the change is
 * still the one shown.
 *
 * @throws {ManagedExchangeLockUnavailableError} while a run holds the lock.
 * @throws {ManagedTermsUpdateNotAppliedError} where it is refused.
 * @throws {ZodError} if the resulting record is invalid.
 */
export async function applyManagedTermsUpdate(
  id: string,
  shown: ManagedTermsUpdateReading,
): Promise<ManagedExchangeRecord> {
  return withManagedExchangeLock(
    id,
    async () => {
      const stored = await getManagedExchange(id);
      if (stored === undefined || !runnableManagedExchange(stored))
        throw new ManagedTermsUpdateNotAppliedError("changed");
      const current = await checkedTermsUpdate(stored, shown.encoded, false);
      if (JSON.stringify(current.delta) !== JSON.stringify(shown.delta))
        throw new ManagedTermsUpdateNotAppliedError("changed");
      const applied = await persistManagedExchangeTermsChange(id, {
        scope: "update",
        update: current.update,
      });
      // Best-effort: a proposal left behind is one the operator can decline.
      await clearManagedExchangeTermsProposal(id).catch(() => undefined);
      return applied;
    },
    { ifAvailable: true },
  );
}
