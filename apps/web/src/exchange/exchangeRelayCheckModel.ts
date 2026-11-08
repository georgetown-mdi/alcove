import {
  REGISTRAR_DISCLOSURE,
  RELAY_CHECK_BOUND_MS,
  RELAY_DISCLOSURE,
  RELAY_NOT_REACHED_REMEDY,
  TURN_RELAY_CREDENTIAL_REFUSED_MEANING,
  TURN_RELAY_NO_RELAYED_PATH_MEANING,
  WEBSOCKET_RELAY_NO_RELAYED_PATH_MEANING,
  WEBSOCKET_RELAY_UNEXPECTED_MESSAGE_WORDS,
  sanitizeForDisplay,
  webSocketRelayRefusalClause,
  webSocketRelayRefusalWords,
} from "@alcove/core";

import { defaultRelayNotEnrolledNotice } from "@psi/transport/defaultRelayRefusal";

import type { Displayable } from "@alcove/core";
import type { ExchangeRelayCheckLine } from "@psi/transport/exchangeRelayCheck";
import type { RelayUrls } from "@psi/transport/ownRelaySetting";
import type { RunRelayHosts } from "@psi/transport/runRelayPlan";

/** What the check does, beside the control that shows its hosts. */
export const EXCHANGE_RELAY_CHECK_INTRO =
  "Check whether each relay this exchange lists carries its traffic, " +
  "under this exchange's own credential. Nothing is contacted until you " +
  "start the check.";

/** What the check of a saved exchange checks. */
export const SAVED_EXCHANGE_RELAY_CHECK_SCOPE =
  "The check uses the connection settings as last saved.";

/** Where the check is running. */
export const EXCHANGE_RELAY_CHECK_RUNNING =
  "Checking the relays. A relay that does not answer is reported after " +
  `${RELAY_CHECK_BOUND_MS / 1000} seconds.`;

/** Where the check ended with no result. */
export const EXCHANGE_RELAY_CHECK_ERROR =
  "The check ended without a result. Check again.";

/** One host of the statement, its url escaped and bounded for display. */
export interface ExchangeRelayCheckHost {
  host: Displayable;
  explanation: Array<string>;
}

/** The hosts the check contacts and those it does not, before it starts. */
export interface ExchangeRelayCheckStatement {
  contactedHeading: string;
  contacted: Array<ExchangeRelayCheckHost>;
  notContacted?: { heading: string; hosts: Array<ExchangeRelayCheckHost> };
  closing: string;
}

const LISTED_ONCE_ENROLLED =
  "A run lists it only once the enrollment above confirms, and so does " +
  "the check.";

/**
 * The statement the check makes before any contact, for the hosts a run of
 * the exchange may contact. Every url and the registrar are escaped and
 * bounded for display, since an invitation's relay is the partner's text.
 */
export function exchangeRelayCheckStatement(
  hosts: RunRelayHosts,
): ExchangeRelayCheckStatement {
  const onceEnrolled = (url: string): Array<string> =>
    hosts.listedOnceEnrolled.includes(url) ? [LISTED_ONCE_ENROLLED] : [];
  const contacted: Array<ExchangeRelayCheckHost> = [
    ...(hosts.registrar !== undefined
      ? [
          {
            host: sanitizeForDisplay(hosts.registrar),
            explanation: [
              "The registrar of this site's relay server. Before it asks " +
                "the relays, the check enrolls this exchange's relay key " +
                "there, as a run does just before it connects.",
              REGISTRAR_DISCLOSURE,
            ],
          },
        ]
      : []),
    ...hosts.turn.map((url) => ({
      host: sanitizeForDisplay(url),
      explanation: [
        "A TURN relay a run lists. The check opens two connections through " +
          "it, each presenting the credential a run presents there, and " +
          "passes one message between them.",
        ...onceEnrolled(url),
        RELAY_DISCLOSURE,
      ],
    })),
    ...hosts.websocket.map((url) => ({
      host: sanitizeForDisplay(url),
      explanation: [
        "A WebSocket relay a run dials. The check opens two connections to " +
          "it, one in each role, presents on each the proof a run presents " +
          "there, and passes one message between them once the relay pairs " +
          "them.",
        ...onceEnrolled(url),
        RELAY_DISCLOSURE,
      ],
    })),
  ];
  return {
    contactedHeading:
      "This check contacts these hosts, as a run of this exchange does:",
    contacted,
    ...(hosts.leftOut.length > 0 && {
      notContacted: {
        heading:
          "It does not contact these hosts, because this exchange's " +
          "Allowed relays leave them out:",
        hosts: hosts.leftOut.map((url) => ({
          host: sanitizeForDisplay(url),
          explanation: [],
        })),
      },
    }),
    closing:
      "It contacts nothing else: not the coordination server, and no STUN " +
      "server.",
  };
}

/** Whether the check is offered: a run of the exchange lists a relay. */
export function exchangeRelayCheckOffered(hosts: RunRelayHosts): boolean {
  return hosts.turn.length + hosts.websocket.length > 0;
}

/** Why a relay does not work, where the check could observe it. */
export type ExchangeRelayCheckCause =
  "not_reached" | "credential_refused" | "not_enrolled" | "no_relayed_path";

/** One relay's line as shown: its url escaped and bounded, then its words. */
export interface ExchangeRelayCheckLineShown {
  url: Displayable;
  works: boolean;
  cause?: ExchangeRelayCheckCause;
  /** What the check found, after the url. */
  summary: string;
  meaning?: string;
  action?: string;
}

/** What a line's words are read against: the exchange's relays. */
export interface ExchangeRelayCheckContext {
  hosts: RunRelayHosts;
  invitationRelay?: RelayUrls;
  /** The page shows Relay registration, which enrolls the exchange at the
   * user's own relay. */
  relayRegistrationOffered?: boolean;
  /** Each run registers its new relay key where Relay registration enrolls
   * it, so an enrollment there keeps holding at a WebSocket relay of the
   * user's own. */
  relayRegistrationRenewedByRuns?: boolean;
}

const BOUND_SECONDS = `${RELAY_CHECK_BOUND_MS / 1000} s`;

function capitalized(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

// Whose relay `url` is, by where the run takes it from.
function relayOwner(
  url: string,
  context: ExchangeRelayCheckContext,
): "site" | "partner" | "own" {
  if (context.hosts.listedOnceEnrolled.includes(url)) return "site";
  const invited = context.invitationRelay;
  if (invited?.websocket === url || (invited?.turn ?? []).includes(url))
    return "partner";
  return "own";
}

const RELAY_NEEDS_ENROLLMENT = "this relay needs this exchange enrolled first.";

const CHECK_AGAIN_LATER = "Check again later.";

// The web's own not-reached words; the CLI keeps core's.
const TURN_RELAY_NOT_REACHED_MEANING =
  "nothing on this computer reached this relay, the relay refused the " +
  "credential, or it presented a certificate this computer does not trust; " +
  "the reason is not reported, so the check cannot tell which.";
const WEBSOCKET_RELAY_NOT_REACHED_MEANING =
  "nothing on this computer reached this url as an Alcove WebSocket relay: " +
  "the network blocked it, nothing answered at that address and path, or " +
  "the connection closed before the relay answered.";
const WEBSOCKET_RELAY_NOT_REACHED_ACTION =
  "Check that this computer can reach the relay and that the url names its " +
  "address and path, then check again.";

// The refusals of a relay holding no key (4003) or another key (4004).
const WEBSOCKET_RELAY_KEY_REFUSALS: ReadonlyMap<
  number,
  { summary: string; meaning: string }
> = new Map([
  [
    4003,
    {
      summary: "the relay holds no key for this exchange.",
      meaning: "the relay refuses this exchange until it is enrolled there.",
    },
  ],
  [
    4004,
    {
      summary: "the relay holds a different key for this exchange.",
      meaning:
        "the relay refuses this exchange until it holds the current key.",
    },
  ],
]);

// Why the TURN relay at `url` refuses a credential it has no key for.
function turnRefusalReason(
  url: string,
  context: ExchangeRelayCheckContext,
): string {
  return relayOwner(url, context) === "own"
    ? "The relay may need this exchange enrolled first."
    : capitalized(RELAY_NEEDS_ENROLLMENT);
}

// What a web user does about a relay that holds no key, or another key, for
// this exchange. A web run enrolls only at this site's relay server, and the
// check has already enrolled there. Relay registration keeps a key current
// at an own WebSocket relay only where each run registers its new key.
function enrollmentAction(
  url: string,
  relay: "turn" | "websocket",
  context: ExchangeRelayCheckContext,
  replaceKey: boolean,
): string {
  switch (relayOwner(url, context)) {
    case "site":
      return "Check again.";
    case "partner":
      return replaceKey
        ? "Ask your partner to enroll this exchange at their relay again, " +
            "replacing the key it holds."
        : "Ask your partner to enroll this exchange at their relay.";
    case "own":
      if (
        context.relayRegistrationOffered === true &&
        (relay === "turn" || context.relayRegistrationRenewedByRuns === true)
      )
        return replaceKey
          ? "Under Relay registration below, enter the relay-owner token, " +
              "tick Replace the key the registrar holds for this exchange " +
              "id, and select Enroll."
          : "Enroll this exchange under Relay registration below.";
      return context.hosts.defaultRelayOff === true
        ? "Remove this relay from Connection settings, or turn on this " +
            "site's relay server there."
        : "Remove this relay from Connection settings.";
  }
}

// Whether a run enrolls `url` at the registrar the invitation names: the run
// enrolls the default relay's urls at its registrar, and that registrar is
// the invitation's only where the invitation names it.
function enrollsAtInvitationRegistrar(
  url: string,
  context: ExchangeRelayCheckContext,
): boolean {
  const { registrar, listedOnceEnrolled } = context.hosts;
  return (
    registrar !== undefined &&
    listedOnceEnrolled.includes(url) &&
    context.invitationRelay?.registrar === registrar
  );
}

function doesNotWork(
  url: string,
  cause: ExchangeRelayCheckCause,
  summary: string,
  meaning: string,
  action: string,
): ExchangeRelayCheckLineShown {
  return {
    url: sanitizeForDisplay(url),
    works: false,
    cause,
    summary,
    meaning,
    action,
  };
}

/**
 * A line as shown, in the words `alcove doctor relay` and the console use for
 * the same cause (`@alcove/core`'s relay check words), except the web's own:
 * for a default relay that did not enroll the exchange, a request that threw
 * or a credential not made, a relay that holds no key or another key for it,
 * and where core's words name the CLI's terms.
 */
export function exchangeRelayCheckLineShown(
  line: ExchangeRelayCheckLine,
  context: ExchangeRelayCheckContext,
): ExchangeRelayCheckLineShown {
  const { url } = line;
  if ("notEnrolled" in line)
    return doesNotWork(
      url,
      "not_enrolled",
      "this site's relay server did not enroll this exchange's relay key, " +
        "so a run does not use this relay.",
      RELAY_NEEDS_ENROLLMENT,
      defaultRelayNotEnrolledNotice(line.notEnrolled),
    );
  if (line.relay === "turn")
    switch (line.result) {
      case "works":
        return {
          url: sanitizeForDisplay(url),
          works: true,
          summary:
            "a message passed through this relay between two " +
            "connections under this exchange's credential.",
        };
      case "not_reached":
        return doesNotWork(
          url,
          "not_reached",
          `no relayed connection was made within ${BOUND_SECONDS}.`,
          TURN_RELAY_NOT_REACHED_MEANING,
          RELAY_NOT_REACHED_REMEDY,
        );
      case "credential_refused":
        return doesNotWork(
          url,
          "credential_refused",
          "the relay refused this exchange's credential.",
          `${TURN_RELAY_CREDENTIAL_REFUSED_MEANING} ${turnRefusalReason(url, context)}`,
          relayOwner(url, context) === "site"
            ? CHECK_AGAIN_LATER
            : enrollmentAction(url, "turn", context, false),
        );
      case "no_relayed_path":
        return doesNotWork(
          url,
          "no_relayed_path",
          "no message passed through the relay.",
          TURN_RELAY_NO_RELAYED_PATH_MEANING,
          RELAY_NOT_REACHED_REMEDY,
        );
      case "not_started":
        return notStarted(url, context);
      case "credential_not_made":
        return {
          url: sanitizeForDisplay(url),
          works: false,
          cause: "not_reached",
          summary:
            "this browser could not make this exchange's relay credential.",
          action: "Reload this page, then check again.",
        };
    }
  const result = line.result;
  switch (result.kind) {
    case "works":
      return {
        url: sanitizeForDisplay(url),
        works: true,
        summary:
          "a message passed through this relay between two " +
          "connections under this exchange's proof.",
      };
    case "admitted":
      return {
        url: sanitizeForDisplay(url),
        works: true,
        summary:
          "admitted; the relay accepted this exchange's proof. " +
          "Another party of this exchange was waiting there, so the check " +
          "sent no message.",
      };
    case "refused": {
      const atInvitationRegistrar = enrollsAtInvitationRegistrar(url, context);
      const words = webSocketRelayRefusalWords(result.closeCode, {
        enrollsAtInvitationRegistrar: atInvitationRegistrar,
        partnersUnderInvitationExchangeId:
          context.invitationRelay?.websocket === url &&
          context.invitationRelay.websocketExchangeId !== undefined,
        enrollmentFailed: false,
        proofRemadeOnRelayClock: result.proofRemadeOnRelayClock,
      });
      const keyRefusal = WEBSOCKET_RELAY_KEY_REFUSALS.get(result.closeCode);
      const clause =
        webSocketRelayRefusalClause(result.closeCode) ??
        "the relay refused this exchange's proof";
      return doesNotWork(
        url,
        result.closeCode === 4003
          ? "not_enrolled"
          : result.closeCode === 4004 || result.closeCode === 4005
            ? "credential_refused"
            : "not_reached",
        keyRefusal?.summary ?? `${clause}.`,
        keyRefusal?.meaning ?? words.meaning,
        result.closeCode === 4003 && atInvitationRegistrar
          ? "Check again. If the relay still holds no key, ask your partner " +
              "whether the relay their invitation names is working."
          : keyRefusal !== undefined
            ? enrollmentAction(
                url,
                "websocket",
                context,
                result.closeCode === 4004,
              )
            : words.action,
      );
    }
    case "unexpected_message":
      return doesNotWork(
        url,
        "not_reached",
        "did not answer as an Alcove WebSocket relay.",
        WEBSOCKET_RELAY_UNEXPECTED_MESSAGE_WORDS.meaning,
        WEBSOCKET_RELAY_UNEXPECTED_MESSAGE_WORDS.action,
      );
    case "not_reached":
      return doesNotWork(
        url,
        "not_reached",
        `not reached within ${BOUND_SECONDS}.`,
        WEBSOCKET_RELAY_NOT_REACHED_MEANING,
        WEBSOCKET_RELAY_NOT_REACHED_ACTION,
      );
    case "no_relayed_path":
      return doesNotWork(
        url,
        "no_relayed_path",
        "no message passed through the relay.",
        WEBSOCKET_RELAY_NO_RELAYED_PATH_MEANING,
        RELAY_NOT_REACHED_REMEDY,
      );
    case "not_started":
      return notStarted(url, context);
  }
}

const NOT_STARTED_ACTION = {
  own: "Correct this url in Connection settings.",
  partner: "Ask your partner to check this relay's url.",
  site: CHECK_AGAIN_LATER,
} as const;

function notStarted(
  url: string,
  context: ExchangeRelayCheckContext,
): ExchangeRelayCheckLineShown {
  return {
    url: sanitizeForDisplay(url),
    works: false,
    cause: "not_reached",
    summary: "the check could not start a connection to this relay.",
    action: NOT_STARTED_ACTION[relayOwner(url, context)],
  };
}

/** The line that heads a verdict: whether the exchange will get through. */
export function exchangeRelayCheckVerdict(
  lines: ReadonlyArray<ExchangeRelayCheckLineShown>,
): string {
  if (lines.length === 0)
    return "A run of this exchange lists no relay the check could ask.";
  const working = lines.filter((line) => line.works).length;
  if (working === lines.length)
    return (
      "Every relay this exchange lists works, so the exchange will get " +
      "through over a relay where a direct connection is blocked."
    );
  if (working > 0)
    return (
      "At least one relay this exchange lists works, so the exchange will " +
      "get through over it where a direct connection is blocked. Each line " +
      "below says how to fix a relay that does not work."
    );
  return (
    "No relay this exchange lists works, so the exchange will not get " +
    "through where a direct connection is blocked. Follow the steps below, " +
    "then check again."
  );
}
