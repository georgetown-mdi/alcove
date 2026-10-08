// The next step the CLI states beneath a refusal over a difference in the
// linkage terms (core's `termsDifferenceRefusedBy`), by which party refused and
// by the kind of run: a run from a configuration and key file, which settles
// terms through `alcove update` and `alcove apply`, or a quick exchange, whose
// terms each party infers from its own input file.

import {
  annotate,
  annotationKey,
  annotationOf,
  termsDifferenceRefusedBy,
} from "@alcove/core";
import type { TermsDifferenceRefusedBy } from "@alcove/core";

/**
 * The kind of run a terms refusal ended: `configured` for a run holding a
 * configuration and key file (`alcove exchange`, and the online `alcove
 * invite` and `alcove accept`, which write both before the terms exchange),
 * `quick-exchange` for a run with no shared secret.
 */
export type TermsRefusalRun = "configured" | "quick-exchange";

/**
 * The next step for each run and each party that refused.
 *
 * @internal exported for testing
 */
export const TERMS_REFUSAL_NEXT_STEPS: {
  readonly [R in TermsRefusalRun]: {
    readonly [B in TermsDifferenceRefusedBy]: string;
  };
} = {
  configured: {
    "this-party":
      "Agree the linkage terms with your partner: to take on theirs, ask " +
      "them for an update made with alcove update and apply it with alcove " +
      "apply, or change your configuration to match theirs, then run alcove " +
      "exchange again.",
    partner:
      "Agree the linkage terms with your partner: to have them take on " +
      "yours, send them an update made with alcove update for them to apply " +
      "with alcove apply, or change your configuration to match theirs, then " +
      "run alcove exchange again.",
  },
  "quick-exchange": {
    "this-party":
      "Agree with your partner on the columns your input files share and " +
      "the --linkage-strategy you both pass, then run again.",
    partner:
      "Agree with your partner on the columns your input files share and " +
      "the --linkage-strategy you both pass, then run again.",
  },
};

const TERMS_REFUSAL_RUN = annotationKey<TermsRefusalRun>("terms refusal run");

/**
 * Record on `err` the kind of run it ended, so the command boundary that
 * renders a terms refusal states the next step for that run. Any error that
 * is not a terms refusal is returned unchanged.
 */
export function markTermsRefusalRun<E>(err: E, run: TermsRefusalRun): E {
  if (
    typeof err === "object" &&
    err !== null &&
    termsDifferenceRefusedBy(err) !== undefined
  )
    annotate(err, TERMS_REFUSAL_RUN, run);
  return err;
}

/**
 * The next step beneath `err` when it is a refusal over a difference in the
 * linkage terms, else `undefined`. A refusal no run recorded itself on is
 * taken as a configured run's.
 */
export function termsRefusalNextStep(err: unknown): string | undefined {
  const refusedBy = termsDifferenceRefusedBy(err);
  if (refusedBy === undefined) return undefined;
  const run = annotationOf(err, TERMS_REFUSAL_RUN) ?? "configured";
  return TERMS_REFUSAL_NEXT_STEPS[run][refusedBy];
}
