import { Alert, Button, CopyButton } from "@mantine/core";

import { alertRoleFor } from "@theme";

import {
  COMPROMISE_ACKNOWLEDGE_LABEL,
  COMPROMISE_ACKNOWLEDGE_LEAD,
  COMPROMISE_ACKNOWLEDGE_NOTE,
  COMPROMISE_RESPONSE_MESSAGE,
  COMPROMISE_RESPONSE_STANDS,
  COMPROMISE_RESPONSE_TITLE,
  COMPROMISE_RESPONSE_UNSAVED_REASON,
  COMPROMISE_RESPONSE_UNSAVED_TITLE,
  composeManagedFailureConfirmation,
} from "@psi/managed/managedFailureConfirmation";
import { canReinviteFromRecord } from "@psi/managed/managedReinvite";
import { dateTimeLabel } from "@psi/formatting";

import { CopyRow } from "@exchange/RunSurface";
import styles from "@styles/app.module.css";

import {
  managedReinviteRecoveryCopy,
  managedRunReinvites,
} from "./managedRunLaunchModel";
import { REINVITE_RUN_IN_FLIGHT_REASON } from "./managedReinviteGate";
import { STANDING_CONDITION_CLEAR_LABEL } from "./managedStandingConditionModel";

import type { Ref } from "react";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ManagedReinvite } from "@psi/managed/managedReinvite";
import type { ManagedRunFailureAlert } from "./managedRunLaunchModel";
import type { ManagedStandingConditionView } from "./managedStandingConditionModel";
import type { routeConfirmationReply } from "@psi/managed/managedFailureConfirmation";

interface FailureRecoveryProps {
  failure: ManagedRunFailureAlert;
  record: ManagedExchangeRecord;
  confirmationGated: boolean;
  reinviting: boolean;
  runInFlight: boolean;
  runHoldsReinvite: boolean;
  reinviteFailed: boolean;
  onReinvite: () => void;
  onResolveConfirmation: (
    outcome: Parameters<typeof routeConfirmationReply>[0],
  ) => void;
}

/** The recovery affordance a classified failure offers, below its alert: fast
 * re-invite for the re-invite tiers, the out-of-band confirmation and two-outcome gate
 * for the unexplained tier, and nothing extra for a retry/wait state (the run button
 * and the input picker are the recovery there). Thin over the pure model: the copy and
 * the routing are the model's; this renders the buttons. A composed re-invite renders
 * above this (the {@link ReinvitePanel}), so this never handles the minted artifacts.
 * The host renders none of this while a compromise response stands, showing the
 * {@link CompromiseResponsePanel} in its place. */
export function FailureRecovery({
  failure,
  record,
  confirmationGated,
  reinviting,
  runInFlight,
  runHoldsReinvite,
  reinviteFailed,
  onReinvite,
  onResolveConfirmation,
}: FailureRecoveryProps) {
  if (failure.recovery === "confirm") {
    // Past the gate on a confirmed partner-side failure, the recovery is fast
    // re-invite -- the same panel a direct re-invite tier shows (which mints for the
    // inviter and names asking the partner for the acceptor, with a retry on failure).
    if (confirmationGated)
      return (
        <ReinviteRecovery
          record={record}
          reinviting={reinviting}
          runInFlight={runInFlight}
          runHoldsReinvite={runHoldsReinvite}
          reinviteFailed={reinviteFailed}
          onReinvite={onReinvite}
        />
      );
    return (
      <ConfirmationPanel
        record={record}
        busy={reinviting}
        onResolve={onResolveConfirmation}
      />
    );
  }

  if (managedRunReinvites(failure))
    return (
      <ReinviteRecovery
        record={record}
        reinviting={reinviting}
        runInFlight={runInFlight}
        runHoldsReinvite={runHoldsReinvite}
        reinviteFailed={reinviteFailed}
        onReinvite={onReinvite}
      />
    );

  return null;
}

/** The alert every clearance shows when the store refused the write: the standing
 * condition's two legs and the compromise response's acknowledgement all take the
 * same write, and a rejected one leaves the condition standing wherever it was
 * taken from. */
function ClearFailureAlert() {
  return (
    <Alert role="alert" color="red" title="Could not clear this" mt="sm">
      Nothing changed here, so this still stands. Try again.
    </Alert>
  );
}

interface CompromiseResponsePanelProps {
  /** Whether this device refused the write. The response holds this page either
   * way; an unsaved one ends when the page is left or a run starts, and says
   * so. */
  unsaved: boolean;
  clearing: boolean;
  clearFailed: boolean;
  onAcknowledge: () => void;
}

/**
 * The compromise response: the answer the operator gave at a failure gate, held on
 * the record so it stands at the next visit and not this one alone. It renders
 * wherever the page would have put a gate or an offer of a fresh invitation, since
 * minting on the channel the operator flagged is the act the response names as the
 * wrong one.
 *
 * The acknowledgement below it is the one way back to that offer from this page: the
 * operator reached the partner on another channel and heard the failure was theirs.
 * It clears the standing condition, and the response with it, and mints nothing --
 * the re-invite is offered again once the write lands (a re-invite and a delete are
 * the other two acts that clear it, and neither is reachable from here under one).
 */
export function CompromiseResponsePanel({
  unsaved,
  clearing,
  clearFailed,
  onAcknowledge,
}: CompromiseResponsePanelProps) {
  return (
    <>
      {unsaved && (
        <Alert color="yellow" title={COMPROMISE_RESPONSE_UNSAVED_TITLE} mb="md">
          {COMPROMISE_RESPONSE_UNSAVED_REASON}
        </Alert>
      )}
      <Alert role="alert" color="red" title={COMPROMISE_RESPONSE_TITLE} mb="md">
        <span style={{ whiteSpace: "pre-line" }}>
          {COMPROMISE_RESPONSE_MESSAGE}
        </span>
        {!unsaved && (
          <p className={styles.small}>{COMPROMISE_RESPONSE_STANDS}</p>
        )}
      </Alert>
      <div className={styles.callout}>
        <p className={styles.calloutLead}>{COMPROMISE_ACKNOWLEDGE_LEAD}</p>
        <p className={styles.small}>{COMPROMISE_ACKNOWLEDGE_NOTE}</p>
        {clearFailed && <ClearFailureAlert />}
        <Button
          mt="sm"
          variant="default"
          loading={clearing}
          onClick={onAcknowledge}
        >
          {COMPROMISE_ACKNOWLEDGE_LABEL}
        </Button>
      </div>
    </>
  );
}

interface StandingConditionSectionProps {
  record: ManagedExchangeRecord;
  /** The condition as the page renders it, absent once nothing stands. */
  view: ManagedStandingConditionView | undefined;
  /** Whether the operator has cleared the condition on this visit. */
  settled: boolean;
  clearing: boolean;
  clearFailed: boolean;
  reinviting: boolean;
  runInFlight: boolean;
  runHoldsReinvite: boolean;
  reinviteFailed: boolean;
  /** Whether the live failure above holds the re-invite: it offers the mint itself,
   * or it holds the gate deciding whether one happens. Either way this section shows
   * its status and its clearance and no control of its own. */
  reinviteHeldByFailure: boolean;
  onReinvite: () => void;
  onClear: () => void;
  onResolve: (outcome: Parameters<typeof routeConfirmationReply>[0]) => void;
}

/**
 * The standing condition on the exchange's page: the unanswered evidence an
 * earlier run raised, carried past every no-show and success since, with the one
 * clearance a page offers.
 *
 * The copy and which clearance applies are the pure model's
 * ({@link managedStandingConditionView}); this renders them. The unexplained tier
 * goes through the same two-outcome gate the live Tier-2 failure uses, so a reply
 * that does not add up is written onto the record here exactly as it is there, and
 * clears nothing. Every other tier's explanation the record already holds, so it
 * gets the re-invite recovery and a short acknowledgement instead of an attack
 * checklist (docs/MANAGED_EXCHANGE.md, "Telling a desync from an attack").
 *
 * Once cleared, the section keeps its place and shows the re-invite: settling a
 * condition is not the same act as re-establishing the secret it was raised over.
 * Where the live failure above holds that re-invite -- offering it, or holding the
 * gate that decides whether it happens -- the act is left to it, so there is one
 * control for it and no way around the gate. The host renders none of this while a
 * compromise response stands, showing the {@link CompromiseResponsePanel} in its
 * place.
 */
export function StandingConditionSection({
  record,
  view,
  settled,
  clearing,
  clearFailed,
  reinviting,
  runInFlight,
  runHoldsReinvite,
  reinviteFailed,
  reinviteHeldByFailure,
  onReinvite,
  onClear,
  onResolve,
}: StandingConditionSectionProps) {
  const offersReinvite = !reinviteHeldByFailure;
  const clearFailure = clearFailed ? <ClearFailureAlert /> : null;
  if (settled)
    return offersReinvite ? (
      <ReinviteRecovery
        record={record}
        reinviting={reinviting}
        runInFlight={runInFlight}
        runHoldsReinvite={runHoldsReinvite}
        reinviteFailed={reinviteFailed}
        onReinvite={onReinvite}
      />
    ) : null;
  if (view === undefined) return null;
  const color = view.clearance === "confirmation" ? "red" : "yellow";
  return (
    <>
      <Alert
        color={color}
        role={alertRoleFor(color)}
        title={view.title}
        mb="md"
      >
        {view.message}
      </Alert>
      {view.clearance === "confirmation" ? (
        <>
          <ConfirmationPanel
            record={record}
            busy={clearing}
            onResolve={onResolve}
          />
          {clearFailure}
        </>
      ) : (
        <>
          {offersReinvite && (
            <ReinviteRecovery
              record={record}
              reinviting={reinviting}
              runInFlight={runInFlight}
              runHoldsReinvite={runHoldsReinvite}
              reinviteFailed={reinviteFailed}
              onReinvite={onReinvite}
            />
          )}
          {clearFailure}
          <Button
            mt="sm"
            variant="default"
            loading={clearing}
            onClick={onClear}
          >
            {STANDING_CONDITION_CLEAR_LABEL}
          </Button>
        </>
      )}
    </>
  );
}

interface ReinviteRecoveryProps {
  record: ManagedExchangeRecord;
  reinviting: boolean;
  /** Whether a run of this exchange is under way anywhere this browser profile
   * can see. The mint replaces the secret that run is connecting on, so the
   * control waits it out. */
  runInFlight: boolean;
  /** That same reading, or the mint write's own refusal when a run held the lock
   * at it. It states the reason; it does not disable the control, which the
   * reading gives back when the run ends. */
  runHoldsReinvite: boolean;
  reinviteFailed: boolean;
  onReinvite: () => void;
}

/** The re-invite recovery for a re-invite tier (lapsed, storage, imported). The
 * inviter side re-mints from the stored document, so it gets the mint action; the
 * acceptor side cannot mint an inviter-namespace invitation from its mirrored
 * perspective, so its recovery is to ask the partner to send a fresh invitation,
 * accept it, and delete the record that accept supersedes. Both readings are the pure
 * model's, composed from the record's own `side` ({@link managedReinviteRecoveryCopy});
 * this renders them. */
function ReinviteRecovery({
  record,
  reinviting,
  runInFlight,
  runHoldsReinvite,
  reinviteFailed,
  onReinvite,
}: ReinviteRecoveryProps) {
  const copy = managedReinviteRecoveryCopy(record);
  return (
    <div className={styles.callout}>
      <p className={styles.calloutLead}>{copy.lead}</p>
      {copy.body.map((paragraph) => (
        <p key={paragraph} className={styles.small}>
          {paragraph}
        </p>
      ))}
      {canReinviteFromRecord(record) && (
        <>
          {reinviteFailed && (
            <Alert
              role="alert"
              color="red"
              title="Could not create a fresh invitation"
              mb="sm"
            >
              Nothing changed here; try again.
            </Alert>
          )}
          <Button
            mt="sm"
            onClick={onReinvite}
            loading={reinviting}
            disabled={runInFlight}
          >
            Create a fresh invitation
          </Button>
          {runHoldsReinvite && (
            <p className={styles.small}>{REINVITE_RUN_IN_FLIGHT_REASON}</p>
          )}
        </>
      )}
    </div>
  );
}

interface ForwardableMessageProps {
  label: string;
  value: string;
}

/** A forwardable, multi-paragraph message the operator must READ before sending: the
 * whole prose is shown in a visible, wrapped, readonly area with a copy action --
 * unlike {@link CopyRow}, which collapses a secret to a one-line head/tail preview. The
 * message has no secret (it interpolates only this record's own label and failure
 * time), so showing it in full is correct, not a leak. */
function ForwardableMessage({ label, value }: ForwardableMessageProps) {
  return (
    <div className={styles.copyRow}>
      <span className={styles.copyLabel}>{label}</span>
      <textarea
        className={styles.forwardableMessage}
        readOnly
        value={value}
        aria-label={label}
        rows={value.split("\n").length}
      />
      {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        typeof navigator !== "undefined" && navigator.clipboard ? (
          <CopyButton value={value} timeout={1000}>
            {({ copied, copy }) => (
              <Button
                mt="sm"
                variant="default"
                onClick={copy}
                aria-label={
                  copied ? `${label} copied` : `Copy ${label.toLowerCase()}`
                }
              >
                {copied ? "Copied" : "Copy message"}
              </Button>
            )}
          </CopyButton>
        ) : null
      }
    </div>
  );
}

interface ConfirmationPanelProps {
  record: ManagedExchangeRecord;
  /** Whether the write a reply started is still in flight. Both legs are disabled
   * for it: the two outcomes are one answer, and a second click landing before the
   * write resolves would settle the condition under the other one. */
  busy: boolean;
  onResolve: (outcome: Parameters<typeof routeConfirmationReply>[0]) => void;
}

/** The Tier-2 out-of-band confirmation: the forwardable, pre-filled message the
 * operator copies and sends the partner, then the two-outcome gate. The message and
 * the gate labels are the pure model's; this renders them. */
function ConfirmationPanel({
  record,
  busy,
  onResolve,
}: ConfirmationPanelProps) {
  const confirmation = composeManagedFailureConfirmation(record);
  return (
    <div className={styles.callout}>
      <p className={styles.calloutLead}>Confirm with your partner first.</p>
      <p className={styles.small}>
        Copy this message and send it to your partner on the trusted channel you
        use for this partnership (not a reply to whatever arrived here). It asks
        them to confirm their identity, report what their own tool saw, and say
        whether they ran from more than one place.
      </p>
      <ForwardableMessage
        label="Message to your partner"
        value={confirmation.message}
      />
      <p className={styles.small} style={{ marginTop: "0.75rem" }}>
        When they reply:
      </p>
      <p>
        <Button
          disabled={busy}
          onClick={() => onResolve("confirmed-partner-failure")}
        >
          {confirmation.confirmedOption}
        </Button>{" "}
        <Button
          color="red"
          variant="light"
          disabled={busy}
          onClick={() => onResolve("does-not-add-up")}
        >
          {confirmation.doesNotAddUpOption}
        </Button>
      </p>
    </div>
  );
}

interface ReinvitePanelProps {
  record: ManagedExchangeRecord;
  reinvite: ManagedReinvite;
  /** Attached so a detail-triggered mint (which renders this panel far above the
   * button that fired it) can scroll it into view. */
  panelRef: Ref<HTMLDivElement>;
}

/** The composed re-invite artifacts the operator forwards: the link and code holding
 * the fresh setup secret, and the accurate ongoing cost -- every re-invite puts a fresh
 * live secret on the out-of-band channel, so the confidentiality requirement is
 * ongoing, not one-time. */
export function ReinvitePanel({
  record,
  reinvite,
  panelRef,
}: ReinvitePanelProps) {
  return (
    <div className={styles.callout} ref={panelRef}>
      <p className={styles.calloutLead}>Send this fresh invitation.</p>
      <p className={styles.small}>
        Send this to your partner over your usual trusted channel (for example,
        secure email). It includes a new one-time secret, so treat it as
        confidential - every re-invite puts a fresh secret on that channel, so
        it must stay trusted each time. Your partner accepts it by opening the
        link.
      </p>
      <CopyRow label="Invitation as a link" value={reinvite.deepLink} />
      <CopyRow
        label="Invitation as text"
        noun="invitation"
        value={reinvite.encoded}
      />
      <p className={styles.small}>
        <strong>
          This invitation expires{" "}
          <span className={styles.mono}>
            {dateTimeLabel(new Date(reinvite.tokenExpires))}
          </span>
          .
        </strong>{" "}
        {record.label === ""
          ? "The exchange keeps its terms."
          : `"${record.label}" keeps its terms.`}
      </p>
    </div>
  );
}
