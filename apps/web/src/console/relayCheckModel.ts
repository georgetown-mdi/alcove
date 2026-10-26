import { RELAY_CHECK_BOUND_MS } from "@alcove/core";

import type {
  RelayCheckLine,
  RelayCheckStatus,
  RelayCheckUnavailableReason,
} from "@jobContract/relayCheckResponses";
import type {
  RelayCheckOffer,
  RelayCheckOutcome,
} from "@psi/jobClient/relayCheckClient";

/** The control that shows the hosts a check contacts, before any is contacted. */
export const RELAY_CHECK_OPEN_LABEL = "Check the relay";

/** The control that starts the check. */
export const RELAY_CHECK_START_LABEL = "Start the check";

/** The control that closes the hosts without a check. */
export const RELAY_CHECK_CANCEL_LABEL = "Cancel";

/** The control that shows the hosts again after a check. */
export const RELAY_CHECK_AGAIN_LABEL = "Check again";

/** What the check does, beside the control that opens it. */
export const RELAY_CHECK_INTRO =
  "This console can ask the relay a run uses for a relay address, from " +
  "this container and with the files in your working folder, as a run " +
  "does. Nothing is contacted until you start the check.";

/** What the check leaves untested where a run lists a WebSocket relay. */
export const WEBSOCKET_RELAY_NOT_CHECKED =
  "The check does not test the WebSocket relay this configuration names.";

/** Where the check is running. */
export const RELAY_CHECK_RUNNING =
  "Checking the relay. A relay that does not answer is reported after " +
  `${RELAY_CHECK_BOUND_MS / 1000} seconds.`;

/** The operator's way to see what the console could not show. */
const RUN_IT_YOURSELF =
  "Run alcove doctor relay in your working folder to see why.";

const UNAVAILABLE_TEXT: Record<RelayCheckUnavailableReason, string> = {
  "no-configuration":
    "Your working folder holds no alcove.yaml, so there is no relay to check.",
  "configuration-refused":
    "The alcove.yaml in your working folder could not be read. Check the " +
    "file, then try again.",
  "not-webrtc":
    "The alcove.yaml in your working folder is not a WebRTC exchange, so " +
    "there is no relay to check.",
  "ice-provision":
    "The alcove.yaml in your working folder sets connection.ice_provision, " +
    "which the check does not test.",
  "no-turn-url":
    "The alcove.yaml in your working folder lists no TURN server, so there " +
    "is no relay to check.",
  "turn-urls-left-out":
    "connection.allowed_relays leaves out every TURN server the alcove.yaml " +
    "in your working folder lists, so a run contacts no relay and there is " +
    "none to check.",
  "key-file":
    "Your working folder holds no usable .alcove.key beside alcove.yaml, " +
    "and the check needs it to present the credential a run presents.",
};

/** Where reading the working folder's files for the check failed. */
export const RELAY_CHECK_UNREADABLE =
  "The console could not read the files in your working folder for the " +
  "check. Try again.";

/**
 * Whether the panel states why there is nothing to check, rather than
 * showing nothing: where the files name a relay the operator may expect
 * checked, or cannot be read. A configuration with no relay at all is not
 * offered the check.
 */
export function relayCheckShowsUnavailable(offer: {
  reason: RelayCheckUnavailableReason;
  websocketRelayNotChecked: boolean;
}): boolean {
  switch (offer.reason) {
    case "key-file":
    case "configuration-refused":
    case "turn-urls-left-out":
      return true;
    case "no-turn-url":
      return offer.websocketRelayNotChecked;
    case "no-configuration":
    case "not-webrtc":
    case "ice-provision":
      return false;
  }
}

/** Why there is nothing to check. */
export function relayCheckUnavailableText(
  reason: RelayCheckUnavailableReason,
): string {
  return UNAVAILABLE_TEXT[reason];
}

/** The line that heads a verdict. */
export function relayCheckVerdictSummary(
  overall: "ok" | "fix_and_retry",
): string {
  return overall === "ok"
    ? "The relay a run uses gave this console a relay address."
    : "The relay a run uses did not give this console a relay address. " +
        "Follow the steps below, then check again.";
}

/** What a started check that gave no verdict came to. */
export function relayCheckOutcomeText(
  outcome: Exclude<RelayCheckOutcome, { kind: "verdict" }>,
): string {
  switch (outcome.kind) {
    case "unavailable":
      return relayCheckUnavailableText(outcome.reason);
    case "refused":
      return `The command-line tool refused this configuration and contacted nothing. ${RUN_IT_YOURSELF}`;
    case "timeout":
      return (
        "The check did not finish in time, so the console stopped it. " +
        "Check again; if it stops again, run alcove doctor relay in your " +
        "working folder."
      );
    case "configuration-changed":
      return (
        "The alcove.yaml in your working folder changed after its hosts " +
        "were shown, so nothing was contacted. Review the hosts, then " +
        "start the check again."
      );
    case "busy":
      return "Another relay check is running on this console. Start this one once it finishes.";
    case "exchange-running":
      return "An exchange is running over these files. Start the check once it has finished.";
    case "error":
      return `The check ended without a result. ${RUN_IT_YOURSELF}`;
  }
}

const STATUS_LABEL: Record<RelayCheckStatus, string> = {
  ok: "OK",
  warn: "Warning",
  fail: "Failed",
  skipped: "Not contacted",
};

/** The label a check's headline is shown with. */
export function relayCheckStatusLabel(status: RelayCheckStatus): string {
  return STATUS_LABEL[status];
}

/**
 * The checks as shown: a run of skipped checks with the same meaning shows
 * it once, under the last of them, and an action they also share likewise,
 * as the CLI prints them.
 */
export function relayCheckLinesShown(
  checks: ReadonlyArray<RelayCheckLine>,
): Array<RelayCheckLine> {
  return checks.map((check, index) => {
    const next = checks.at(index + 1);
    const sharesMeaning =
      next !== undefined &&
      check.status === "skipped" &&
      next.status === "skipped" &&
      check.meaning === next.meaning;
    const sharesAction = sharesMeaning && check.action === next.action;
    return {
      id: check.id,
      status: check.status,
      headline: check.headline,
      ...(!sharesMeaning &&
        check.meaning !== undefined && { meaning: check.meaning }),
      ...(!sharesAction &&
        check.action !== undefined && { action: check.action }),
    };
  });
}

type AvailableOffer = Extract<RelayCheckOffer, { kind: "available" }>;
type UnavailableOffer = Extract<RelayCheckOffer, { kind: "unavailable" }>;

/** Where the relay-check panel stands. */
export type RelayCheckPanelState =
  | { step: "reading" }
  | { step: "hidden" }
  | { step: "closed"; unreadable: boolean }
  | { step: "opening" }
  | { step: "unavailable"; offer: UnavailableOffer }
  | { step: "hosts"; offer: AvailableOffer }
  | { step: "checking"; offer: AvailableOffer }
  | { step: "done"; outcome: RelayCheckOutcome; websocketNote: boolean };

/**
 * Where the panel stands once an offer is read: `opened` where the operator
 * asked for the check, so a reason the panel otherwise hides is stated.
 */
export function relayCheckPanelState(
  offer: RelayCheckOffer,
  opened: boolean,
): RelayCheckPanelState {
  if (offer.kind === "error") return { step: "closed", unreadable: opened };
  if (offer.kind === "unavailable")
    return opened || relayCheckShowsUnavailable(offer)
      ? { step: "unavailable", offer }
      : { step: "hidden" };
  return opened
    ? { step: "hosts", offer }
    : { step: "closed", unreadable: false };
}

/** Whether a check's outcome is followed by the WebSocket-relay note. */
export function relayCheckShowsWebsocketNote(
  outcome: RelayCheckOutcome,
  offer: { websocketRelayNotChecked: boolean },
): boolean {
  return outcome.kind === "verdict" && offer.websocketRelayNotChecked;
}
