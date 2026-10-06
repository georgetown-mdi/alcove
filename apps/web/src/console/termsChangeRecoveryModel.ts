import { TERMS_PROPOSAL_FILE_NAME } from "@jobContract/intentSchemas";
import { workingFolderCommand } from "@psi/dockerRunCommand";

import type { TermsProposalApplyOutcome } from "@psi/jobClient/termsProposalClient";

/** The label of the control that applies the partner's changed terms. */
export const APPLY_TERMS_LABEL = "Apply to alcove.yaml";

/** The label of the control that follows an applied change. */
export const REVIEW_APPLIED_TERMS_LABEL = "Review the updated terms";

/** What the run step says once the partner's changed terms were applied. */
export const TERMS_APPLIED_TEXT =
  "Your partner's terms were written to the alcove.yaml in your working " +
  "folder. Review the updated terms, then start the exchange again.";

/**
 * The command applying the proposal run `jobId` left in its folder to the
 * alcove.yaml in the operator's working folder. It asks before it writes, so
 * it runs with a terminal.
 */
function termsApplyCommand(jobId: string): string {
  return workingFolderCommand(
    ["apply", `@${jobId}/${TERMS_PROPOSAL_FILE_NAME}`],
    { interactive: true },
  );
}

/**
 * What the run step says after an apply of run `jobId`'s proposal that did
 * not write the file, by outcome. Each states what happened and what to do.
 */
export function termsApplyOutcomeText(
  outcome: Exclude<TermsProposalApplyOutcome, "applied">,
  jobId: string,
): string {
  switch (outcome) {
    case "busy":
      return "The console is still finishing the run. Try again in a moment.";
    case "configuration-changed":
      return (
        "The alcove.yaml in your working folder changed after you opened " +
        "it, so nothing was applied. Start over to open it again."
      );
    case "run-terms-differ":
      return (
        "This run used terms you changed in the console, not the ones in " +
        "the alcove.yaml in your working folder, so nothing was applied. " +
        "Apply the change from the command line with " +
        `${termsApplyCommand(jobId)}, or start over to open the ` +
        "configuration again and run it."
      );
    case "refused":
      return (
        "The command-line tool refused the change and alcove.yaml was not " +
        "changed. Start over, or ask your partner about the change."
      );
    case "unavailable":
    case "error":
      return (
        "The change could not be applied and alcove.yaml was not changed. " +
        "Start over, or apply it from the command line with " +
        `${termsApplyCommand(jobId)}.`
      );
  }
}
