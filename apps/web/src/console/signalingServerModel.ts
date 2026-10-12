/**
 * What the console's WebRTC option says about the coordination server the
 * operator set, and the invitation endpoint it mints from it. No React.
 */

import { publishedSignalingServerURL } from "@alcove/core";

import { invitationReach } from "@exchange/invitationReach";

import type { InvitationReach } from "@exchange/invitationReach";
import type { JobSignalingServerEndpoint } from "@jobContract/intentSchemas";
import type { SignalingServerProjection } from "@jobContract/signalingServer";
import type { WebRTCEndpoint } from "@alcove/core";

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

/** What the review step says when the coordination server changed between
 * this page reading it and the create: no invitation was made. */
export const SIGNALING_SERVER_CHANGED_ALERT = {
  title: "The coordination server changed",
  message:
    "The coordination server set on this console changed since this page " +
    "showed it, so no invitation was created. Check the coordination server " +
    "above, then create the invitation again.",
};

/** Whether `a` and `b` are the same server, reached the same way and found
 * through the same web app. */
export function sameSignalingServer(
  a: SignalingServerProjection,
  b: SignalingServerProjection,
): boolean {
  return (
    signalingServerAddress(a) === signalingServerAddress(b) &&
    a.webAppOrigin === b.webAppOrigin
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
 * The invitation endpoint for `server`: its host, port and path, and no
 * relay, since a console run connects directly. An endpoint names no scheme:
 * the partner dials it over `wss://`.
 */
export function webrtcEndpointForSignalingServer(
  server: SignalingServerProjection,
): WebRTCEndpoint {
  return {
    channel: "webrtc",
    host: server.host,
    ...(server.port !== undefined ? { port: server.port } : {}),
    path: server.path,
  };
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
 * and path do not make an address the console can hold.
 */
export function acceptedSignalingServer(
  endpoint: WebRTCEndpoint,
  held: SignalingServerProjection | null,
): AcceptedSignalingServer | undefined {
  const port = endpoint.port !== undefined ? `:${endpoint.port}` : "";
  const authority = `${endpoint.host}${port}${endpoint.path ?? "/"}`;
  let url = publishedSignalingServerURL(`wss://${authority}`);
  if (url === undefined) return undefined;
  if (held !== null && !held.secure && heldNames(held, url, endpoint.port))
    url = publishedSignalingServerURL(`ws://${authority}`);
  if (url === undefined) return undefined;
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
