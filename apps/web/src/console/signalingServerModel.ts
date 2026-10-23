/**
 * What the console's WebRTC option says about the coordination server the
 * operator set, and the invitation endpoint it mints from it. No React.
 */

import {
  RelayRegistrarSchema,
  publishedSignalingServerURL,
} from "@alcove/core";

import {
  EXCHANGE_ID_PRIVACY,
  relayRegistrarExchangeIdProblems,
  relayRegistrarUrlProblems,
} from "@psi/managed/managedRelayRegistration";
import {
  parseRelayUrlLines,
  parseWebSocketRelayUrl,
} from "@psi/transport/ownRelaySetting";
import { invitationReach } from "@exchange/invitationReach";
import { ownRelayInvitationLocator } from "@jobContract/signalingServer";
import { refusedSignalingEndpointField } from "@psi/transport/signalingAddress";

import {
  ENROLL_RELAY_TOKEN_STEP,
  RELAY_OWNER_ENROLLMENT_NOTICE,
} from "./mountedConfiguration";

import type {
  JobOwnRelay,
  SignalingServerProjection,
} from "@jobContract/signalingServer";
import type { RelayRegistrar, WebRTCEndpoint } from "@alcove/core";
import type { InvitationReach } from "@exchange/invitationReach";
import type { JobSignalingServerEndpoint } from "@jobContract/intentSchemas";

/** The public Alcove web app, which publishes the coordination server it uses
 * at `/alcove.json`. The console fills it in only when the operator asks. */
export const HOSTED_WEB_APP_ADDRESS = "https://psi.data-bridge.org";

/** What the action that fills in {@link HOSTED_WEB_APP_ADDRESS} says it does,
 * beside the action. */
export const HOSTED_WEB_APP_FILL_NOTE =
  `Fills in ${HOSTED_WEB_APP_ADDRESS}, the public Alcove web app. Your ` +
  "partner accepts there, and both of your computers then contact the " +
  "coordination server it names to find each other. That server sees your " +
  "network addresses, not your data.";

/** Why the review step holds the create while no coordination server is set. */
export const COORDINATION_SERVER_MISSING =
  "Set the coordination server above to continue.";

/** Why the review step holds the create while the console has not yet said
 * whether a coordination server is set. */
export const COORDINATION_SERVER_LOADING = "Checking the coordination server.";

/** What the review step says when the coordination server or relay changed
 * between this page reading it and the create: no invitation was made. */
export const SIGNALING_SERVER_CHANGED_ALERT = {
  title: "The coordination server or relay changed",
  message:
    "The coordination server or relay set on this console changed since " +
    "this page showed it, so no invitation was created. Check them above, " +
    "then create the invitation again.",
};

/** Whether `a` and `b` are the same server, reached the same way, found
 * through the same web app, and set with the same relay. */
export function sameSignalingServer(
  a: SignalingServerProjection,
  b: SignalingServerProjection,
): boolean {
  return (
    signalingServerAddress(a) === signalingServerAddress(b) &&
    a.webAppOrigin === b.webAppOrigin &&
    sameOwnRelay(a.ownRelay, b.ownRelay)
  );
}

function sameOwnRelay(
  a: JobOwnRelay | undefined,
  b: JobOwnRelay | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const aTurn = a.turn ?? [];
  const bTurn = b.turn ?? [];
  return (
    aTurn.length === bTurn.length &&
    aTurn.every((url, index) => url === bTurn[index]) &&
    a.websocket === b.websocket &&
    a.relayRegistrar?.url === b.relayRegistrar?.url &&
    a.relayRegistrar?.exchangeId === b.relayRegistrar?.exchangeId
  );
}

/** The coordination server as a `ws://` or `wss://` address. */
export function signalingServerAddress(
  server: SignalingServerProjection,
): string {
  const port = server.port !== undefined ? `:${server.port}` : "";
  return `${server.secure ? "wss" : "ws"}://${server.host}${port}${server.path}`;
}

/**
 * The invitation endpoint for `server`: its host, port and path, and the
 * relay set for this console's invitations as `alcove invite` names a
 * configuration's own relay ({@link ownRelayInvitationLocator}). An endpoint
 * names no scheme: the partner dials it over `wss://`.
 */
export function webrtcEndpointForSignalingServer(
  server: SignalingServerProjection,
): WebRTCEndpoint {
  const relay = ownRelayInvitationLocator(server.ownRelay);
  return {
    channel: "webrtc",
    host: server.host,
    ...(server.port !== undefined ? { port: server.port } : {}),
    path: server.path,
    ...(relay !== undefined ? { relay } : {}),
  };
}

/** The relay fields of the coordination server form, as typed: TURN urls one
 * per line, the WebSocket relay url, and the registrar's address and exchange
 * id. */
export interface OwnRelayDraft {
  turn: string;
  websocket: string;
  registrarUrl: string;
  exchangeId: string;
}

/** The relay fields of a form that sets none. */
export const EMPTY_OWN_RELAY_DRAFT: OwnRelayDraft = {
  turn: "",
  websocket: "",
  registrarUrl: "",
  exchangeId: "",
};

/** What the relay fields come to: the relay to set, none where every field
 * is empty, or the problems of each field, in core's own words. */
export type OwnRelayDraftResult =
  | { ok: true; ownRelay: JobOwnRelay | undefined }
  | {
      ok: false;
      turnProblems: Array<string>;
      websocketProblems: Array<string>;
      registrarUrlProblems: Array<string>;
      exchangeIdProblems: Array<string>;
    };

/** The WebSocket relay field's description: what the relay is for, and what
 * its operator learns, since the run connects to it as it starts. */
export const OWN_WEBSOCKET_RELAY_FIELD_DESCRIPTION =
  "A relay for networks that block connections through a TURN relay. The " +
  "run connects to it as it starts, so its operator learns your network " +
  "address, and the exchange passes through it, encrypted, only when no " +
  "other connection opens. The invitation names it for your partner. One " +
  "wss:// url, for example wss://relay.example.org/relay";

/** The problem of a registrar set with no TURN url to register for. Core's
 * `relay_registrar` rule holds a registrar to a `turn` entry, a WebSocket
 * relay alone included. */
export const REGISTRAR_WITHOUT_RELAY =
  "Enter your relay's turn: or turns: url to use its registrar.";

/** `message` as a sentence: its first letter capitalized, ending in a period. */
function asSentence(message: string): string {
  const capitalized = message.charAt(0).toUpperCase() + message.slice(1);
  return capitalized.endsWith(".") ? capitalized : `${capitalized}.`;
}

/**
 * Read the relay fields under the rules `PUT /api/jobs/webrtc` applies:
 * each TURN line under core's `turn` url rule and the list bound, the
 * WebSocket relay url under core's `websocket_relay` rule, and a registrar,
 * given either of its fields, under core's registrar rule and only beside a
 * TURN url.
 */
export function ownRelayFromDraft(draft: OwnRelayDraft): OwnRelayDraftResult {
  const lines = parseRelayUrlLines(draft.turn, "turn");
  const turnProblems = lines.ok
    ? []
    : lines.problems.map((problem) =>
        problem.line === undefined
          ? `Relay servers: ${problem.message}.`
          : `Line ${problem.line}: ${problem.message}.`,
      );
  const websocketEntry = parseWebSocketRelayUrl(draft.websocket);
  const websocketProblems = websocketEntry.ok
    ? []
    : [asSentence(websocketEntry.message)];
  const websocket = websocketEntry.ok ? websocketEntry.url : undefined;
  const urls = lines.ok ? lines.urls : [];
  const registrarStated =
    draft.registrarUrl.trim() !== "" || draft.exchangeId.trim() !== "";
  let registrarUrlProblems: Array<string> = [];
  let exchangeIdProblems: Array<string> = [];
  let relayRegistrar: RelayRegistrar | undefined;
  if (registrarStated) {
    if (lines.ok && urls.length === 0)
      turnProblems.push(REGISTRAR_WITHOUT_RELAY);
    const parsed = RelayRegistrarSchema.safeParse({
      url: draft.registrarUrl,
      exchangeId: draft.exchangeId.trim(),
    });
    if (parsed.success) relayRegistrar = parsed.data;
    else {
      registrarUrlProblems = relayRegistrarUrlProblems(parsed.error.issues);
      const idProblems = relayRegistrarExchangeIdProblems(parsed.error.issues);
      exchangeIdProblems =
        idProblems.length > 0 ? [...idProblems, EXCHANGE_ID_PRIVACY] : [];
    }
  }
  if (
    turnProblems.length > 0 ||
    websocketProblems.length > 0 ||
    registrarUrlProblems.length > 0 ||
    exchangeIdProblems.length > 0
  )
    return {
      ok: false,
      turnProblems,
      websocketProblems,
      registrarUrlProblems,
      exchangeIdProblems,
    };
  if (urls.length === 0 && websocket === undefined)
    return { ok: true, ownRelay: undefined };
  return {
    ok: true,
    ownRelay: {
      ...(urls.length > 0 ? { turn: urls } : {}),
      ...(websocket !== undefined ? { websocket } : {}),
      ...(relayRegistrar !== undefined ? { relayRegistrar } : {}),
    },
  };
}

/** The relay fields showing `relay`, for changing it. */
export function ownRelayDraft(relay: JobOwnRelay | undefined): OwnRelayDraft {
  if (relay === undefined) return EMPTY_OWN_RELAY_DRAFT;
  return {
    turn: (relay.turn ?? []).join("\n"),
    websocket: relay.websocket ?? "",
    registrarUrl: relay.relayRegistrar?.url ?? "",
    exchangeId: relay.relayRegistrar?.exchangeId ?? "",
  };
}

/** What the WebRTC option says when no relay is set: the run connects
 * directly, and what that costs. */
export const NO_RELAY_NOTE =
  "No relay is set, so the exchange connects directly, and a network that " +
  "blocks direct connections on either side stops it from connecting. Set a " +
  "relay (TURN) server to connect through it when a direct connection fails.";

/**
 * What the operator is told before the run about a relay whose key must be
 * enrolled: the relay accepts the run's credential only once it holds the key
 * derived from this exchange's shared secret. With a registrar, the step is
 * `alcove enroll-relay` in the working folder once the console wrote the
 * exchange's files; with none, the relay's owner registers the key, and a
 * relay with a TURN url is offered the registrar, which needs one.
 * Undefined where no relay is set.
 */
export function ownRelayEnrollmentNotice(
  relay: JobOwnRelay | undefined,
): string | undefined {
  if (relay === undefined) return undefined;
  const accepts =
    "Your relay accepts this exchange's connection only once it holds the " +
    "key derived from the exchange's shared secret.";
  if (relay.relayRegistrar === undefined)
    return relay.turn === undefined
      ? RELAY_OWNER_ENROLLMENT_NOTICE
      : `${RELAY_OWNER_ENROLLMENT_NOTICE} Or set your relay's registrar here ` +
          "so that you can enroll the exchange and each run registers its new key.";
  return (
    `${accepts} When you create the invitation, the console writes ` +
    "alcove.yaml and .alcove.key into your working folder. Before your " +
    "partner connects, run alcove enroll-relay in that folder to enroll the " +
    `exchange at your relay's registrar. ${ENROLL_RELAY_TOKEN_STEP} Each run ` +
    "after that registers its new key without the token."
  );
}

/** Who can reach `server`, judged from its host as an invitation link is. */
export function signalingServerReach(
  server: SignalingServerProjection,
): InvitationReach {
  return invitationReach(`https://${server.host}/`);
}

/** Why a partner elsewhere cannot use `server`, or undefined when nothing in
 * its address says so. */
export function signalingServerReachProblem(
  server: SignalingServerProjection,
): string | undefined {
  const reach = signalingServerReach(server);
  if (reach === "anywhere") return undefined;
  return (
    "This coordination server is on " +
    (reach === "thisComputer" ? "this computer" : "your local network") +
    ", so a partner elsewhere cannot reach it. Set a server your partner " +
    "can reach as well, such as the Alcove web app's."
  );
}

/** The coordination server a console accept dials: the address the console
 * is set to, and the server and relay the run names to the console. */
export interface AcceptedSignalingServer {
  address: string;
  signalingServer: JobSignalingServerEndpoint;
}

/**
 * The coordination server a console accept of `endpoint` dials, as the CLI
 * reads the endpoint: its path, else `/`. It is reached over `ws://` only
 * where the console already holds that same server at a `ws://` address, as
 * an operator testing with a server on this machine sets it; otherwise over
 * `wss://`, as `alcove accept` dials it. Undefined when the endpoint's host
 * and path do not make an address the console can hold, as written or as
 * parsed.
 */
export function acceptedSignalingServer(
  endpoint: WebRTCEndpoint,
  held: SignalingServerProjection | null,
): AcceptedSignalingServer | undefined {
  if (
    refusedSignalingEndpointField({
      host: endpoint.host,
      path: endpoint.path ?? "/",
    }) !== undefined
  )
    return undefined;
  const port = endpoint.port !== undefined ? `:${endpoint.port}` : "";
  const authority = `${endpoint.host}${port}${endpoint.path ?? "/"}`;
  let url = publishedSignalingServerURL(`wss://${authority}`);
  if (url === undefined) return undefined;
  if (held !== null && !held.secure && heldNames(held, url, endpoint.port))
    url = publishedSignalingServerURL(`ws://${authority}`);
  // The console checks the parsed address again when it is set, where a
  // percent-escape the parser wrote into the path is refused.
  if (url === undefined || publishedSignalingServerURL(url.href) === undefined)
    return undefined;
  return {
    address: url.href,
    signalingServer: {
      host: url.hostname,
      ...(url.port !== "" ? { port: Number(url.port) } : {}),
      path: url.pathname,
      ...(endpoint.relay !== undefined ? { relay: endpoint.relay } : {}),
    },
  };
}

/** Whether `held`, a `ws://` server, is the one `url` names on the port the
 * endpoint states or, where it states none, the `ws://` default. */
function heldNames(
  held: SignalingServerProjection,
  url: URL,
  endpointPort: number | undefined,
): boolean {
  return (
    held.host === url.hostname &&
    (held.port ?? 80) === (endpointPort ?? 80) &&
    held.path === url.pathname
  );
}

/** What a `ws://` server costs the invitation: the endpoint names no scheme,
 * so the partner's side dials it over `wss://`. */
export const UNENCRYPTED_SERVER_INVITATION_NOTE =
  "The invitation does not say the server uses ws://. Your partner's " +
  "command-line tool connects over wss:// unless they set secure: false in " +
  "the connection of their alcove.yaml, and a web app served over https:// " +
  "always connects over wss://.";
