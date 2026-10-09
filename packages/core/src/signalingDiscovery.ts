import { z } from "zod";

import { authorityMovingSignalingField } from "./rendezvous.js";
import { camelizeKeys } from "./utils/camelizeKeys.js";
import { maxCodeUnits } from "./utils/maxCodeUnits.js";

/**
 * The public path, at a web app's origin, of the document naming the
 * coordination server that app's browser parties use. The hosted build writes
 * it; `alcove invite` given the app's address reads it. See
 * docs/spec/WEBRTC_TRANSPORT.md#the-published-coordination-server.
 */
export const SIGNALING_DISCOVERY_PATH = "/alcove.json";

/** The largest {@link SIGNALING_DISCOVERY_PATH} body a reader accepts, in bytes. */
export const MAX_SIGNALING_DISCOVERY_BYTES = 4 * 1024;

/** The longest `signaling_server` URL a reader accepts, in UTF-16 code units. */
export const MAX_SIGNALING_SERVER_URL_LENGTH = 2048;

/** The document at {@link SIGNALING_DISCOVERY_PATH}, camelized. */
export interface SignalingDiscoveryDocument {
  /** The coordination server's `ws:` or `wss:` URL, its path the mount. */
  signalingServer: string;
}

const signalingDiscoveryDocumentSchema: z.ZodType<SignalingDiscoveryDocument> =
  z.object({
    signalingServer: z
      .string()
      .check(maxCodeUnits(MAX_SIGNALING_SERVER_URL_LENGTH)),
  });

/**
 * The coordination server `text` names, its path ending in `/`, or `undefined`
 * when it is not a `ws:` or `wss:` URL naming a host, with no user name,
 * password, query, fragment or percent-escape, and with no host or path a dial
 * would read as another server's.
 */
export function publishedSignalingServerURL(text: string): URL | undefined {
  if (text.length > MAX_SIGNALING_SERVER_URL_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    // On the raw text: URL reports an empty query or fragment as "", and a
    // dial decodes a percent-escape into the character it stands for.
    /[?#%]/.test(text) ||
    authorityMovingSignalingField({
      host: url.hostname,
      path: url.pathname,
    }) !== undefined
  )
    return undefined;
  // The browser client dials the mount with its slash; so does every reader.
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

/**
 * The coordination server a parsed {@link SIGNALING_DISCOVERY_PATH} document
 * names, or `undefined` when the document does not have the shape or its URL
 * fails {@link publishedSignalingServerURL}. Fields other than
 * `signaling_server` are ignored.
 */
export function signalingServerFromDiscoveryDocument(
  value: unknown,
): URL | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const parsed = signalingDiscoveryDocumentSchema.safeParse(
    camelizeKeys(value),
  );
  if (!parsed.success) return undefined;
  return publishedSignalingServerURL(parsed.data.signalingServer);
}

/**
 * The {@link SIGNALING_DISCOVERY_PATH} document naming `signalingServer`, as
 * the file's text. The URL is written in the form
 * {@link publishedSignalingServerURL} returns.
 *
 * @throws {Error} when {@link publishedSignalingServerURL} refuses
 *   `signalingServer`, so a build cannot publish a document no reader takes.
 */
export function signalingDiscoveryDocumentSource(
  signalingServer: string,
): string {
  const url = publishedSignalingServerURL(signalingServer.trim());
  if (url === undefined)
    throw new Error(
      `the coordination server address ${JSON.stringify(signalingServer)} ` +
        "cannot be published: it must be a ws: or wss: URL naming a host and " +
        "an optional port and path, with no user name, password, query or " +
        "fragment.",
    );
  return `${JSON.stringify({ signaling_server: url.href }, null, 2)}\n`;
}
