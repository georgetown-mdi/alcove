/**
 * Changing a saved exchange's terms between runs: the operator's choice of the
 * columns this party sends, and the terms update `alcove update` makes, which
 * a command-line partner applies before its next run
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "A terms update").
 */

import { UsageError, encodeTermsUpdate, termsUpdateFor } from "@alcove/core";

import { managedExchangeLapsed } from "./managedExpiry";
import { persistManagedExchangeSentColumns } from "./managedExchangeStore";
import { withManagedExchangeLock } from "./managedExchangeLock";

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

/**
 * Why a terms update cannot be made from `record` at `now`, or undefined
 * where it can: a lapsed secret cannot authenticate one, and terms naming no
 * identity for this party leave the partner's apply no way to tell the update
 * from its own, the two refusals of `alcove update` a record can meet.
 */
export function managedTermsUpdateWithheld(
  record: ManagedExchangeRecord,
  now: number,
): "lapsed" | "no-identity" | undefined {
  if (managedExchangeLapsed(record, now)) return "lapsed";
  if (record.exchangeFile.linkageTerms.identity === undefined)
    return "no-identity";
  return undefined;
}

/**
 * The terms update this exchange's stored document makes: the same update
 * `alcove update` prints for a configuration holding the same terms and
 * metadata under the same shared secret, since both compose it through
 * core's `termsUpdateFor`.
 *
 * @throws {UsageError} where the terms name no identity for this party
 *   ({@link managedTermsUpdateWithheld}).
 */
export async function makeManagedTermsUpdate(
  record: RunnableManagedExchangeRecord,
): Promise<string> {
  const { linkageTerms, metadata } = record.exchangeFile;
  if (linkageTerms.identity === undefined)
    throw new UsageError(
      "this exchange's terms name no identity for this party, so a terms " +
        "update cannot be made from it. Re-invite your partner.",
    );
  return encodeTermsUpdate(
    termsUpdateFor(linkageTerms, metadata),
    record.sharedSecret,
  );
}
