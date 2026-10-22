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
  MAX_SIGNALING_SERVER_URL_LENGTH,
  maxCodeUnits,
  parseBoundedJson,
  publishedSignalingServerURL,
} from "@alcove/core";

/** The localStorage key the setting is written under. */
const STORAGE_KEY = "alcove-own-coordination-server";

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
    `Enter the coordination server's ${scheme}:// address: a host, an ` +
    "optional port and path, and no user name, password, query, fragment " +
    `or percent sign. For example: ${scheme}://signaling.example.org/api/`
  );
}

/** The refusal of a web app's address, which names a coordination server
 * only through the file the app publishes. */
const WEB_APP_ADDRESS_NOTE = "A web app's address does not work here. ";

/**
 * Read a coordination server address from `text` for a page served with
 * `pageProtocol`: core's {@link publishedSignalingServerURL} rule, the one
 * the console and a build's own setting are held to, with the page's scheme
 * (`wss:` under `https`, `ws:` otherwise) and a port that can be dialed.
 * Blank text names none.
 */
export function parseCoordinationServerUrl(
  text: string,
  pageProtocol: string,
): CoordinationServerEntry {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true };
  const url = publishedSignalingServerURL(trimmed);
  if (
    url === undefined ||
    url.protocol !== `${schemeForPage(pageProtocol)}:` ||
    url.port === "0"
  )
    return {
      ok: false,
      message:
        (/^https?:\/\//i.test(trimmed) ? WEB_APP_ADDRESS_NOTE : "") +
        coordinationServerFormMessage(pageProtocol),
    };
  return { ok: true, url: url.href };
}

/** How reading the stored setting turned out. */
export type CoordinationServerRead =
  /** Nothing is stored, or storage is unreachable. */
  | { kind: "none" }
  | { kind: "set"; url: string }
  /** A value is stored that this build or page refuses. */
  | { kind: "unreadable" };

/** This context's localStorage, or `undefined` where it has none or refuses
 * access (server rendering, storage disabled). */
function storage(): Storage | undefined {
  try {
    const store: Storage | undefined = globalThis.localStorage;
    return store;
  } catch {
    return undefined;
  }
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
    return { kind: "none" };
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
