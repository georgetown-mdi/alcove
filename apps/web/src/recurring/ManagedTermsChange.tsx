import { Alert, Button, Group, Modal, Text } from "@mantine/core";

import { TermsChangeDelta } from "@components/TermsChangeDelta";
import { managedTermsProposalDelta } from "@psi/managed/managedTermsProposal";

import {
  ACCEPT_TERMS_CHANGE_LABEL,
  APPLY_TERMS_PROPOSAL_LABEL,
  DECLINE_TERMS_CHANGE_LABEL,
  TERMS_CHANGE_QUESTION_TITLE,
  termsChangeQuestionText,
  termsProposalText,
} from "./managedTermsChangeModel";

import type { MatchingKeyUnavailableReason, TermsChange } from "@alcove/core";
import type { ManagedTermsProposal } from "@psi/managed/managedLocalStateShape";

/**
 * The question an attended run asks at the terms exchange when the partner's
 * terms changed: the change, and Accept or Decline. Closing the dialog any
 * other way declines, so the run never waits on a question nobody sees. The
 * partner's names arrive raw from this browser's own run and are escaped
 * where they are shown.
 */
export function TermsChangeQuestion({
  change,
  matchingKeyTurnedOff,
  onAnswer,
}: {
  change: TermsChange;
  /** Why accepting turns off the matched-key column, absent where it does
   * not. */
  matchingKeyTurnedOff: MatchingKeyUnavailableReason | undefined;
  onAnswer: (accept: boolean) => void;
}) {
  return (
    <Modal
      opened
      onClose={() => onAnswer(false)}
      title={TERMS_CHANGE_QUESTION_TITLE}
      size="lg"
    >
      <Text size="sm" mb="sm">
        {termsChangeQuestionText(change.continuable, matchingKeyTurnedOff)}
      </Text>
      <TermsChangeDelta delta={change.delta} escaped={false} />
      <Group mt="md">
        <Button onClick={() => onAnswer(true)}>
          {ACCEPT_TERMS_CHANGE_LABEL}
        </Button>
        <Button variant="default" onClick={() => onAnswer(false)}>
          {DECLINE_TERMS_CHANGE_LABEL}
        </Button>
      </Group>
    </Modal>
  );
}

/**
 * The partner terms change a scheduled run refused and kept, with Apply and
 * Decline. Both are withheld while a run holds the exchange.
 */
export function TermsProposalPanel({
  proposal,
  matchingKeyTurnedOff,
  busy,
  disabled,
  failure,
  onApply,
  onDecline,
}: {
  proposal: ManagedTermsProposal;
  /** Why applying the proposal turns off the matched-key column, absent
   * where it does not. */
  matchingKeyTurnedOff: MatchingKeyUnavailableReason | undefined;
  busy: boolean;
  disabled: boolean;
  /** What went wrong with the last Apply or Decline, when one did not
   * complete. */
  failure: string | undefined;
  onApply: () => void;
  onDecline: () => void;
}) {
  return (
    <Alert color="yellow" title={TERMS_CHANGE_QUESTION_TITLE} mb="md">
      <Text size="sm" mb="sm">
        {termsProposalText(matchingKeyTurnedOff)}
      </Text>
      <TermsChangeDelta
        delta={managedTermsProposalDelta(proposal)}
        escaped={false}
      />
      <Group mt="md">
        <Button loading={busy} disabled={disabled} onClick={onApply}>
          {APPLY_TERMS_PROPOSAL_LABEL}
        </Button>
        <Button
          variant="default"
          disabled={disabled || busy}
          onClick={onDecline}
        >
          {DECLINE_TERMS_CHANGE_LABEL}
        </Button>
      </Group>
      {failure !== undefined && (
        <Text size="sm" mt="xs" role="status">
          {failure}
        </Text>
      )}
    </Alert>
  );
}
