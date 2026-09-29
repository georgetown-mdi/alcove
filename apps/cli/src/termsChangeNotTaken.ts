/**
 * The partner terms change a run ended on without taking it on, recorded on
 * the error it ended with so the event stream can state it
 * (`buildErrorEvent`, `./eventStream`).
 */

import { causeChainSome, TermsChangeRefusedError } from "@alcove/core";
import type { TermsDelta } from "@alcove/core";

/**
 * How the partner's terms differ, and whether the run wrote them beside the
 * configuration as a proposal `alcove apply` reads.
 */
export interface TermsChangeNotTaken {
  delta: TermsDelta;
  proposalWritten: boolean;
}

const termsChangesNotTaken = new WeakMap<object, TermsChangeNotTaken>();

/** Record on `error` the terms change its run ended on without taking it on. */
export function recordTermsChangeNotTaken(
  error: object,
  notTaken: TermsChangeNotTaken,
): void {
  termsChangesNotTaken.set(error, notTaken);
}

/**
 * The terms change `error` ended its run on, read off the first link of its
 * cause chain that states one: a refusal {@link recordTermsChangeNotTaken}
 * marked, or core's `TermsChangeRefusedError`, which wrote no proposal.
 * Undefined for any other failure.
 */
export function termsChangeNotTakenOf(
  error: unknown,
): TermsChangeNotTaken | undefined {
  let found: TermsChangeNotTaken | undefined;
  causeChainSome(error, (link) => {
    found =
      termsChangesNotTaken.get(link) ??
      (link instanceof TermsChangeRefusedError
        ? { delta: link.delta, proposalWritten: false }
        : undefined);
    return found !== undefined;
  });
  return found;
}
