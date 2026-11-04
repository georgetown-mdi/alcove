/**
 * An exchange's coordination server address as a user types it in its
 * Connection settings: the rule it is held to and the messages that refuse
 * it. An invitation names the server its Connection settings name, the
 * deployment's own (`ownSignalingAddress` in `./signalingAddress.ts`) unless
 * changed; a saved exchange holds its own, which its re-invites name.
 */

import {
  MAX_ENDPOINT_HOST_LENGTH,
  publishedSignalingServerURL,
} from "@alcove/core";

/** The longest label, the text between two dots, a DNS host name may have. */
const MAX_HOST_LABEL_LENGTH = 63;

/** What {@link parseCoordinationServerUrl} made of the entered text. */
export type CoordinationServerEntry =
  /** `url` absent where the text is blank: none set. */
  { ok: true; url?: string } | { ok: false; message: string };

/** The scheme a coordination server address takes on a page served with
 * `pageProtocol`: the acceptor dials an invitation's server with its own
 * page's scheme, so the inviter's must match it. */
function schemeForPage(pageProtocol: string): "wss" | "ws" {
  return pageProtocol === "https:" ? "wss" : "ws";
}

/** Why an entered address is refused, naming the form that works. */
export function coordinationServerFormMessage(pageProtocol: string): string {
  const scheme = schemeForPage(pageProtocol);
  return (
    `Enter the coordination server's address starting with ${scheme}://, ` +
    `for example ${scheme}://signaling.example.org/api/. It cannot contain ` +
    "a user name, password, space, @, ?, # or %."
  );
}

/** Why an address whose host an invitation cannot name is refused: longer
 * than an invitation's host may be, or with a label longer than DNS allows. */
export const COORDINATION_SERVER_TOO_LONG_MESSAGE =
  "This address is too long. Enter an address whose host name has at most " +
  `${String(MAX_ENDPOINT_HOST_LENGTH)} characters, and at most ` +
  `${String(MAX_HOST_LABEL_LENGTH)} between two dots.`;

/** The refusal of a web app's address, which names a coordination server
 * only through the file the app publishes. */
export function webAppAddressMessage(pageProtocol: string): string {
  return (
    "This is a web page's address, not a coordination server's. Whoever " +
    `runs the server can give you its ${schemeForPage(pageProtocol)}:// ` +
    "address."
  );
}

/**
 * Read a coordination server address from `text` for a page served with
 * `pageProtocol`: core's {@link publishedSignalingServerURL} rule, the one
 * the console and a build's own setting are held to, with the page's scheme
 * (`wss:` under `https`, `ws:` otherwise) and a port that can be dialed.
 * An address the URL parser would store percent-escaped, such as one with a
 * space in its path, is refused too, since that rule refuses the stored form
 * when it is read back, and so is a host longer than an invitation's endpoint
 * schema allows ({@link MAX_ENDPOINT_HOST_LENGTH}) or with a label longer
 * than {@link MAX_HOST_LABEL_LENGTH}. Blank text names none.
 */
export function parseCoordinationServerUrl(
  text: string,
  pageProtocol: string,
): CoordinationServerEntry {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true };
  if (/^https?:\/\//i.test(trimmed))
    return { ok: false, message: webAppAddressMessage(pageProtocol) };
  const url = publishedSignalingServerURL(trimmed);
  if (
    url === undefined ||
    url.protocol !== `${schemeForPage(pageProtocol)}:` ||
    url.port === "0" ||
    url.href.includes("%")
  )
    return { ok: false, message: coordinationServerFormMessage(pageProtocol) };
  if (
    url.hostname.length > MAX_ENDPOINT_HOST_LENGTH ||
    url.hostname
      .split(".")
      .some((label) => label.length > MAX_HOST_LABEL_LENGTH)
  )
    return { ok: false, message: COORDINATION_SERVER_TOO_LONG_MESSAGE };
  return { ok: true, url: url.href };
}
