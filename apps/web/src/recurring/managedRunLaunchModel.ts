/**
 * The pure model behind the managed re-run's launch surface: classifies a launch
 * outcome into the state the surface shows -- title, message, and recovery
 * affordance. No React, no I/O.
 *
 * The benign states ({@link benignRerunOutcome}) read from the launch error
 * directly; the RECORDED tiers ({@link deriveManagedFailureTier}) derive from
 * the record's own bookkeeping. No tier's copy echoes a partner-influenced
 * value except the record's own local `expires`.
 */

import {
  RoundCapacityError,
  isSetTooLargeError,
  sanitizeErrorForDisplay,
} from "@alcove/core";

import {
  IMPORTED_FAILURE_REMEDY,
  IMPORTED_FAILURE_TITLE,
  INPUT_FAILURE_TITLE,
  PARTIAL_ROTATION_FAILURE_TITLE,
  PARTNER_PROTOCOL_REFUSAL_PROBLEM,
  PARTNER_PROTOCOL_REFUSAL_TITLE,
  PARTNER_REFUSED_SET_PROBLEM,
  PARTNER_REFUSED_SET_REMEDY,
  PARTNER_REFUSED_SET_TITLE,
  PARTNER_REFUSED_TERMS_REMEDY,
  PARTNER_SECRET_NOT_SAVED_PROBLEM,
  PARTNER_SECRET_NOT_SAVED_TITLE,
  PARTNER_SET_TOO_LARGE_PROBLEM,
  PARTNER_SET_TOO_LARGE_REMEDY,
  PARTNER_SET_TOO_LARGE_TITLE,
  RAN_ELSEWHERE_IMPORT_REMEDY,
  RECORDED_PARTNER_PROTOCOL_REFUSAL_REMEDY,
  SINGLE_COLUMN_DELIMITER_REMEDY,
  TERMS_CHANGE_FAILURE_TITLE,
  TERMS_DIFFERENCE_PROBLEM,
  TERMS_DIFFERENCE_TITLE,
  TERMS_SHORTFALL_FAILURE_TITLE,
  TOO_LARGE_REMEDY,
  TOO_LARGE_SET_SOURCE,
  UNEXPLAINED_FAILURE_TITLE,
  partnerProtocolRefusalCopy,
  partnerProtocolRefusalMessage,
  tooLargeFailureTitle,
  tooLargeSetProblem,
} from "@psi/managed/managedFailureCopy";
import {
  ManagedExchangeExpiredError,
  ManagedExchangeNotRunnableError,
  ManagedInputError,
  ManagedRelayRegistrationError,
  benignRerunOutcome,
  tooLargeReadingOf,
} from "@psi/managed/managedRun";
import {
  deriveManagedFailureTier,
  importedSinceLastSuccess,
  rotationInFlightUnansweredAtLaunch,
} from "@psi/managed/managedFailureTiers";
import { DEFAULT_RELAY_OFF_REMEDY } from "@psi/transport/defaultRelaySwitch";
import { ManagedSignalingEndpointRefusedError } from "@psi/managed/managedRendezvous";
import { canReinviteFromRecord } from "@psi/managed/managedReinvite";
import { failedWithDefaultRelayOff } from "@psi/transport/iceGathering";

import {
  HandlePermissionError,
  MANAGED_INPUT_FILE_NAME,
  ManagedInputFileMissingError,
} from "@psi/managed/managedInputHandle";

import { dateTimeLabel } from "@psi/formatting";
import { matchingKeyTurnedOffNotice } from "@psi/matchingKeyModel";

import type {
  ManagedExchangeRecord,
  TooLargeReading,
} from "@psi/managed/managedExchangeRecord";
import type { ManagedFailureTier } from "@psi/managed/managedFailureTiers";
import type { ManagedLocalState } from "@psi/managed/managedLocalState";
import type { MatchingKeyUnavailableReason } from "@alcove/core";

export {
  INPUT_FAILURE_TITLE,
  TERMS_SHORTFALL_FAILURE_TITLE,
  UNEXPLAINED_FAILURE_TITLE,
} from "@psi/managed/managedFailureCopy";

/** The recovery affordance a surface state offers: drives what the host renders
 * below the alert, and through {@link managedRunRetryable} whether the
 * saved-exchanges footer stands beside it. The state's copy is a sibling field
 * authored alongside it, not derived from it. It does not gate the run control,
 * which the surface enables from the input source and the device's connectivity
 * alone.
 *
 * - `"reinvite"` -- fast re-invite (a lapsed, desynced, restored, or
 *   persist-failed exchange, or a refused saved signaling address). The
 *   inviter side re-mints from the stored document; the acceptor side asks
 *   the partner to re-invite (the surface names which).
 * - `"retry"` -- retryable in place (fix the input, or retry a transport drop).
 * - `"wait"` -- not this run's to act on (a run in progress elsewhere).
 * - `"confirm"` -- the Tier-2 out-of-band confirmation and the two-outcome gate.
 * - `"restate"` -- what this exchange matches on must be decided again, or the
 *   input replaced: the file cannot supply every agreed linkage key, and the
 *   same file refuses identically every time. Not `"retry"`.
 * - `"split"` -- the input must be split into smaller exchanges: a set this
 *   exchange sends is over the most values the partner can receive, or the
 *   partner's set is larger than this browser can match, and the same files
 *   refuse identically every time. Not `"retry"`.
 * - `"ask-partner"` -- the cause is the partner's or is settled with them:
 *   their run refused to send its set and reported why, or this party refused
 *   what their run sent, and it fails identically every time. Not `"retry"`.
 * - `"none"` -- nothing to recover (informational; e.g. a missed window). */
type ManagedRunRecovery =
  | "reinvite"
  | "retry"
  | "wait"
  | "confirm"
  | "restate"
  | "split"
  | "ask-partner"
  | "none";

/** The two readings of a record a live launch failure is classified against. They
 * differ because a failed run stamps its own `lastRun` before the host reloads, and
 * that stamp REPLACES the entry rather than merging into it: a no-show's stamp has
 * no `failureKind` at all, so a kind standing before the run is not in the
 * reloaded record to read. */
interface ManagedRunRecordReadings {
  /** The record as the STORE held it at the run's launch: the standing evidence
   * this run's own bookkeeping stamp cannot have erased. The no-show state is read
   * against it ({@link missedFailure}). */
  atLaunch: ManagedExchangeRecord;
  /** The record reloaded after the failure, holding whatever `lastRun` this run
   * just stamped -- the evidence every derived tier reads. The host falls back to
   * the at-launch record when the reload rejects, so the two can be the same
   * record. */
  afterRun: ManagedExchangeRecord;
}

/** A classified launch state the host renders as an alert: the state's kind (the
 * pre-connection benign states plus the derived tiers), its plain copy, and the
 * recovery affordance beneath it. */
export interface ManagedRunFailure {
  /** The state's kind. The benign states read from the error, plus the recorded
   * tiers derived from the record's bookkeeping. */
  kind:
    | "expired"
    | "input"
    | "terms-shortfall"
    | "too-large"
    | "partner-set-too-large"
    | "partner-refused-set"
    | "partner-storage"
    | "partner-refused-terms"
    | "partner-protocol-refusal"
    | "terms-change"
    | "relay-registration"
    | "saved-address-refused"
    | "custody-unreadable"
    | "already-running"
    | "stopped"
    | "missed"
    | "storage"
    | "partial-rotation"
    | "imported"
    | "transport"
    | "unexplained";
  /** The surface title. */
  title: string;
  /** The operator-facing message. */
  message: string;
  /** What the exchange itself reported, escaped for display and shown in a
   * labelled block of its own rather than inside {@link message}, which is this
   * application's own words (docs/notes/reported-failure-cause.md). Set only on
   * the states {@link managedRunCausePlacement} places `"attributed"`, and never
   * on a state read back from a record, which holds no error to report. */
  reportedCause?: string;
  /** The recovery affordance the host renders. */
  recovery: ManagedRunRecovery;
}

/** The benign expiry state's copy: a lapsed stored secret, plain re-invite
 * framing (see docs/MANAGED_EXCHANGE.md, "Expiry is its own state"), naming the
 * lapsed instant the error has so the operator sees when the bound passed. */
function expiredFailure(expires: string): ManagedRunFailure {
  return {
    kind: "expired",
    title: "This exchange's shared secret has expired",
    message:
      `The shared secret expired ${dateTimeLabel(new Date(expires))} ` +
      "and can no longer be used, so this exchange cannot run again until you " +
      "re-invite your partner. Set up a fresh invitation with the same partner " +
      "to continue.",
    recovery: "reinvite",
  };
}

/** The unreadable-custody state as a live launch reads it off a
 * {@link ManagedExchangeNotRunnableError}: the stored record the run read
 * inside the lock was gone, invalid, or held a configuration only, so the run
 * refused before reading the input file and before connecting. Not the storage
 * state: nothing rotated here, so there is no desync to recover from. Recovery
 * is `"none"`, and it shows none of the launch error: the wrapped cause is a
 * record id or a schema issue list, internal names the operator cannot act on,
 * so the error stays with the developer console
 * ({@link classifyManagedRunFailure}). */
const NOT_RUNNABLE_FAILURE: ManagedRunFailure = {
  kind: "custody-unreadable",
  title: "This exchange's stored copy can no longer be run",
  message:
    "This exchange's stored copy is no longer one this page can run: it was " +
    "deleted, replaced, or holds only a configuration. The run stopped before " +
    "reading your file and before connecting. Nothing left this device, and " +
    "your partner was not contacted. Reload the list and open the exchange " +
    "again.",
  recovery: "none",
};

/** The unreadable-custody state read back from a record's stamp at a later
 * visit: the last run could not use the stored copy it read. */
const RECORDED_CUSTODY_UNREADABLE_FAILURE: ManagedRunFailure = {
  kind: "custody-unreadable",
  title: "Part of this exchange's stored copy could not be read",
  message:
    "The last run stopped before reading your file and before connecting, " +
    "because this browser could not read this exchange's stored copy. " +
    "Nothing left this device, nothing here changed, and your partner was " +
    "not contacted. Reload the list and open the exchange again; if a run " +
    "stops the same way, running it again will not help until this browser " +
    "can read it.",
  recovery: "none",
};

/** The benign "already running elsewhere" state: another tab or a scheduled run holds
 * the single-writer lock. Not a failure of this run. */
const ALREADY_RUNNING_FAILURE: ManagedRunFailure = {
  kind: "already-running",
  title: "This exchange is already running",
  message:
    "A run for this exchange is already in progress in another tab or a " +
    "scheduled run on this device. Wait for it to finish, then try again.",
  recovery: "wait",
};

/** The benign state of a run this window's re-invite or relay enrollment
 * stopped while it waited for its partner: before the rotation-in-flight
 * marker, so no key exchange ran and nothing of the run was recorded. */
const STOPPED_FAILURE: ManagedRunFailure = {
  kind: "stopped",
  title: "This run was stopped",
  message:
    "You stopped this run while it waited for your partner, to create a " +
    "fresh invitation or change the relay registration. Nothing was " +
    "exchanged and nothing from the run was saved. Run it again when you " +
    "are ready; after a fresh invitation, the run connects once your " +
    "partner has accepted it.",
  recovery: "none",
};

/** The benign no-show state: the run spent its whole wait on the partner's runner
 * and never connected, so no handshake ran and nothing left this device. Not the
 * transport copy, which would send the operator to check their own connection.
 * Recovery is `"none"`: nothing here is decided again, and the run control is
 * not gated by a classified state, so the operator runs it again once their
 * partner is ready.
 *
 * The copy names re-invite for a partner who was at their machine at an agreed
 * time and still never arrived (see docs/MANAGED_EXCHANGE.md, "A missed window
 * is neither desync nor attack"), but stays out of the recovery affordance. It
 * also names the import a copy needs once a run elsewhere has rotated its
 * secret: the rendezvous derives from the secret, so that copy meets no one.
 *
 * Issued from THIS run's own no-show error ({@link classifyManagedRunFailure}),
 * never from a record's recorded outcome, which belongs to whichever run
 * stamped it. */
const MISSED_FAILURE: ManagedRunFailure = {
  kind: "missed",
  title: "Your partner did not arrive",
  message:
    "This run waited for your partner and they never connected, so nothing was " +
    "exchanged and nothing left this device. That is not a fault on this " +
    "device: agree on a time with your partner over your usual channel, and run " +
    `this exchange again when they are ready. ${RAN_ELSEWHERE_IMPORT_REMEDY} ` +
    "If they were running their side at a time you agreed on and this keeps " +
    "happening, re-invite your partner to reconnect; the exchange keeps your " +
    "terms, gets a new secret, and uses the coordination server the new " +
    "invitation names.",
  recovery: "none",
};

/** The benign input state's copy. Fixed and non-oracular: an input rejection's
 * partner-influenced detail (the unsatisfied field names) is never echoed. */
const INPUT_FAILURE: ManagedRunFailure = {
  kind: "input",
  title: INPUT_FAILURE_TITLE,
  message:
    "The input file for this run is missing, could not be read, or does not " +
    "have the columns this exchange needs. Check that the file is in place " +
    `- where this exchange has a folder, as ${MANAGED_INPUT_FILE_NAME} in ` +
    "it - and matches the agreed terms, then try again.",
  recovery: "retry",
};

/** The input state where an attended run was not allowed to edit the working
 * folder. Choosing the folder again comes first because a permission that
 * already reads as denied shows no prompt on a re-run. */
const INPUT_PERMISSION_FAILURE_READWRITE: ManagedRunFailure = {
  ...INPUT_FAILURE,
  message:
    "The run stopped before connecting because this site was not allowed to " +
    "edit this exchange's folder, so the input file was not read and nothing " +
    "left this device. Choose the folder again on this exchange's page, or " +
    "run this exchange again and allow access if your browser asks.",
};

/** The input state where a scheduled run's standing permission to read the
 * working folder lapsed. A scheduled run only ever queries and never prompts,
 * so the remedy names no browser prompt: running the exchange attended, where
 * the browser may still offer one, or choosing the folder again. */
const INPUT_PERMISSION_FAILURE_READ: ManagedRunFailure = {
  ...INPUT_FAILURE,
  message:
    "The run stopped before connecting because this site's permission to " +
    "read this exchange's folder lapsed, so the input file was not read and " +
    "nothing left this device. Open the exchange and run it attended, or " +
    "choose the folder again on this exchange's page.",
};

/** Which input state a launch error lands on: the one naming the file the run
 * looked for and the folder it looked in, where the working folder held no file
 * under the conventioned name; the permission state -- by the failed access's
 * mode, since an attended edit request and a scheduled read query fail into
 * different remedies -- where the folder's permission was refused; and the
 * fixed input copy otherwise. Both names are the operator's own -- the one
 * fixed name and the folder they chose -- so naming them echoes nothing a
 * partner wrote. */
function inputFailure(error: unknown): ManagedRunFailure {
  if (
    !(error instanceof ManagedInputError) ||
    error.rejection.reason !== "acquire"
  )
    return INPUT_FAILURE;
  if (error.rejection.cause instanceof HandlePermissionError)
    return error.rejection.cause.mode === "readwrite"
      ? INPUT_PERMISSION_FAILURE_READWRITE
      : INPUT_PERMISSION_FAILURE_READ;
  if (!(error.rejection.cause instanceof ManagedInputFileMissingError))
    return INPUT_FAILURE;
  const { fileName, folderName } = error.rejection.cause;
  return {
    ...INPUT_FAILURE,
    message:
      `The run stopped before connecting because the folder "${folderName}" ` +
      `has no file named ${fileName}, and nothing left this device. Put this ` +
      `run's input in that folder as ${fileName}, or choose a different ` +
      `folder for this exchange, then try again.`,
  };
}

/** The benign linkage-shortfall state: the file was read and cannot supply
 * every linkage key the standing terms declare, so the run stopped before
 * connecting. Fixed and non-oracular like the input state's: the shortfall
 * names partner-authored keys and fields, and the copy states the condition
 * instead. Not the retry state -- the same file refuses identically, so the
 * only ways forward are a conforming file or terms agreed on with the partner.
 * The recorded tier reaches it too, so an unattended run's shortfall is
 * classified here rather than through the input state's re-pick. */
const TERMS_SHORTFALL_FAILURE: ManagedRunFailure = {
  kind: "terms-shortfall",
  title: TERMS_SHORTFALL_FAILURE_TITLE,
  message:
    "The run stopped before connecting because your input file cannot supply " +
    "every linkage key this exchange agreed to match on, and nothing left this " +
    "device. Running it again with the same file stops the same way - this is " +
    "not a connection problem. Run it with a file that covers every agreed key, " +
    "or set the exchange up again with your partner over the keys both your " +
    "files can supply.",
  recovery: "restate",
};

/** The benign terms-change state with a proposal stored for the exchange: the
 * partner's linkage terms changed, the run did not take them on, and the
 * change waits on this device for the operator's decision. Its copy claims
 * nothing about what this run sent: the terms exchange that meets the change
 * runs past the data-exchange boundary this model gates such claims on. Not
 * the retry state -- the same terms refuse identically -- and its way forward
 * is the run surface's own terms-change panel, so the alert offers no
 * recovery of its own. */
export const TERMS_CHANGE_FAILURE: ManagedRunFailure = {
  kind: "terms-change",
  title: TERMS_CHANGE_FAILURE_TITLE,
  message:
    "Your partner's linkage terms changed since this exchange last ran, and " +
    "this run did not take them on. Running it again stops the same way " +
    "until you apply the change to this exchange or your partner goes back " +
    "to the terms you agreed on.",
  recovery: "none",
};

/** The benign terms-change state with no proposal stored: the operator
 * declined the change, at the question or on the panel, or the proposal could
 * not be kept. No change waits to be applied, and the next run the operator
 * starts asks about the change again, so running again is the way forward. */
export const TERMS_CHANGE_DECLINED_FAILURE: ManagedRunFailure = {
  kind: "terms-change",
  title: TERMS_CHANGE_FAILURE_TITLE,
  message:
    "Your partner's linkage terms changed since this exchange last ran, and " +
    "the change was declined, so this exchange was not changed. Run the " +
    "exchange again to see the change and accept or decline it.",
  recovery: "retry",
};

/** The state after the operator accepted the partner's changed terms that this
 * run could not continue under: the stored exchange holds them, and the next
 * run exchanges under them. Retryable in place: running again is the whole of
 * the way forward. */
export const TERMS_CHANGE_TAKEN_ON_FAILURE: ManagedRunFailure = {
  kind: "terms-change",
  title: "Run the exchange again",
  message:
    "Your partner's changed linkage terms were saved to this exchange. They " +
    "change terms this run was prepared under, so it stopped before any " +
    "linkage key or data moved. Run the exchange again to exchange under the " +
    "new terms.",
  recovery: "retry",
};

function termsChangeTakenOnKeyOffFailure(
  reason: MatchingKeyUnavailableReason,
): ManagedRunFailure {
  return {
    ...TERMS_CHANGE_TAKEN_ON_FAILURE,
    message:
      `${TERMS_CHANGE_TAKEN_ON_FAILURE.message} ` +
      matchingKeyTurnedOffNotice(reason, "did"),
  };
}

const TERMS_CHANGE_TAKEN_ON_KEY_OFF_FAILURES: Record<
  MatchingKeyUnavailableReason,
  ManagedRunFailure
> = {
  "count-only": termsChangeTakenOnKeyOffFailure("count-only"),
  "single-pass": termsChangeTakenOnKeyOffFailure("single-pass"),
  "no-output": termsChangeTakenOnKeyOffFailure("no-output"),
};

/**
 * {@link TERMS_CHANGE_TAKEN_ON_FAILURE}, naming the matched-key column the
 * saved terms turned off, if they did.
 */
export function termsChangeTakenOnFailure(
  matchingKeyTurnedOff: MatchingKeyUnavailableReason | undefined,
): ManagedRunFailure {
  return matchingKeyTurnedOff === undefined
    ? TERMS_CHANGE_TAKEN_ON_FAILURE
    : TERMS_CHANGE_TAKEN_ON_KEY_OFF_FAILURES[matchingKeyTurnedOff];
}

/** The note a completed run shows when the store refused its success stamp:
 * the results stand, but the exchange's stored status still names the run
 * before this one. */
export const RUN_OUTCOME_UNSAVED_NOTE = {
  title: "This run's success was not saved",
  message:
    "The exchange completed and your results are below, but this browser " +
    "could not save that this run succeeded, so this exchange may still show " +
    "its previous run. Download your results before you leave this page.",
} as const;

/** The shortfall state for an input whose whole header read as ONE column: the
 * shape a file separated by something other than the delimiter this exchange
 * reads it by comes out as ({@link ../psi/managed/managedInputGuard.ts}). The
 * terms are not the operator's problem here, so the copy states the reading and
 * the remedy every managed surface states for it
 * ({@link SINGLE_COLUMN_DELIMITER_REMEDY}) rather than the agreed keys. A
 * record's delimiter is fixed for the partnership, so neither way out is a
 * retry, and the state keeps the shortfall tier's recovery.
 *
 * Reached from the live launch error, which holds the reading, and from a
 * record whose shortfall stamp holds it
 * ({@link ../psi/managed/managedExchangeRecord.ts}, `singleColumnInput`). */
const SINGLE_COLUMN_SHORTFALL_FAILURE: ManagedRunFailure = {
  kind: "terms-shortfall",
  title: TERMS_SHORTFALL_FAILURE_TITLE,
  message:
    "The run stopped before connecting because your input file read as a " +
    "single column, which cannot supply every linkage key this exchange " +
    "agreed to match on, and nothing left this device. " +
    SINGLE_COLUMN_DELIMITER_REMEDY,
  recovery: "restate",
};

/** Which shortfall state a launch error lands on: the single-column reading where
 * the input guard's own rejection holds it, the fixed shortfall copy otherwise --
 * the run boundary's refusal reports no column count for this state to read. */
function shortfallFailure(error: unknown): ManagedRunFailure {
  return error instanceof ManagedInputError &&
    error.rejection.reason === "columns" &&
    error.rejection.singleColumn
    ? SINGLE_COLUMN_SHORTFALL_FAILURE
    : TERMS_SHORTFALL_FAILURE;
}

const TOO_LARGE_RETRY_NOTE =
  "Running it again with the same files stops the same way - this is not a " +
  "connection problem.";

/** The benign too-large state read back from a record. The record holds no
 * count, so this copy states no size; a live launch shows the refusal's own
 * message instead ({@link tooLargeFailure}). Not the retry state -- the same
 * files refuse identically. */
function recordedTooLargeFailure(reading: TooLargeReading): ManagedRunFailure {
  return {
    kind: "too-large",
    title: tooLargeFailureTitle(reading),
    message:
      `The last run stopped because ${TOO_LARGE_SET_SOURCE} ` +
      `${tooLargeSetProblem(reading)}, so it was not sent. ` +
      `${TOO_LARGE_RETRY_NOTE} ${TOO_LARGE_REMEDY}`,
    recovery: "split",
  };
}

/** The too-large state for THIS run's refusal: the refusal's message states the
 * set's size, the bound, and the remedy, or that the first-round count could
 * not be taken and why, so it is the state's whole message. The titles are the
 * one-shot seats' own for the same refusal. */
function tooLargeFailure(error: unknown): ManagedRunFailure {
  if (!isSetTooLargeError(error)) return recordedTooLargeFailure({});
  return {
    ...recordedTooLargeFailure(tooLargeReadingOf(error)),
    message: sanitizeErrorForDisplay(error),
  };
}

/** The benign state of a run stopped because the partner's set for a linkage
 * key holds more values than this browser can match. The record holds no
 * count, so this copy states neither figure; a live launch this browser
 * refused shows the refusal's own message instead
 * ({@link partnerSetTooLargeFailure}). Not the retry state -- the same partner
 * input refuses identically. */
const RECORDED_PARTNER_SET_TOO_LARGE_FAILURE: ManagedRunFailure = {
  kind: "partner-set-too-large",
  title: PARTNER_SET_TOO_LARGE_TITLE,
  message:
    `The last run stopped because ${PARTNER_SET_TOO_LARGE_PROBLEM}. ` +
    "Running it again stops the same way until your partner's input is " +
    `smaller. ${PARTNER_SET_TOO_LARGE_REMEDY}`,
  recovery: "split",
};

/** The partner-set-too-large state for THIS run: where this browser refused,
 * the refusal's message states the partner's count, this browser's ceiling,
 * and the remedy, so it is the state's whole message; where the partner
 * stopped the run, its abort states no figure, so the recorded copy stands. */
function partnerSetTooLargeFailure(error: unknown): ManagedRunFailure {
  if (!(error instanceof RoundCapacityError))
    return RECORDED_PARTNER_SET_TOO_LARGE_FAILURE;
  return {
    ...RECORDED_PARTNER_SET_TOO_LARGE_FAILURE,
    message: sanitizeErrorForDisplay(error),
  };
}

/** The benign state of a run stopped because the partner's run refused to
 * send its set for a cause other than its size. The partner's abort states
 * only that it refused, so a live launch and the record read back show the
 * same copy. Not the retry state -- the partner's run refuses identically. */
const PARTNER_REFUSED_SET_FAILURE: ManagedRunFailure = {
  kind: "partner-refused-set",
  title: PARTNER_REFUSED_SET_TITLE,
  message:
    `The last run stopped because ${PARTNER_REFUSED_SET_PROBLEM}. ` +
    "Running it again stops the same way until your partner fixes the " +
    `cause. ${PARTNER_REFUSED_SET_REMEDY}`,
  recovery: "ask-partner",
};

/** The Tier-1 state of a run stopped because the partner could not save the
 * new secret this device had saved, so the two now hold different secrets. A
 * live launch and the record read back show the same copy, which names the
 * re-invite and offers no retry: a run under this device's secret cannot meet
 * a partner holding the one before it. The record's standing condition keeps
 * this state across the no-shows and failed handshakes of the runs after it,
 * so the copy names "a run" rather than the last one. */
const PARTNER_STORAGE_FAILURE: ManagedRunFailure = {
  kind: "partner-storage",
  title: PARTNER_SECRET_NOT_SAVED_TITLE,
  message:
    `A run stopped because ${PARTNER_SECRET_NOT_SAVED_PROBLEM}. Scheduled ` +
    "runs keep running but cannot reach your partner, and running the " +
    "exchange again cannot either; it needs a fresh invitation, which keeps " +
    "your terms and gives the exchange a new secret.",
  recovery: "reinvite",
};

/** The benign state of a run stopped because the partner's run refused this
 * exchange's linkage terms as differing from its own, at the terms exchange
 * before any linkage key or data moved. The same copy as the one-shot
 * exchange's alert for the partner's side, with the step this exchange's page
 * offers. Not the retry state -- the same terms refuse identically -- and its
 * way forward is the page's Change terms section, so the alert offers no
 * recovery of its own. Its copy attests non-disclosure, so the recorded tier
 * is gated ({@link MANAGED_RUN_NON_DISCLOSURE_ATTESTATION}); the live reading
 * is not, since the error's mark is set only at the terms exchange. */
const PARTNER_REFUSED_TERMS_FAILURE: ManagedRunFailure = {
  kind: "partner-refused-terms",
  title: TERMS_DIFFERENCE_TITLE,
  message: `${TERMS_DIFFERENCE_PROBLEM.partner} ${PARTNER_REFUSED_TERMS_REMEDY}`,
  recovery: "none",
};

/** The benign state of a run stopped because this party refused what its
 * partner sent ({@link PARTNER_PROTOCOL_REFUSAL_TITLE}), in `copy`: a live
 * launch's read off its error ({@link partnerProtocolRefusalCopy}), or the
 * record's ({@link RECORDED_PARTNER_PROTOCOL_REFUSAL_FAILURE}). */
function partnerProtocolRefusalFailure(copy: {
  title: string;
  problem: string;
  remedy: string;
}): ManagedRunFailure {
  return {
    kind: "partner-protocol-refusal",
    title: copy.title,
    message: partnerProtocolRefusalMessage("The last run", copy),
    recovery: "ask-partner",
  };
}

/** {@link partnerProtocolRefusalFailure} read back from the record. */
const RECORDED_PARTNER_PROTOCOL_REFUSAL_FAILURE = partnerProtocolRefusalFailure(
  {
    title: PARTNER_PROTOCOL_REFUSAL_TITLE,
    problem: PARTNER_PROTOCOL_REFUSAL_PROBLEM,
    remedy: RECORDED_PARTNER_PROTOCOL_REFUSAL_REMEDY,
  },
);

/** The state of a run that stopped before connecting because its relay's
 * registrar did not confirm the registration the record held as pending. The
 * error's own message names the registrar, its answer, and the next step: a
 * retry where the registrar did not answer, owner-token re-enrollment where it
 * refused. */
function relayRegistrationFailure(error: unknown): ManagedRunFailure {
  return {
    kind: "relay-registration",
    title: "The relay registrar did not confirm this exchange's relay key",
    message: sanitizeErrorForDisplay(error),
    recovery:
      error instanceof ManagedRelayRegistrationError &&
      error.outcome.kind === "unavailable"
        ? "retry"
        : "none",
  };
}

/** The Tier-1 recorded persist-failure state: the last run rotated the secret but
 * could not save it, which can leave the two parties on different secrets. Plain,
 * specific copy naming re-invite -- the record's own bookkeeping explains the
 * failure. This is the one-sided persist alone: the other local-storage refusal a
 * run can meet rotates nothing and is treated as {@link NOT_RUNNABLE_FAILURE}. */
const STORAGE_FAILURE: ManagedRunFailure = {
  kind: "storage",
  title: "The last run could not be saved",
  message:
    "The last run connected but could not save its updated secret on this " +
    "device, so you and your partner may now hold different secrets. Re-invite " +
    "your partner to reconnect; the exchange keeps your terms, gets a new " +
    "secret, and uses the coordination server the new invitation names.",
  recovery: "reinvite",
};

/** The Tier-1 interrupted-rotation state: a key exchange began and did not save
 * its rotated secret on this device, and a run since then did not meet the
 * partner -- the pattern a secret the partner saved and this device did not
 * produces, since the rendezvous derives from the secret. Plain copy naming
 * re-invite, with no attack checklist: it is read only beside a no-show, never
 * beside a handshake that failed closed. */
const PARTIAL_ROTATION_FAILURE: ManagedRunFailure = {
  kind: "partial-rotation",
  title: PARTIAL_ROTATION_FAILURE_TITLE,
  message:
    "A run stopped during its key exchange before it could save the updated " +
    "secret on this device, and a run since then did not connect to your " +
    "partner. " +
    "Your partner probably saved a secret this device does not have. " +
    "Re-invite your partner to reconnect; the exchange keeps your terms, gets " +
    "a new secret, and uses the coordination server the new invitation names.",
  recovery: "reinvite",
};

/** The Tier-1 restore/import state: this exchange was restored from a backup or
 * key file and has not successfully run since, so it may be one the partnership
 * has already moved past. Read beside a failed-closed handshake and beside a
 * no-show after the import. Plain, specific copy naming the newest copy and
 * re-invite -- no attack checklist. */
const IMPORTED_FAILURE: ManagedRunFailure = {
  kind: "imported",
  title: IMPORTED_FAILURE_TITLE,
  message:
    "This exchange was restored from a backup or key file, and no run has " +
    "succeeded since, so it may be one you and your partner have already " +
    `moved past. ${IMPORTED_FAILURE_REMEDY} to reconnect. After a re-invite, ` +
    "the exchange keeps your terms, gets a new secret, and uses the " +
    "coordination server the new invitation names.",
  recovery: "reinvite",
};

/** The state of a run refused because the signaling server address its record
 * saved fails the validation a fresh invitation's address gets
 * ({@link ManagedSignalingEndpointRefusedError}). Read off the error class with
 * no stored kind of its own, since a new stored kind would change the saved
 * record's schema: the record stamps it as a transport failure, so a later
 * visit reads the generic transport state. The same record refuses identically
 * every time, so it is not the retry state. Both sides recover by re-invite:
 * a fresh invitation from the partner saves a new address on the acceptor's
 * side, and an inviter's re-invite names this browser's current
 * coordination server and stores it on the record. */
function savedAddressRefusedFailure(
  error: ManagedSignalingEndpointRefusedError,
): ManagedRunFailure {
  return {
    kind: "saved-address-refused",
    title: "The saved coordination server address cannot be used",
    message:
      `${error.refusal} The run stopped before connecting, so your partner ` +
      "was not contacted and nothing left this device. Running it again " +
      "stops the same way; " +
      (error.side === "acceptor"
        ? "this exchange needs a fresh invitation."
        : "re-invite your partner to name this browser's current " +
          "coordination server. If relay settings cannot read your " +
          "coordination server, set it again or clear it there first."),
    recovery: "reinvite",
  };
}

/** The recorded transport state: a connection or data-exchange drop, not a
 * failed-closed handshake. Fixed, friendly copy, which accounts for nothing
 * about why this run stopped; the error itself reaches the operator escaped, in
 * the labelled block beneath that copy ({@link MANAGED_RUN_CAUSE_PLACEMENT}).
 * A temporary connection problem, retried in place. */
const TRANSPORT_FAILURE: ManagedRunFailure = {
  kind: "transport",
  title: "The run could not be completed",
  message:
    "This run could not be completed - usually a temporary connection problem " +
    "rather than an issue with your data. Try again; if it keeps failing, " +
    "re-invite your partner.",
  recovery: "retry",
};

/** A recorded `"missed"` outcome read as a launch failure: the transport copy, with
 * the import a copy run elsewhere needs ahead of its re-invite. */
const RECORDED_MISSED_FAILURE: ManagedRunFailure = {
  ...TRANSPORT_FAILURE,
  message:
    "This run could not be completed - usually a temporary connection problem " +
    `rather than an issue with your data. ${RAN_ELSEWHERE_IMPORT_REMEDY} ` +
    "Otherwise try again; if it keeps failing, re-invite your partner.",
};

/** The Tier-2 unexplained state: a handshake failed closed with no recorded benign
 * cause. This is the one failure that needs the operator's out-of-band confirmation
 * work, so the copy directs to the confirmation flow -- it names no benign cause and
 * invents no new security guidance. The forwardable message and the two-outcome gate
 * are composed in {@link ../psi/managedFailureConfirmation.ts}; this copy is the lead
 * the surface shows above them. */
const UNEXPLAINED_FAILURE: ManagedRunFailure = {
  kind: "unexplained",
  title: UNEXPLAINED_FAILURE_TITLE,
  message:
    "This run connected but could not verify your partner, and nothing on this " +
    "device explains why. This can be an ordinary problem on your partner's " +
    "side - or a sign someone is interfering. Do not just re-invite: confirm " +
    "with your partner on your usual trusted channel first, using the message " +
    "below.",
  recovery: "confirm",
};

/** The surface state for a derived failure tier. The expired tier reads
 * `record.expires` to name the lapsed instant; the shortfall tier reads the
 * stamp's own `singleColumnInput` to choose between the delimiter remedy and
 * the agreed-keys copy; the terms-change tier reads whether `local` holds a
 * terms proposal; the transport and none tiers map to the generic transport copy.
 *
 * The missed tier does not use the no-show copy: that copy attests nothing left
 * this device for THIS failure, while a recorded `"missed"` outcome belongs to
 * whichever run stamped it (the bookkeeping write is best-effort, see {@link
 * ../psi/managedRun.ts}). It takes the transport copy with the import remedy a
 * copy run elsewhere needs ({@link RECORDED_MISSED_FAILURE}). The list and
 * history surfaces (`savedExchangesModel`, `managedDetailModel`) phrase a
 * next-visit read of that outcome informationally.
 *
 * `"none"` and `"missed"` are handled explicitly even though {@link
 * managedRunFailureFromRecord} filters both before a record reaches this
 * function; {@link classifyManagedRunFailure} can still route either tier here.
 * @internal exported for the unit test. */
export function managedRunTierFailure(
  tier: ManagedFailureTier,
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
): ManagedRunFailure {
  switch (tier) {
    case "expired":
      // The expired tier only derives from a defined `expires` (the lapse check
      // requires it); an absent value here is a derivation bug, so this falls
      // back to the generic tier rather than fabricate an instant for the date
      // formatter.
      return record.expires !== undefined
        ? expiredFailure(record.expires)
        : TRANSPORT_FAILURE;
    case "input":
      return INPUT_FAILURE;
    case "terms-shortfall":
      return record.lastRun?.singleColumnInput === true
        ? SINGLE_COLUMN_SHORTFALL_FAILURE
        : TERMS_SHORTFALL_FAILURE;
    case "terms-change":
      return local?.termsProposal !== undefined
        ? TERMS_CHANGE_FAILURE
        : TERMS_CHANGE_DECLINED_FAILURE;
    case "partner-set-too-large":
      return RECORDED_PARTNER_SET_TOO_LARGE_FAILURE;
    case "partner-refused-set":
      return PARTNER_REFUSED_SET_FAILURE;
    case "partner-storage":
      return PARTNER_STORAGE_FAILURE;
    case "partner-refused-terms":
      return PARTNER_REFUSED_TERMS_FAILURE;
    case "partner-protocol-refusal":
      return RECORDED_PARTNER_PROTOCOL_REFUSAL_FAILURE;
    case "too-large":
      return recordedTooLargeFailure(record.lastRun ?? {});
    case "custody-unreadable":
      return RECORDED_CUSTODY_UNREADABLE_FAILURE;
    case "storage":
      return STORAGE_FAILURE;
    case "partial-rotation":
      return PARTIAL_ROTATION_FAILURE;
    case "imported":
      return IMPORTED_FAILURE;
    case "unexplained":
      return UNEXPLAINED_FAILURE;
    case "missed":
      return RECORDED_MISSED_FAILURE;
    case "transport":
    case "none":
      return TRANSPORT_FAILURE;
  }
}

/** The tiers whose framing outranks the benign no-show reading: Tier-1 desync
 * signals the record already holds as the run launches, each recovered by
 * re-invite (see docs/MANAGED_EXCHANGE.md, "A missed window is neither desync
 * nor attack"). The Tier-2 unexplained framing is not here: no handshake ran,
 * so nothing failed closed.
 *
 * Hand-maintained, and unlike {@link MANAGED_RUN_NON_DISCLOSURE_ATTESTATION} not
 * bound to any tier's copy: this list rests on a ranking claim about which
 * framing outranks the no-show reading, and no tier's copy states that claim, so
 * there is no phrase for a check to hold it to. */
const MISSED_OUTRANKED_BY: ReadonlyArray<ManagedFailureTier> = [
  "expired",
  "storage",
  "partner-storage",
  "partial-rotation",
  "imported",
];

/** The no-show state, read against the desync evidence the record holds
 * ({@link MISSED_OUTRANKED_BY}) as of the launch
 * ({@link ManagedRunRecordReadings.atLaunch}) -- the reading this run's own
 * `"missed"` stamp cannot have erased, since that stamp replaces `lastRun` and
 * has no `failureKind`.
 *
 * The import marker is read directly as well as through the derived tier,
 * because the derivation reads it beside a `"missed"` outcome only where that
 * no-show came after the import: a record whose last run is a no-show the
 * imported file brought in tiers as `"missed"` while still holding a standing
 * restore, and this run's no-show is after the import. The tier is checked first since it
 * also includes the lapse check and the recorded persist failure, which the
 * marker alone does not.
 *
 * A rotation-in-flight marker on the launch record is read the same way: this
 * run found a key exchange that never saved its rotation, and met no partner.
 * It is read only while no standing condition is raised and no outcome since
 * supersedes it ({@link rotationInFlightUnansweredAtLaunch}), so a failed-closed
 * handshake keeps its confirm-first reading. */
function missedFailure(
  atLaunch: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
): ManagedRunFailure {
  const tier = deriveManagedFailureTier(atLaunch, local, now);
  if (MISSED_OUTRANKED_BY.includes(tier))
    return managedRunTierFailure(tier, atLaunch, local);
  if (importedSinceLastSuccess(local)) return IMPORTED_FAILURE;
  if (rotationInFlightUnansweredAtLaunch(atLaunch))
    return PARTIAL_ROTATION_FAILURE;
  return MISSED_FAILURE;
}

/** Where a tier's non-disclosure attestation -- the claim that THIS run stopped
 * before reading the input file and before connecting, so nothing left this
 * device -- is written for the operator to read.
 *
 * - `"alert-copy"` -- in the tier's own {@link ManagedRunFailure} title and
 *   message.
 * - `"none"` -- the tier states nothing about what this run disclosed. */
type NonDisclosureAttestationSite = "alert-copy" | "none";

/** Where each record-derived tier attests THIS run's non-disclosure, and so which
 * tiers give way to the generic tier once this run's data exchange has started
 * ({@link classifyManagedRunFailure}'s `dataExchangeStarted` boundary): a tier
 * attesting anywhere is gated, a `"none"` tier keeps its reading.
 *
 * Exhaustive over {@link ManagedFailureTier} rather than a list of the gated
 * tiers alone: a tier added to the union does not typecheck until it is
 * classified here, so copy attesting non-disclosure cannot arrive ungated. The
 * unit test holds every entry to the tier's rendered copy.
 *
 * `"missed"` is `"none"` because the recorded tier renders the generic transport
 * copy; the no-show copy that does attest is issued from the live error instead
 * ({@link missedFailure}). The re-invite, input, and unexplained tiers state
 * nothing about this run's disclosure.
 * @internal exported for the unit test. */
export const MANAGED_RUN_NON_DISCLOSURE_ATTESTATION: Readonly<
  Record<ManagedFailureTier, NonDisclosureAttestationSite>
> = {
  "custody-unreadable": "alert-copy",
  "terms-shortfall": "alert-copy",
  "too-large": "none",
  "terms-change": "none",
  "partner-set-too-large": "none",
  "partner-refused-set": "none",
  "partner-storage": "none",
  "partner-refused-terms": "alert-copy",
  "partner-protocol-refusal": "none",
  expired: "none",
  input: "none",
  missed: "none",
  storage: "none",
  "partial-rotation": "none",
  imported: "none",
  transport: "none",
  unexplained: "none",
  none: "none",
};

/** Whether a derived tier attests THIS run's non-disclosure, and so gives way to
 * the generic tier past the data-exchange boundary. */
function attestsNonDisclosure(tier: ManagedFailureTier): boolean {
  return MANAGED_RUN_NON_DISCLOSURE_ATTESTATION[tier] !== "none";
}

/**
 * Where a classified state's launch error reaches the operator.
 *
 * - `"attributed"` -- in the labelled block the seats render it through
 *   (`FailureBody` in `../exchange/RunSurface.tsx`), which stands it UNDER the
 *   label naming the exchange as its source. Where words a partner or a network
 *   stack wrote belong, so they cannot read as this application's own account
 *   of the failure.
 * - `"withheld"` -- nowhere.
 */
export type ManagedRunCausePlacement = "attributed" | "withheld";

/**
 * Where each classified state's launch error reaches the operator. Exhaustive
 * by the kind union, so a state added to the model does not typecheck until its
 * placement is decided here.
 *
 * The transport state shows the error because its copy accounts for nothing
 * about why the run stopped: it states a connection problem and no more
 * ({@link TRANSPORT_FAILURE}), and its error is the partner- or network-written
 * text the label exists to attribute. Every other state's copy states the cause
 * itself, fixed and non-oracular by the decision each constant above records,
 * and the unexplained state withholds for the reason the seats withhold a
 * failed-closed handshake's message (docs/notes/reported-failure-cause.md). The
 * unreadable-custody state's error is a record id or a schema issue list,
 * internal names the operator cannot act on. The too-large state's live copy is
 * the refusal's own message ({@link tooLargeFailure}), so a second block would
 * repeat it, and so is the relay-registration state's
 * ({@link relayRegistrationFailure}), and the partner-set-too-large state's
 * ({@link partnerSetTooLargeFailure}). The partner-refused-terms state shows
 * the error as the one-shot exchange's terms alert does: the copy states the
 * refusal, and the error states the terms that differ or the reason the partner
 * gave, which no copy names. The partner-protocol-refusal state shows it as the
 * one-shot exchange's alert does too: the error names what in the partner's
 * data was refused, for the partner to act on.
 */
const MANAGED_RUN_CAUSE_PLACEMENT: Record<
  ManagedRunFailure["kind"],
  ManagedRunCausePlacement
> = {
  transport: "attributed",
  "partner-refused-terms": "attributed",
  "partner-protocol-refusal": "attributed",
  "custody-unreadable": "withheld",
  expired: "withheld",
  input: "withheld",
  "terms-shortfall": "withheld",
  "too-large": "withheld",
  "relay-registration": "withheld",
  "saved-address-refused": "withheld",
  "partner-set-too-large": "withheld",
  "partner-refused-set": "withheld",
  "partner-storage": "withheld",
  "terms-change": "withheld",
  "already-running": "withheld",
  stopped: "withheld",
  missed: "withheld",
  storage: "withheld",
  "partial-rotation": "withheld",
  imported: "withheld",
  unexplained: "withheld",
};

/**
 * Where a classified state of this kind shows the launch error, if it shows
 * it at all: a lookup in {@link MANAGED_RUN_CAUSE_PLACEMENT}.
 *
 * @internal exported for the unit test.
 */
export function managedRunCausePlacement(
  kind: ManagedRunFailure["kind"],
): ManagedRunCausePlacement {
  return MANAGED_RUN_CAUSE_PLACEMENT[kind];
}

/**
 * A classified state with `error` shown where `placement` puts it. The decision
 * is passed in rather than read here so it stays at the single site above and
 * this stays the mechanism: the escape at the display boundary, and the empty
 * cause that gets no block promising an account the state has none of. A
 * rejection that is not an `Error` has no chain to show.
 *
 * @internal exported for the unit test.
 */
export function withShownCause(
  failure: ManagedRunFailure,
  error: unknown,
  placement: ManagedRunCausePlacement,
): ManagedRunFailure {
  const cause: string =
    placement === "attributed" && error instanceof Error
      ? sanitizeErrorForDisplay(error)
      : "";
  if (cause.trim() === "") return failure;
  return { ...failure, reportedCause: cause };
}

/**
 * Classify a launch failure into the surface's {@link ManagedRunFailure}. The
 * benign states are read through {@link benignRerunOutcome}, each with its own
 * plain copy -- the expiry state names the lapsed instant the error has, the
 * one non-fixed value, and it is the record's own local `expires`, never
 * partner-influenced. Any other failure is tiered from the record's own
 * bookkeeping: {@link deriveManagedFailureTier} reads the tier and {@link
 * managedRunTierFailure} maps it to copy. `now` and `local` feed that
 * derivation (expiry and the import marker).
 *
 * A derived tier reads the record reloaded after the run (`records.afterRun`),
 * since it rests on what THIS run stamped. The no-show rests on what stood
 * BEFORE it -- a no-show's `"missed"` stamp replaces `lastRun` and has no
 * `failureKind` -- so it reads `records.atLaunch` instead ({@link
 * missedFailure}).
 *
 * `dataExchangeStarted` is THIS run's phase boundary (the run's own
 * `onDataExchangeStart` option, passed to {@link benignRerunOutcome}): a benign
 * state whose copy claims nothing left this device is read off the error only
 * from before it, except the partner's terms refusal, whose error is marked
 * only at the terms exchange; a derived tier making the same claim is gated by
 * it too ({@link MANAGED_RUN_NON_DISCLOSURE_ATTESTATION}).
 *
 * Whatever state it lands on, the launch error reaches the operator only
 * through {@link managedRunCausePlacement}. The transport state of a connection
 * that did not open with this site's relay switched off
 * (`failedWithDefaultRelayOff`) adds {@link DEFAULT_RELAY_OFF_REMEDY} to its
 * own copy.
 */
export function classifyManagedRunFailure(
  error: unknown,
  records: ManagedRunRecordReadings,
  local: ManagedLocalState | undefined,
  now: number,
  dataExchangeStarted: boolean,
): ManagedRunFailure {
  const state = classifyLaunchState(
    error,
    records,
    local,
    now,
    dataExchangeStarted,
  );
  const shown = withShownCause(
    state,
    error,
    managedRunCausePlacement(state.kind),
  );
  return state.kind === "transport" && failedWithDefaultRelayOff(error)
    ? { ...shown, message: `${shown.message} ${DEFAULT_RELAY_OFF_REMEDY}` }
    : shown;
}

/** The state a launch failure lands on, before the launch error is offered to
 * it ({@link classifyManagedRunFailure}, which is the whole of this function's
 * reach). */
function classifyLaunchState(
  error: unknown,
  records: ManagedRunRecordReadings,
  local: ManagedLocalState | undefined,
  now: number,
  dataExchangeStarted: boolean,
): ManagedRunFailure {
  const benign = benignRerunOutcome(error, dataExchangeStarted);
  if (benign === "expired" && error instanceof ManagedExchangeExpiredError)
    return expiredFailure(error.expires);
  if (benign === "already-running") return ALREADY_RUNNING_FAILURE;
  if (benign === "stopped") return STOPPED_FAILURE;
  if (benign === "custody-unreadable") return NOT_RUNNABLE_FAILURE;
  if (benign === "input") return inputFailure(error);
  if (benign === "terms-shortfall") return shortfallFailure(error);
  if (benign === "missed") return missedFailure(records.atLaunch, local, now);
  if (benign === "too-large") return tooLargeFailure(error);
  if (benign === "partner-set-too-large")
    return partnerSetTooLargeFailure(error);
  if (benign === "partner-refused-set") return PARTNER_REFUSED_SET_FAILURE;
  if (benign === "partner-storage") return PARTNER_STORAGE_FAILURE;
  if (benign === "partner-refused-terms") return PARTNER_REFUSED_TERMS_FAILURE;
  if (benign === "partner-protocol-refusal")
    return partnerProtocolRefusalFailure(partnerProtocolRefusalCopy(error));
  if (benign === "relay-registration") return relayRegistrationFailure(error);
  if (
    error instanceof ManagedSignalingEndpointRefusedError &&
    !dataExchangeStarted
  )
    return savedAddressRefusedFailure(error);
  const { afterRun } = records;
  const tier = deriveManagedFailureTier(afterRun, local, now);
  return managedRunTierFailure(
    dataExchangeStarted && attestsNonDisclosure(tier) ? "transport" : tier,
    afterRun,
    local,
  );
}

/**
 * The surface state for a stored record read at the next visit (no live launch),
 * derived purely from the record's bookkeeping and its local sibling state, so an
 * unattended run's failure is classified through the same tiers. Returns
 * `undefined` when the record holds no failure to show: never run, last run
 * succeeded, or a missed window (the list shows that informationally rather than
 * as a launch failure).
 */
export function managedRunFailureFromRecord(
  record: ManagedExchangeRecord,
  local: ManagedLocalState | undefined,
  now: number,
): ManagedRunFailure | undefined {
  const tier = deriveManagedFailureTier(record, local, now);
  if (tier === "none" || tier === "missed") return undefined;
  return managedRunTierFailure(tier, record, local);
}

/** Whether a classified failure is retryable in place: the input and transport
 * states put the file back or retry the connection; every other state's own
 * recovery is documented on its constant above. */
export function managedRunRetryable(failure: ManagedRunFailure): boolean {
  return failure.recovery === "retry";
}

/** Whether a classified failure's recovery is fast re-invite directly, so the surface
 * offers the re-invite affordance. The unexplained state reaches re-invite only through
 * the confirmation gate (`recovery === "confirm"`), so it is NOT a direct re-invite
 * state here. */
export function managedRunReinvites(failure: ManagedRunFailure): boolean {
  return failure.recovery === "reinvite";
}

/** The re-invite recovery callout's copy: a lead line and the paragraphs below it,
 * in order. */
interface ManagedReinviteRecoveryCopy {
  /** The callout's lead line. */
  lead: string;
  /** The paragraphs below the lead, in order. */
  body: Array<string>;
}

/** The inviter's recovery: it re-mints from its own stored document, so the copy is
 * about the fresh invitation it is about to send. Re-minting rotates the record in
 * place, leaving one record for the partnership, so there is no cleanup step. */
const INVITER_REINVITE_RECOVERY: ManagedReinviteRecoveryCopy = {
  lead: "Re-invite your partner.",
  body: [
    "This keeps your agreed terms and replaces the secret. The fresh " +
      "invitation names the coordination server set in relay settings, or " +
      "this site's where none is set, or the one this exchange already " +
      "uses where relay settings cannot read yours, and this exchange " +
      "uses that server " +
      "from then on. The fresh invitation includes a new one-time secret, " +
      "so send it over your usual trusted channel, exactly as you did the " +
      "first time.",
  ],
};

/** The acceptor's recovery: it cannot mint an inviter-namespace invitation from its
 * mirrored document, so it asks the partner for a fresh one -- and that accept saves
 * a second recurring exchange beside this one, which the operator deletes. */
const ACCEPTOR_REINVITE_RECOVERY: ManagedReinviteRecoveryCopy = {
  lead: "Ask your partner to re-invite.",
  body: [
    "Ask your partner to send you a fresh invitation for this exchange over " +
      "your usual trusted channel, then open its link to accept it. That " +
      "re-establishes the connection with a new secret; your terms are " +
      "unchanged.",
    "Saving the accepted invitation as a recurring exchange adds a second one " +
      "rather than updating this one, and nothing here reconciles the two. " +
      "Once you have saved it, remove this superseded exchange with the " +
      "Remove button below, or the one beside it in your recurring exchanges " +
      "list. Left in place, it still offers a run that fails, because its " +
      "secret is the one the fresh invitation replaces.",
  ],
};

/**
 * The re-invite recovery copy for a record, chosen from the record's OWN `side`
 * through {@link canReinviteFromRecord} -- never an ambient flag, so a surface
 * holding a record cannot show the other side's recovery.
 *
 * The acceptor's copy has a cleanup step the inviter's does not need: an accept
 * deposits a NEW managed record beside the superseded one, which still offers a
 * run that fails closed as the unexplained tier (see docs/MANAGED_EXCHANGE.md,
 * "Recovery: fast re-invite").
 */
export function managedReinviteRecoveryCopy(
  record: ManagedExchangeRecord,
): ManagedReinviteRecoveryCopy {
  return canReinviteFromRecord(record)
    ? INVITER_REINVITE_RECOVERY
    : ACCEPTOR_REINVITE_RECOVERY;
}
