import {
  SIGNALING_SCHEME_MISMATCH,
  signalingSchemeMatchesPage,
} from "@utils/signalingScheme";
import {
  authorityMovingSignalingField,
  isBareSignalingHost,
} from "@alcove/core";

import { signalingServerSetting } from "@utils/clientConfig";

import { readCoordinationServerSetting } from "./coordinationServerSetting";

import type { SignalingLocationField, WebRTCEndpoint } from "@alcove/core";
import type { SignalingServerSetting } from "@utils/clientConfig";

/**
 * Where this app's browser parties reach the PeerJS signaling server. `path`
 * is the mount the client dials, ending in `/`; `port` is absent for the
 * scheme's default port, which is how an invitation endpoint states it, and is
 * always present for a configured server.
 */
export interface SignalingAddress {
  host: string;
  port?: number;
  path: string;
  secure: boolean;
}

/** The mount the signaling broker answers at on this app's own origin: the
 * standalone broker (packages/peerjs-broker) mounts it at `/api` by default,
 * and the PeerJS client dials the mount with its slash. */
export const OWN_SIGNALING_PATH = "/api/";

/**
 * The field of a webrtc endpoint whose shape could move the address a dial
 * reaches, or `undefined` when neither does: the host when core's
 * {@link isBareSignalingHost} refuses it, the rule `alcove accept` applies,
 * else core's {@link authorityMovingSignalingField} over the path a dial uses,
 * {@link OWN_SIGNALING_PATH} where the endpoint states none. A fresh accept, a
 * console accept and a saved exchange's later run all refuse by this one rule.
 */
export function refusedSignalingEndpointField(
  endpoint: Pick<WebRTCEndpoint, "host" | "path">,
): SignalingLocationField | undefined {
  if (!isBareSignalingHost(endpoint.host)) return "host";
  return authorityMovingSignalingField({
    host: endpoint.host,
    path: endpoint.path ?? OWN_SIGNALING_PATH,
  });
}

/** The page-location fields {@link resolveSignalingAddress} reads. */
export interface PageLocation {
  protocol: string;
  hostname: string;
  port: string;
}

/** `localhost` becomes a loopback literal a peer on another resolver can dial. */
function dialableHost(host: string): string {
  return host === "localhost" ? "127.0.0.1" : host;
}

/**
 * The signaling address for a page at `page`: the deployment's `setting` when
 * it names one, with its port always stated, otherwise the page's own host and
 * port at {@link OWN_SIGNALING_PATH}, over wss when the page is https. A blank,
 * non-numeric or out-of-range page port is treated as the default.
 *
 * @throws {Error} {@link SIGNALING_SCHEME_MISMATCH} when `setting`'s scheme
 *                 differs from the page's.
 */
export function resolveSignalingAddress(
  setting: SignalingServerSetting | undefined,
  page: PageLocation,
): SignalingAddress {
  if (setting !== undefined) {
    if (!signalingSchemeMatchesPage(setting, page.protocol))
      throw new Error(
        `VITE_SIGNALING_SERVER_URL: ${SIGNALING_SCHEME_MISMATCH}.`,
      );
    return {
      ...setting,
      host: dialableHost(setting.host),
      port: setting.port ?? (setting.secure ? 443 : 80),
    };
  }
  const address: SignalingAddress = {
    host: dialableHost(page.hostname),
    path: OWN_SIGNALING_PATH,
    secure: page.protocol === "https:",
  };
  const port = Number(page.port);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) address.port = port;
  return address;
}

/**
 * This deployment's signaling address, resolved from the deployment setting
 * and `window.location`: the server an invitation names where this browser's
 * coordination server setting names none ({@link inviterSignalingAddress}).
 * Browser only.
 */
export function ownSignalingAddress(): SignalingAddress {
  if (typeof window === "undefined")
    throw new Error("ownSignalingAddress must be called in the browser");
  return resolveSignalingAddress(signalingServerSetting(), window.location);
}

/**
 * The signaling address an invitation this browser creates names: `own`,
 * this browser's coordination server setting, with its port always stated,
 * else `deployment`, read only then. `own` is an address
 * `parseCoordinationServerUrl` accepted.
 */
export function resolveInviterSignalingAddress(
  own: string | undefined,
  deployment: () => SignalingAddress,
): SignalingAddress {
  if (own === undefined) return deployment();
  const url = new URL(own);
  const secure = url.protocol === "wss:";
  return {
    host: dialableHost(url.hostname),
    port: url.port !== "" ? Number(url.port) : secure ? 443 : 80,
    path: url.pathname,
    secure,
  };
}

/**
 * The signaling address an invitation this browser creates names, and where
 * its inviter registers: this browser's coordination server setting, else
 * {@link ownSignalingAddress}. A stored setting this page cannot read names
 * none. Browser only.
 */
export function inviterSignalingAddress(): SignalingAddress {
  if (typeof window === "undefined")
    throw new Error("inviterSignalingAddress must be called in the browser");
  const own = readCoordinationServerSetting(window.location.protocol);
  return resolveInviterSignalingAddress(
    own.kind === "set" ? own.url : undefined,
    ownSignalingAddress,
  );
}

/**
 * The address of the server `endpoint` names, as a `ws://` or `wss://` url
 * by this page's scheme, when it is not this deployment's own: the server
 * this browser's coordination server setting named when the invitation was
 * created. Undefined for the deployment's own server. Browser only.
 */
export function settingServerNamedBy(
  endpoint: Pick<WebRTCEndpoint, "host" | "port" | "path">,
): string | undefined {
  const secure = window.location.protocol === "https:";
  const defaultPort = secure ? 443 : 80;
  const deployment = ownSignalingAddress();
  const port = endpoint.port ?? defaultPort;
  const path = endpoint.path ?? OWN_SIGNALING_PATH;
  if (
    endpoint.host === deployment.host &&
    port === (deployment.port ?? defaultPort) &&
    path === deployment.path
  )
    return undefined;
  const statedPort = port === defaultPort ? "" : `:${port}`;
  return `${secure ? "wss" : "ws"}://${endpoint.host}${statedPort}${path}`;
}

/**
 * An inviter's registration at the coordination server this browser's
 * setting named failed with no answer from it. The message names the server
 * and how to clear the setting.
 */
export class CoordinationServerUnreachableError extends Error {
  /** The server's address, as {@link settingServerNamedBy} states it. */
  readonly server: string;
  constructor(server: string, options?: ErrorOptions) {
    super(
      `This page could not connect to ${server}, the coordination server ` +
        "set in Relay settings that this invitation names.",
      options,
    );
    this.name = "CoordinationServerUnreachableError";
    this.server = server;
  }
}
