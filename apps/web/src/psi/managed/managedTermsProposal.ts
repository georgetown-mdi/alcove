/**
 * A partner terms change a managed run did not take on, kept as a local
 * sibling of the record until the operator applies or declines it
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "A refused terms change").
 */

import { TermsChangeRefusedError } from "@alcove/core";

import {
  clearManagedExchangeTermsProposal,
  recordManagedExchangeTermsProposal,
} from "./managedLocalState";
import { persistManagedExchangeTermsChange } from "./managedExchangeStore";
import { withManagedExchangeLock } from "./managedExchangeLock";

import type { TermsChange, TermsDelta } from "@alcove/core";
import type { ManagedExchangeRecord } from "./managedExchangeRecord";
import type { ManagedTermsProposal } from "./managedLocalStateShape";

/**
 * A run whose operator took on the partner's changed terms that it could not
 * continue under: the stored exchange holds them, and core refused this run,
 * which was prepared under the terms they replace. Nothing about the
 * exchange failed; the next run holds the new terms.
 */
export class ManagedTermsChangeTakenOnError extends Error {
  constructor(options: { cause: unknown }) {
    super(
      "your partner's changed linkage terms were saved to this exchange; " +
        "they change terms this run was prepared under, so it stopped before " +
        "any linkage key or data moved",
      options,
    );
    this.name = "ManagedTermsChangeTakenOnError";
  }
}

/** The proposal a run refusing `change` at `at` keeps: the partner's terms and
 * how they differ, each part of the delta present where it differs. */
export function managedTermsProposalFor(
  change: Pick<TermsChange, "delta" | "partnerTerms">,
  at: Date,
): ManagedTermsProposal {
  const { received, sent, partnerDeduplicate, otherTerms } = change.delta;
  return {
    proposedAt: at.toISOString(),
    partnerTerms: change.partnerTerms,
    delta: {
      ...(received !== undefined
        ? { received: { added: received.added, removed: received.removed } }
        : {}),
      ...(sent !== undefined
        ? { sent: { added: sent.added, removed: sent.removed } }
        : {}),
      ...(partnerDeduplicate !== undefined
        ? {
            partnerDeduplicate: {
              expected: partnerDeduplicate.expected,
              presented: partnerDeduplicate.presented,
            },
          }
        : {}),
      otherTerms,
    },
  };
}

/** A kept proposal's delta in core's shape, for the display every front end
 * shares. */
export function managedTermsProposalDelta(
  proposal: ManagedTermsProposal,
): TermsDelta {
  return {
    received: proposal.delta.received,
    sent: proposal.delta.sent,
    partnerDeduplicate: proposal.delta.partnerDeduplicate,
    otherTerms: proposal.delta.otherTerms,
  };
}

/** Keep `change`, which an unattended run refused, for the next visit. */
export async function keepManagedTermsProposal(
  id: string,
  change: TermsChange,
  at: Date,
): Promise<void> {
  await recordManagedExchangeTermsProposal(
    id,
    managedTermsProposalFor(change, at),
  );
}

/**
 * Apply a kept proposal to the stored exchange, as `alcove apply` applies a
 * terms update, then drop it. Held under the run lock without waiting: a run
 * of this exchange in flight refuses the apply, rather than having its terms
 * rewritten under it.
 *
 * @throws {ManagedExchangeLockUnavailableError} while a run of this exchange
 *   holds the lock; nothing is written.
 * @throws {UsageError} where the stored terms cannot take the partner's.
 * @throws {ZodError} if the resulting record is invalid; nothing is written.
 */
export async function applyManagedTermsProposal(
  id: string,
  proposal: ManagedTermsProposal,
): Promise<ManagedExchangeRecord> {
  return withManagedExchangeLock(
    id,
    async () => {
      const applied = await persistManagedExchangeTermsChange(id, {
        scope: "apply",
        partnerTerms: proposal.partnerTerms,
      });
      await clearManagedExchangeTermsProposal(id);
      return applied;
    },
    { ifAvailable: true },
  );
}

/** Decline a kept proposal: drop it and leave the stored exchange as it is. */
export async function declineManagedTermsProposal(id: string): Promise<void> {
  await clearManagedExchangeTermsProposal(id);
}

/** Why a run did not take on its partner's changed terms: the operator
 * declined at the prompt. */
export const TERMS_CHANGE_DECLINED_REASON =
  "you declined your partner's changed linkage terms, so the run stopped " +
  "before any linkage key or data moved and this exchange was not changed";

/** Why a run did not take on its partner's changed terms: a scheduled run had
 * nobody to ask. */
export const TERMS_CHANGE_UNATTENDED_REASON =
  "your partner's linkage terms changed and a scheduled run cannot ask you " +
  "about the change, so it stopped before any linkage key or data moved; " +
  "open this exchange to apply or decline the change";

/**
 * The `onTermsChange` a managed run hands core. Attended, it asks
 * `decideTermsChange`: a yes records the partner's terms into the stored
 * exchange before the run continues under them -- as the command line's
 * attended run writes its configuration, or, where the change is one the run
 * cannot continue under, as `alcove apply` does, after which core refuses and
 * the next run holds the new terms. A no refuses and writes nothing.
 * Unattended, it keeps the change for the next visit and refuses. Each
 * refusal is a `TermsChangeRefusedError` holding the delta, so the run's
 * bookkeeping records it as a terms change. `onTakenOn` is told once the
 * stored exchange holds the partner's terms.
 */
export function managedTermsChangeHandler(
  id: string,
  decideTermsChange: ((change: TermsChange) => Promise<boolean>) | undefined,
  onTakenOn: () => void = () => undefined,
  now: () => Date = () => new Date(),
): (change: TermsChange) => Promise<void> {
  return async (change) => {
    if (decideTermsChange === undefined) {
      await keepManagedTermsProposal(id, change, now());
      throw new TermsChangeRefusedError(
        TERMS_CHANGE_UNATTENDED_REASON,
        change.delta,
      );
    }
    if (!(await decideTermsChange(change)))
      throw new TermsChangeRefusedError(
        TERMS_CHANGE_DECLINED_REASON,
        change.delta,
      );
    await persistManagedExchangeTermsChange(
      id,
      change.continuable
        ? {
            scope: "run",
            adoptedTerms: change.adoptedTerms,
            partnerTerms: change.partnerTerms,
          }
        : { scope: "apply", partnerTerms: change.partnerTerms },
    );
    onTakenOn();
    // A change an earlier scheduled run kept is answered by this one.
    // Best-effort: a proposal left behind is one the operator can decline.
    await declineManagedTermsProposal(id).catch(() => undefined);
  };
}
