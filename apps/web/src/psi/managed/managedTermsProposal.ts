/**
 * A partner terms change a managed run did not take on, kept as a local
 * sibling of the record until the operator applies or declines it
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "A refused terms change").
 */

import { TermsChangeRefusedError } from "@alcove/core";

import {
  clearManagedExchangeTermsProposal,
  getManagedLocalState,
} from "./managedLocalState";
import {
  clearManagedRunTermsProposal,
  keepManagedRunTermsProposal,
  persistManagedExchangeTermsChange,
  persistManagedRunTermsChange,
} from "./managedExchangeStore";

import type {
  ManagedExchangeRecord,
  ManagedTermsChangeWrite,
} from "./managedExchangeRecord";
import type { TermsChange, TermsDelta } from "@alcove/core";
import type { ManagedRunRecordExpectation } from "./managedExchangeStore";
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

/**
 * The operator answered a terms proposal that is no longer the one stored for
 * the exchange: another tab or a scheduled run applied, declined, or replaced
 * it. Nothing is written.
 */
export class ManagedTermsProposalNotStoredError extends Error {
  constructor() {
    super(
      "the terms change shown is no longer the one stored for this exchange",
    );
    this.name = "ManagedTermsProposalNotStoredError";
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

/**
 * Apply the partner terms of the proposal stored for the exchange
 * (the `apply` scope of `applyManagedExchangeTermsChange`), then drop it. `shownProposedAt` is the `proposedAt` of the
 * proposal the operator reviewed; the stored one is read again and applied
 * only where it is that proposal. Takes no lock: a run in flight runs the terms
 * it read when it took its lock, and the next run holds the applied ones.
 *
 * @throws {ManagedTermsProposalNotStoredError} where no proposal, or another
 *   one, is stored; nothing is written.
 * @throws {UsageError} where the stored terms cannot take the partner's.
 * @throws {ZodError} if the resulting record is invalid; nothing is written.
 */
export async function applyManagedTermsProposal(
  id: string,
  shownProposedAt: string,
): Promise<ManagedExchangeRecord> {
  const stored = (await getManagedLocalState(id))?.termsProposal;
  if (stored?.proposedAt !== shownProposedAt)
    throw new ManagedTermsProposalNotStoredError();
  const applied = await persistManagedExchangeTermsChange(id, {
    scope: "apply",
    partnerTerms: stored.partnerTerms,
  });
  await clearManagedExchangeTermsProposal(id);
  return applied;
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

/** What an unattended refusal adds when the change could not be kept for the
 * next visit. */
export const TERMS_CHANGE_NOT_KEPT_REASON =
  "the change could not be kept for your next visit";

/**
 * The write an accepted `change` makes to the stored exchange: the `run`
 * scope where the run continues under the change, the `apply` scope where it
 * cannot.
 */
export function managedTermsChangeWrite(
  change: Pick<TermsChange, "adoptedTerms" | "continuable" | "partnerTerms">,
): ManagedTermsChangeWrite {
  return change.continuable
    ? {
        scope: "run",
        adoptedTerms: change.adoptedTerms,
        partnerTerms: change.partnerTerms,
      }
    : { scope: "apply", partnerTerms: change.partnerTerms };
}

/** Why an unattended refusal kept no change: a re-invite replaced the
 * exchange during the run. */
const TERMS_CHANGE_REINVITED_REASON =
  "a re-invite replaced this exchange's shared secret during the run";

/**
 * The `onTermsChange` a managed run hands core. Attended, it asks
 * `decideTermsChange`: a yes records the partner's terms into the stored
 * exchange before the run continues under them -- as the command line's
 * attended run writes its configuration, or, where the change is one the run
 * cannot continue under, as the `apply` scope writes it, after which core refuses and
 * the next run holds the new terms. A no refuses and writes nothing.
 * Unattended, it keeps the change for the next visit and refuses, the
 * refusal stating a keep that failed rather than being replaced by it. Each
 * refusal is a `TermsChangeRefusedError` holding the delta, so the run's
 * bookkeeping records it as a terms change. `onTakenOn` is told once the
 * stored exchange holds the partner's terms.
 *
 * Every write is the run's own and compares the stored record with
 * `expected` ({@link ManagedRunRecordExpectation}): a re-invite or a terms
 * write the operator made during the run is kept, the take-on then writes
 * nothing and the run goes on, and a take-on that lands moves `expected` to
 * the terms it stored.
 */
export function managedTermsChangeHandler(
  expected: ManagedRunRecordExpectation,
  decideTermsChange: ((change: TermsChange) => Promise<boolean>) | undefined,
  onTakenOn: () => void = () => undefined,
  now: () => Date = () => new Date(),
): (change: TermsChange) => Promise<void> {
  return async (change) => {
    if (decideTermsChange === undefined) {
      const keepFailure = await keepManagedRunTermsProposal(
        expected,
        managedTermsProposalFor(change, now()),
      ).then(
        (kept) => (kept ? undefined : TERMS_CHANGE_REINVITED_REASON),
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
      throw new TermsChangeRefusedError(
        keepFailure === undefined
          ? TERMS_CHANGE_UNATTENDED_REASON
          : `${TERMS_CHANGE_UNATTENDED_REASON}; ${TERMS_CHANGE_NOT_KEPT_REASON}: ${keepFailure}`,
        change.delta,
      );
    }
    if (!(await decideTermsChange(change)))
      throw new TermsChangeRefusedError(
        TERMS_CHANGE_DECLINED_REASON,
        change.delta,
      );
    const written = await persistManagedRunTermsChange(
      expected,
      managedTermsChangeWrite(change),
    );
    if (written === undefined) return;
    expected.linkageTerms = written.exchangeFile.linkageTerms;
    onTakenOn();
    // A change an earlier scheduled run kept is answered by this one.
    // Best-effort: a proposal left behind is one the operator can decline.
    await clearManagedRunTermsProposal(expected).catch(() => undefined);
  };
}
