/**
 * Changing a saved exchange's terms between runs: the operator's choice of the
 * columns this party sends, the terms update `alcove update` makes, and
 * applying a partner's update as `alcove apply` does
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "A terms update").
 */

import {
  TermsUpdateRefusedError,
  UsageError,
  assertTermsRunnable,
  compareTerms,
  decodeTermsUpdate,
  encodeTermsUpdate,
  stripInvitationWhitespace,
  termsUpdateFor,
  unnamedPartyIdentity,
} from "@alcove/core";
import { ZodError } from "zod";

import {
  ManagedExchangeSecretChangedError,
  getManagedExchange,
  persistManagedExchangeSentColumns,
  persistManagedExchangeTermsChange,
} from "./managedExchangeStore";
import {
  applyManagedExchangeTermsChange,
  matchingKeyTurnedOffBy,
  runnableManagedExchange,
} from "./managedExchangeRecord";
import { clearManagedExchangeTermsProposal } from "./managedLocalState";
import { managedExchangeLapsed } from "./managedExpiry";

import type {
  LinkageTerms,
  MatchingKeyUnavailableReason,
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
 * (`applyManagedExchangeSentColumns`). Takes no lock: a run in flight runs the
 * terms it read when it took its lock, and the next run states the saved set.
 *
 * @throws {UsageError} where the exchange offers no such choice.
 * @throws {ZodError} if the resulting record is invalid; nothing is written.
 */
export async function saveManagedSentColumns(
  id: string,
  sent: ReadonlyArray<string>,
): Promise<ManagedExchangeRecord> {
  return persistManagedExchangeSentColumns(id, sent);
}

/** Why a terms update is not made from an exchange. */
export type ManagedTermsUpdateRefusal = "lapsed" | "no-identity";

/**
 * Why a terms update cannot be made from `record` at `now`, or null where it
 * can: a lapsed secret cannot authenticate one, and terms naming no identity
 * for this party (`unnamedPartyIdentity`) leave the partner's apply no way to
 * tell the update from its own.
 */
export function managedTermsUpdateRefusal(
  record: ManagedExchangeRecord,
  now: number,
): ManagedTermsUpdateRefusal | null {
  if (managedExchangeLapsed(record, now)) return "lapsed";
  if (
    unnamedPartyIdentity(record.exchangeFile.linkageTerms.identity) !==
    undefined
  )
    return "no-identity";
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
 * decides at the time of the call.
 *
 * @throws {ManagedTermsUpdateRefusedError} where it is refused.
 */
export async function makeManagedTermsUpdate(
  record: RunnableManagedExchangeRecord,
): Promise<string> {
  const refusal = managedTermsUpdateRefusal(record, Date.now());
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
 * - `not-runnable`: a run under its terms would refuse before it sends
 *   anything, as `alcove apply` checks: core's `deriveAcceptedLinkageTerms`
 *   refuses the partner's terms (a count-only shape, a deduplicate no
 *   strategy matches, a transform that does not compile), or core's
 *   `assertTermsRunnable` refuses the terms derived from them. The error's
 *   `cause` names the rule.
 * - `changed`: the stored exchange changed after the update was read, so the
 *   change shown is not the one applying it would make.
 */
export type ManagedTermsUpdateApplyRefusal =
  | ManagedTermsUpdateRefusal
  | TermsUpdateCheck
  | "own-terms"
  | "not-applicable"
  | "not-runnable"
  | "changed";

/** Raised when a partner's terms update is refused, naming the reason;
 * nothing is written. */
export class ManagedTermsUpdateNotAppliedError extends Error {
  constructor(
    readonly refusal: ManagedTermsUpdateApplyRefusal,
    options?: { cause: unknown },
  ) {
    super(
      `the terms update was not applied to this exchange: ${refusal}`,
      options,
    );
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
  /** Why applying the update turns off this party's matched-key column
   * ({@link matchingKeyTurnedOffBy}), absent where it does not. */
  matchingKeyTurnedOff?: MatchingKeyUnavailableReason;
}

async function checkedTermsUpdate(
  record: RunnableManagedExchangeRecord,
  encoded: string,
): Promise<{
  update: TermsUpdate;
  delta: TermsDelta;
  matchingKeyTurnedOff: MatchingKeyUnavailableReason | undefined;
}> {
  const refusal = managedTermsUpdateRefusal(record, Date.now());
  if (refusal !== null) throw new ManagedTermsUpdateNotAppliedError(refusal);
  let update: TermsUpdate;
  try {
    update = await decodeTermsUpdate(encoded, record.sharedSecret);
  } catch (error) {
    if (error instanceof TermsUpdateRefusedError)
      throw new ManagedTermsUpdateNotAppliedError(error.check, {
        cause: error,
      });
    throw error;
  }
  const { exchangeFile } = record;
  if (update.linkageTerms.identity === exchangeFile.linkageTerms.identity)
    throw new ManagedTermsUpdateNotAppliedError("own-terms");
  let applied: ManagedExchangeRecord;
  try {
    applied = applyManagedExchangeTermsChange(record, {
      scope: "update",
      update,
    });
  } catch (error) {
    if (error instanceof UsageError)
      throw new ManagedTermsUpdateNotAppliedError("not-runnable", {
        cause: error,
      });
    if (error instanceof ZodError)
      throw new ManagedTermsUpdateNotAppliedError("not-applicable");
    throw error;
  }
  try {
    assertTermsRunnable(
      applied.exchangeFile.linkageTerms,
      applied.exchangeFile,
    );
  } catch (error) {
    if (error instanceof UsageError)
      throw new ManagedTermsUpdateNotAppliedError("not-runnable", {
        cause: error,
      });
    throw error;
  }
  const { delta } = compareTerms(
    exchangeFile.linkageTerms,
    update.linkageTerms,
    {
      partnerDeduplicate: exchangeFile.expectedPartnerDeduplicate,
    },
  );
  return {
    update,
    delta,
    matchingKeyTurnedOff: matchingKeyTurnedOffBy(
      exchangeFile,
      applied.exchangeFile,
    ),
  };
}

/**
 * Read a partner's terms update for `record`, as `alcove apply` checks one:
 * refused as {@link managedTermsUpdateRefusal} decides; decoded under the
 * record's shared secret; refused where it names this party's own identity,
 * the exchange cannot hold its terms, or a run under them would refuse.
 * Nothing is written.
 *
 * @throws {ManagedTermsUpdateNotAppliedError} where it is refused.
 */
export async function readManagedTermsUpdate(
  record: RunnableManagedExchangeRecord,
  pasted: string,
): Promise<ManagedTermsUpdateReading> {
  const encoded = stripInvitationWhitespace(pasted);
  const { update, delta, matchingKeyTurnedOff } = await checkedTermsUpdate(
    record,
    encoded,
  );
  return {
    encoded,
    partnerTerms: update.linkageTerms,
    delta,
    ...(matchingKeyTurnedOff !== undefined ? { matchingKeyTurnedOff } : {}),
  };
}

/**
 * Apply the partner's terms update `shown` holds to the stored exchange
 * (the `update` scope of `applyManagedExchangeTermsChange`), then drop any
 * terms change a scheduled run kept, which this answers. The stored record is
 * read and checked again, and applied only where the change is still the one
 * shown, the matched-key column it turns off included. Takes no lock: a run in
 * flight runs the terms it read when it took its lock. The update is
 * authenticated under the secret that read holds, and the write compares the
 * stored secret with it, so a run's rotation or a re-invite landing before
 * the read or between the read and the write refuses the update as
 * `partnership`.
 *
 * @throws {ManagedTermsUpdateNotAppliedError} where it is refused.
 * @throws {ZodError} if the resulting record is invalid.
 */
export async function applyManagedTermsUpdate(
  id: string,
  shown: ManagedTermsUpdateReading,
): Promise<ManagedExchangeRecord> {
  const stored = await getManagedExchange(id);
  if (stored === undefined || !runnableManagedExchange(stored))
    throw new ManagedTermsUpdateNotAppliedError("changed");
  const current = await checkedTermsUpdate(stored, shown.encoded);
  if (
    JSON.stringify(current.delta) !== JSON.stringify(shown.delta) ||
    current.matchingKeyTurnedOff !== shown.matchingKeyTurnedOff
  )
    throw new ManagedTermsUpdateNotAppliedError("changed");
  let applied: ManagedExchangeRecord;
  try {
    applied = await persistManagedExchangeTermsChange(
      id,
      { scope: "update", update: current.update },
      stored.sharedSecret,
    );
  } catch (error) {
    if (error instanceof ManagedExchangeSecretChangedError)
      throw new ManagedTermsUpdateNotAppliedError("partnership", {
        cause: error,
      });
    throw error;
  }
  // Best-effort: a proposal left behind is one the operator can decline.
  await clearManagedExchangeTermsProposal(id).catch(() => undefined);
  return applied;
}
