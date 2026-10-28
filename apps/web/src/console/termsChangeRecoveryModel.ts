import { TERMS_PROPOSAL_FILE_NAME } from "@jobContract/intentSchemas";
import { workingFolderCommand } from "@psi/dockerRunCommand";

import type { TermsProposalApplyOutcome } from "@psi/jobClient/termsProposalClient";
import type { WorkingFolderCommandLines } from "@psi/dockerRunCommand";

/** The label of the control that applies the partner's changed terms. */
export const APPLY_TERMS_LABEL = "Apply to alcove.yaml";

/** The label of the control that follows an applied change. */
export const REVIEW_APPLIED_TERMS_LABEL = "Review the updated terms";

/** What the run step says once the partner's changed terms were applied. */
export const TERMS_APPLIED_TEXT =
  "Your partner's terms were written to the alcove.yaml in your working " +
  "folder. Review the updated terms, then start the exchange again.";

/** Where a run's proposal is: in the run's own folder, `jobId`, or beside the
 * alcove.yaml in the working folder, for a run that used that file. */
export type TermsProposalLocation =
  { jobId: string } | { inWorkingFolder: true };

/**
 * The command applying the proposal a run left to the alcove.yaml in the
 * operator's working folder. It asks before it writes, so it runs with a
 * terminal.
 */
function termsApplyCommand(
  proposal: TermsProposalLocation,
): WorkingFolderCommandLines {
  return workingFolderCommand(
    [
      "apply",
      "jobId" in proposal
        ? `@${proposal.jobId}/${TERMS_PROPOSAL_FILE_NAME}`
        : TERMS_PROPOSAL_FILE_NAME,
    ],
    { interactive: true },
  );
}

/** What the run step says after an apply that did not write the file, and
 * the `alcove apply` command its message points to, where it names one. */
export interface TermsApplyOutcomeMessage {
  message: string;
  command?: WorkingFolderCommandLines;
}

/**
 * What the run step says after an apply of a run's proposal that did not
 * write the file, by outcome. Each states what happened and what to do.
 */
export function termsApplyOutcomeMessage(
  outcome: Exclude<TermsProposalApplyOutcome, "applied">,
  proposal: TermsProposalLocation,
): TermsApplyOutcomeMessage {
  switch (outcome) {
    case "busy":
      return {
        message:
          "The console is still finishing the run. Try again in a moment.",
      };
    case "configuration-changed":
      return {
        message:
          "jobId" in proposal
            ? "The alcove.yaml in your working folder changed after you " +
              "opened it, so nothing was applied. Start over to open it again."
            : "The alcove.yaml in your working folder changed after this " +
              "run started, so nothing was applied. Start over to open it " +
              "again.",
      };
    case "run-terms-differ":
      return {
        message:
          "This run used terms you changed in the console, not the ones in " +
          "the alcove.yaml in your working folder, so nothing was applied. " +
          "Apply the change from the command line with the command below " +
          "for your system, or start over to open the configuration again " +
          "and run it.",
        command: termsApplyCommand(proposal),
      };
    case "refused":
      return {
        message:
          "The command-line tool refused the change and alcove.yaml was not " +
          "changed. Start over, or ask your partner about the change.",
      };
    case "unavailable":
    case "error":
      return {
        message:
          "The change could not be applied and alcove.yaml was not changed. " +
          "Start over, or apply it from the command line with the command " +
          "below for your system.",
        command: termsApplyCommand(proposal),
      };
  }
}
