import {
  RELAY_CHECK_BOUND_MS,
  sanitizeForDisplay,
  turnUrlTransport,
} from "@alcove/core";

import {
  defaultRelayRefusalReason,
  retryWaitPhrase,
} from "@psi/transport/defaultRelayRefusal";

import type { DefaultRelayRefusal } from "@psi/transport/defaultRelayRefusal";
import type { Displayable } from "@alcove/core";
import type { ExchangeRelayCheckLine } from "@psi/transport/exchangeRelayCheck";
import type { RelayUrls } from "@psi/transport/ownRelaySetting";
import type { RunRelayHosts } from "@psi/transport/runRelayPlan";

/** What the check does, beside the control that shows its hosts. */
export const EXCHANGE_RELAY_CHECK_INTRO =
  "Check whether each relay this exchange lists works for it. Nothing is " +
  "contacted until you start the check.";

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

const DISCLOSURE = "Whoever runs it learns this computer's network address.";

const LISTED_ONCE_ENROLLED =
  "The check uses it only once this site's relay server is set up for this " +
  "exchange, as a run does.";

/**
 * The statement the check makes before any contact, for the hosts a run of
 * the exchange may contact. Every url is escaped and bounded for display,
 * since an invitation's relay is the partner's text.
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
              "This site's relay server. The check first sets it up for " +
                "this exchange, as a run does.",
              DISCLOSURE,
            ],
          },
        ]
      : []),
    ...hosts.turn.map((url) => ({
      host: sanitizeForDisplay(url),
      explanation: [
        "A TURN relay. The check sends one message through it.",
        ...onceEnrolled(url),
        DISCLOSURE,
      ],
    })),
    ...hosts.websocket.map((url) => ({
      host: sanitizeForDisplay(url),
      explanation: [
        "A WebSocket relay. The check sends one message through it.",
        ...onceEnrolled(url),
        DISCLOSURE,
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
  /** Said in place of Works or Does not work. */
  status?: string;
  /** What the check found, after the url. */
  summary?: string;
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

type RelayOwner = "site" | "partner" | "own";

// Whose relay `url` is, by where the run takes it from.
function relayOwner(
  url: string,
  context: ExchangeRelayCheckContext,
): RelayOwner {
  if (context.hosts.listedOnceEnrolled.includes(url)) return "site";
  const invited = context.invitationRelay;
  if (invited?.websocket === url || (invited?.turn ?? []).includes(url))
    return "partner";
  return "own";
}

const CHECK_AGAIN_LATER = "Check again later.";

const ASK_OPERATOR =
  "Ask whoever runs the relay to check it, then check again.";

// What to do about a url that is not a working relay, by whose relay it is.
const URL_ACTION: Readonly<Record<RelayOwner, string>> = {
  own: "Correct this url in Connection settings.",
  partner: "Ask your partner to check this relay's url.",
  site: CHECK_AGAIN_LATER,
};

// What to do about a relay that connected and passed no message.
const NO_RELAYED_PATH_ACTION: Readonly<Record<RelayOwner, string>> = {
  own: "Check this relay, or remove it from Connection settings.",
  partner: "Ask your partner to check this relay.",
  site: CHECK_AGAIN_LATER,
};

// What to add, by whose relay it is, when a TURN relay was not reached and
// checking again did not change that.
const NOT_REACHED_FOLLOW_UP: Readonly<Record<RelayOwner, string>> = {
  own: " If it still fails, check this relay, or remove it from Connection settings.",
  partner: " If it still fails, ask your partner to check this relay.",
  site: "",
};

function lowercaseFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
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
              "tick Replace the key the relay holds for this exchange, and " +
              "select Enroll."
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

interface LineWords {
  summary: string;
  meaning?: string;
  action: string;
}

function doesNotWork(
  url: string,
  cause: ExchangeRelayCheckCause,
  words: LineWords,
): ExchangeRelayCheckLineShown {
  return {
    url: sanitizeForDisplay(url),
    works: false,
    cause,
    summary: words.summary,
    ...(words.meaning !== undefined && { meaning: words.meaning }),
    action: words.action,
  };
}

function works(url: string, summary: string): ExchangeRelayCheckLineShown {
  return { url: sanitizeForDisplay(url), works: true, summary };
}

// What to do once this site's relay server could not be set up.
function notEnrolledAction(refusal: DefaultRelayRefusal): string {
  if (refusal.retryAfterSeconds !== undefined)
    return `Check again in ${retryWaitPhrase(refusal.retryAfterSeconds)}.`;
  return refusal.cause === "unreachable"
    ? "Check your network connection, then check again."
    : CHECK_AGAIN_LATER;
}

// A WebSocket relay's refusal other than 4003 and 4004.
function webSocketRefusalWords(
  url: string,
  closeCode: number,
  proofRemadeOnRelayClock: boolean,
  context: ExchangeRelayCheckContext,
): LineWords {
  switch (closeCode) {
    case 4005:
      return proofRemadeOnRelayClock
        ? {
            summary:
              "the relay refused this computer's request as expired, even " +
              "when timed by the relay's own clock.",
            action:
              "Check again. If the relay still refuses, ask whoever runs " +
              "it to check it.",
          }
        : {
            summary: "the relay refused this computer's request as expired.",
            meaning:
              "this computer's clock and the relay's may differ by more " +
              "than five minutes.",
            action:
              "Correct this computer's clock, then check again. If the " +
              "relay still refuses, ask whoever runs it to check its clock.",
          };
    case 4007:
      return {
        summary: "the relay did not hear from this computer in time.",
        action:
          "Check the network path to the relay, including any proxy, then " +
          "check again.",
      };
    case 4008:
      return {
        summary: "the relay is serving as many exchanges as it allows.",
        action: CHECK_AGAIN_LATER,
      };
    case 1011:
      return {
        summary: "the relay failed while checking this exchange.",
        action: ASK_OPERATOR,
      };
    case 1001:
      return {
        summary: "the relay is shutting down.",
        action: CHECK_AGAIN_LATER,
      };
    default:
      return {
        summary: "the relay refused a message from this computer.",
        meaning: "the url may not name an Alcove WebSocket relay.",
        action: URL_ACTION[relayOwner(url, context)],
      };
  }
}

/**
 * A line as shown, in the web app's own words: what the check saw, and a
 * step the user can take on this page or ask of the partner, by whose relay
 * it is.
 */
export function exchangeRelayCheckLineShown(
  line: ExchangeRelayCheckLine,
  context: ExchangeRelayCheckContext,
): ExchangeRelayCheckLineShown {
  const { url } = line;
  const owner = relayOwner(url, context);
  if ("notEnrolled" in line)
    return doesNotWork(url, "not_enrolled", {
      summary:
        "this site's relay server could not be set up for this exchange, " +
        "so a run does not use this relay.",
      meaning: lowercaseFirst(defaultRelayRefusalReason(line.notEnrolled)),
      action: notEnrolledAction(line.notEnrolled),
    });
  if (line.relay === "turn")
    switch (line.result) {
      case "works":
        return works(url, "a message passed through this relay.");
      case "not_reached":
        return doesNotWork(url, "not_reached", {
          summary: `no connection through this relay within ${BOUND_SECONDS}.`,
          meaning:
            turnUrlTransport(url) === "tls"
              ? "this computer could not reach it, the relay refused this " +
                "exchange, or the relay presented a certificate this " +
                "computer does not trust; the browser does not report which."
              : "this computer could not reach it, or the relay refused " +
                "this exchange; the browser does not report which.",
          action:
            "Check that this computer can reach the relay, then check again." +
            NOT_REACHED_FOLLOW_UP[owner],
        });
      case "credential_refused":
        return doesNotWork(url, "credential_refused", {
          summary: "the relay refused this exchange.",
          meaning:
            owner === "own"
              ? "it may need this exchange enrolled first."
              : "it needs this exchange enrolled first.",
          action:
            owner === "site"
              ? CHECK_AGAIN_LATER
              : enrollmentAction(url, "turn", context, false),
        });
      case "no_relayed_path":
        return doesNotWork(url, "no_relayed_path", {
          summary: "the relay connected, but no message passed through it.",
          action: NO_RELAYED_PATH_ACTION[owner],
        });
      case "not_started":
        return notStarted(url, owner);
      case "credential_not_made":
        return doesNotWork(url, "not_reached", {
          summary:
            "this browser could not make this exchange's relay credential.",
          action: "Reload this page, then check again.",
        });
    }
  const result = line.result;
  switch (result.kind) {
    case "works":
      return works(url, "a message passed through this relay.");
    case "admitted":
      return works(
        url,
        "the relay accepted this exchange, and another connection for it " +
          "is waiting there.",
      );
    case "refused":
      if (result.closeCode === 4003)
        return doesNotWork(url, "not_enrolled", {
          summary:
            "the relay refuses this exchange until it is enrolled there.",
          action: enrollsAtInvitationRegistrar(url, context)
            ? "Check again. If the relay still refuses, ask your partner " +
              "whether the relay their invitation names is working."
            : enrollmentAction(url, "websocket", context, false),
        });
      if (result.closeCode === 4004)
        return doesNotWork(url, "credential_refused", {
          summary:
            "the relay refuses this exchange because it holds a different " +
            "key for it.",
          action: enrollmentAction(url, "websocket", context, true),
        });
      return doesNotWork(
        url,
        result.closeCode === 4005 ? "credential_refused" : "not_reached",
        webSocketRefusalWords(
          url,
          result.closeCode,
          result.proofRemadeOnRelayClock,
          context,
        ),
      );
    case "unexpected_message":
      return doesNotWork(url, "not_reached", {
        summary: "did not answer as an Alcove WebSocket relay.",
        action: URL_ACTION[owner],
      });
    case "not_reached":
      return doesNotWork(url, "not_reached", {
        summary: `not reached within ${BOUND_SECONDS}.`,
        action:
          "Check that this computer can reach the relay and that its url " +
          "is correct, then check again.",
      });
    case "no_relayed_path":
      return doesNotWork(url, "no_relayed_path", {
        summary: "the relay connected, but no message passed through it.",
        action: NO_RELAYED_PATH_ACTION[owner],
      });
    case "not_started":
      return notStarted(url, owner);
  }
}

function notStarted(
  url: string,
  owner: RelayOwner,
): ExchangeRelayCheckLineShown {
  return doesNotWork(url, "not_reached", {
    summary: "the check could not start a connection to this relay.",
    action: URL_ACTION[owner],
  });
}

/** The line that heads a verdict: whether the exchange will get through. */
export function exchangeRelayCheckVerdict(
  lines: ReadonlyArray<ExchangeRelayCheckLineShown>,
): string {
  if (lines.length === 0)
    return "A run of this exchange lists no relay the check could ask.";
  const working = lines.filter((line) => line.works).length;
  if (working === lines.length) return "Every relay works.";
  if (working > 0)
    return (
      "At least one relay works from this computer. " +
      "The steps below fix the others."
    );
  return (
    "No relay works, so the exchange connects only where a direct " +
    "connection is possible. Follow the steps below, then check again."
  );
}
