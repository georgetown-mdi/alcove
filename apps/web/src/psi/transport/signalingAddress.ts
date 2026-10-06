import {
  SIGNALING_SCHEME_MISMATCH,
  signalingSchemeMatchesPage,
} from "@utils/signalingScheme";
import { authorityMovingSignalingField } from "@alcove/core";

import { signalingServerSetting } from "@utils/clientConfig";

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
 * reaches, or `undefined` when neither does: core's
 * {@link authorityMovingSignalingField} over the endpoint's host and the path a
 * dial uses, {@link OWN_SIGNALING_PATH} where the endpoint states none. A fresh
 * accept and a saved exchange's later run both refuse by this one rule.
 */
export function refusedSignalingEndpointField(
  endpoint: Pick<WebRTCEndpoint, "host" | "path">,
): SignalingLocationField | undefined {
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
 * This app's signaling address, resolved from the deployment setting and
 * `window.location`: the one source for both where a browser inviter
 * registers and the endpoint its invitation names. Browser only.
 */
export function ownSignalingAddress(): SignalingAddress {
  if (typeof window === "undefined")
    throw new Error("ownSignalingAddress must be called in the browser");
  return resolveSignalingAddress(signalingServerSetting(), window.location);
}
