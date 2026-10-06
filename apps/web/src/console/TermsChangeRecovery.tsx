import { useState } from "react";

import { Button, Group, Text } from "@mantine/core";

import { TermsChangeDelta } from "@components/TermsChangeDelta";
import { applyJobTermsProposal } from "@psi/jobClient/termsProposalClient";

import {
  APPLY_TERMS_LABEL,
  REVIEW_APPLIED_TERMS_LABEL,
  TERMS_APPLIED_TEXT,
  termsApplyOutcomeText,
} from "./termsChangeRecoveryModel";

import type { RelayedTermsChange } from "@psi/jobClient/serverJobExchangeDriver";
import type { TermsProposalApplyOutcome } from "@psi/jobClient/termsProposalClient";

type ApplyState =
  | { status: "idle" }
  | { status: "applying" }
  | { status: "applied" }
  | {
      status: "failed";
      outcome: Exclude<TermsProposalApplyOutcome, "applied">;
    };

/**
 * The run step's account of a partner terms change a console run stopped on:
 * the change, and -- for a run of the opened configuration that wrote it as a
 * proposal -- the control that applies it to the mounted `alcove.yaml`
 * through the console's `alcove apply` (the console writes nothing itself),
 * then the one that reopens the updated configuration for the next run.
 */
export function TermsChangeRecovery({
  termsChange,
  jobId,
  canApply,
  onApplied,
  onReviewApplied,
}: {
  termsChange: RelayedTermsChange;
  jobId: string | undefined;
  /** Whether this run's proposal is one the console can apply: a run of the
   * opened configuration that wrote one. */
  canApply: boolean;
  onApplied: () => void;
  onReviewApplied: () => void;
}) {
  const [state, setState] = useState<ApplyState>({ status: "idle" });
  const offersApply =
    canApply && termsChange.proposalWritten && jobId !== undefined;

  async function apply(): Promise<void> {
    if (jobId === undefined) return;
    setState({ status: "applying" });
    const outcome = await applyJobTermsProposal(jobId);
    if (outcome === "applied") {
      setState({ status: "applied" });
      onApplied();
    } else setState({ status: "failed", outcome });
  }

  return (
    <>
      <TermsChangeDelta delta={termsChange.delta} escaped />
      {offersApply && state.status !== "applied" && (
        <Group mt="sm">
          <Button
            loading={state.status === "applying"}
            onClick={() => void apply()}
          >
            {APPLY_TERMS_LABEL}
          </Button>
        </Group>
      )}
      {state.status === "failed" && jobId !== undefined && (
        <Text size="sm" mt="xs" role="status">
          {termsApplyOutcomeText(state.outcome, jobId)}
        </Text>
      )}
      {state.status === "applied" && (
        <>
          <Text size="sm" mt="xs" role="status">
            {TERMS_APPLIED_TEXT}
          </Text>
          <Group mt="sm">
            <Button onClick={onReviewApplied}>
              {REVIEW_APPLIED_TERMS_LABEL}
            </Button>
          </Group>
        </>
      )}
    </>
  );
}
