/**
 * This browser's own coordination server: the address a user names on the
 * relay settings page for the invitations this browser creates, kept in
 * localStorage and so held per origin. With none set, an invitation names the
 * deployment's own server (`ownSignalingAddress` in `./signalingAddress.ts`).
 * An invitation already created, a saved exchange and an accepted invitation
 * keep the server they name, so a change here moves none of them.
 */

import { z } from "zod";

import {
  MAX_ENDPOINT_HOST_LENGTH,
  MAX_SIGNALING_SERVER_URL_LENGTH,
  maxCodeUnits,
  parseBoundedJson,
  publishedSignalingServerURL,
} from "@alcove/core";

/** The localStorage key the setting is written under. */
const STORAGE_KEY = "alcove-own-coordination-server";

/** The longest label, the text between two dots, a DNS host name may have. */
const MAX_HOST_LABEL_LENGTH = 63;

/** The stored value's schema version; a value under any other is refused. */
const SETTING_VERSION = 1;

const StoredCoordinationServerSchema = z.strictObject({
  version: z.literal(SETTING_VERSION),
  url: z.string().check(maxCodeUnits(MAX_SIGNALING_SERVER_URL_LENGTH)),
});

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

/** How reading the stored setting turned out. */
export type CoordinationServerRead =
  /** Nothing is stored, or this context has no storage. */
  | { kind: "none" }
  | { kind: "set"; url: string }
  /** A value is stored that this build or page refuses, or the browser
   * refuses access to its storage, so whether one is set is unknown. */
  | { kind: "unreadable" };

/**
 * This context's localStorage, or `undefined` where it has none (server
 * rendering).
 *
 * @throws where the browser refuses access to it (storage disabled).
 */
function storage(): Storage | undefined {
  const store: Storage | undefined = globalThis.localStorage;
  return store;
}

/** Read the stored coordination server, held again to
 * {@link parseCoordinationServerUrl} for a page served with `pageProtocol`. */
export function readCoordinationServerSetting(
  pageProtocol: string,
): CoordinationServerRead {
  let raw: string | null | undefined;
  try {
    raw = storage()?.getItem(STORAGE_KEY);
  } catch {
    return { kind: "unreadable" };
  }
  if (raw === null || raw === undefined) return { kind: "none" };
  try {
    const stored = StoredCoordinationServerSchema.parse(parseBoundedJson(raw));
    const entry = parseCoordinationServerUrl(stored.url, pageProtocol);
    if (!entry.ok || entry.url === undefined) return { kind: "unreadable" };
    return { kind: "set", url: entry.url };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * Store `url` as this browser's coordination server, or remove the setting
 * when it is undefined. `url` is one {@link parseCoordinationServerUrl}
 * returned.
 *
 * @throws if storage is unavailable or refuses the write.
 */
export function writeCoordinationServerSetting(url: string | undefined): void {
  const store = storage();
  if (store === undefined)
    throw new Error("this browser's storage is not available");
  if (url === undefined) {
    store.removeItem(STORAGE_KEY);
    return;
  }
  const value = StoredCoordinationServerSchema.parse({
    version: SETTING_VERSION,
    url,
  });
  store.setItem(STORAGE_KEY, JSON.stringify(value));
}
