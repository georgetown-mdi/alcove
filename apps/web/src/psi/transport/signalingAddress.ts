import { signalingServerSetting } from "@utils/clientConfig";

import type { SignalingServerSetting } from "@utils/clientConfig";

/**
 * Where this app's browser parties reach the PeerJS signaling server. `path`
 * is the mount the client dials, ending in `/`; `port` is absent for the
 * scheme's default port, which is how an invitation endpoint states it.
 */
export interface SignalingAddress {
  host: string;
  port?: number;
  path: string;
  secure: boolean;
}

/** The mount this app's own signaling server answers at: `peerServer.ts`
 * mounts it at `/api`, and the PeerJS client dials the mount with its slash. */
export const OWN_SIGNALING_PATH = "/api/";

/** The page-location fields {@link resolveSignalingAddress} reads. */
export interface PageLocation {
  protocol: string;
  hostname: string;
  port: string;
}

/** What a deployment whose setting names `ws:` under an https page is told. */
export const INSECURE_SIGNALING_SERVER_REFUSED =
  "This deployment's signaling server is set to an unencrypted ws: address, " +
  "which a page served over https cannot connect to. Set " +
  "VITE_SIGNALING_SERVER_URL to a wss: address and rebuild the app.";

/** `localhost` becomes a loopback literal a peer on another resolver can dial. */
function dialableHost(host: string): string {
  return host === "localhost" ? "127.0.0.1" : host;
}

/**
 * The signaling address for a page at `page`: the deployment's `setting` when
 * it names one, otherwise the page's own host and port at
 * {@link OWN_SIGNALING_PATH}, over wss when the page is https. A blank,
 * non-numeric or out-of-range page port is treated as the default.
 *
 * @throws {Error} {@link INSECURE_SIGNALING_SERVER_REFUSED} when `setting`
 *                 names `ws:` and the page is https.
 */
export function resolveSignalingAddress(
  setting: SignalingServerSetting | undefined,
  page: PageLocation,
): SignalingAddress {
  const pageSecure = page.protocol === "https:";
  if (setting !== undefined) {
    if (pageSecure && !setting.secure)
      throw new Error(INSECURE_SIGNALING_SERVER_REFUSED);
    return { ...setting, host: dialableHost(setting.host) };
  }
  const address: SignalingAddress = {
    host: dialableHost(page.hostname),
    path: OWN_SIGNALING_PATH,
    secure: pageSecure,
  };
  // Number() rather than parseInt: "8080abc" becomes NaN and is dropped
  // instead of being truncated to 8080.
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
