/**
 * This browser's own SFTP relay: the `wss://` url a user names, used in place
 * of the SFTP relay an invitation names, kept in localStorage and so held per
 * origin. The url is held to the rule an
 * invitation's is (core's `sftpRelayUrlRefusal`,
 * docs/spec/INVITATION_TOKEN.md#the-sftp-relay-url).
 */

import { z } from "zod";

import {
  MAX_SFTP_RELAY_URL_LENGTH,
  maxCodeUnits,
  parseBoundedJson,
  sftpRelayUrlRefusal,
} from "@alcove/core";

/** The localStorage key the setting is written under. */
const STORAGE_KEY = "alcove-own-sftp-relay";

/** The stored value's schema version; a value under any other is refused. */
const SETTING_VERSION = 1;

/** The field's name in a refusal's message. */
const SETTING_NAME = "The SFTP relay url";

const StoredSftpRelaySchema = z.strictObject({
  version: z.literal(SETTING_VERSION),
  url: z.string().check(maxCodeUnits(MAX_SFTP_RELAY_URL_LENGTH)),
});

/** What {@link parseSftpRelayUrl} made of the entered text. */
export type SftpRelayEntry =
  /** `url` absent where the text is blank: none set. */
  { ok: true; url?: string } | { ok: false; message: string };

/**
 * Read an SFTP relay url from `text` under core's rule, with core's message
 * for a refusal. Leading and trailing whitespace is trimmed; blank text names
 * none.
 */
export function parseSftpRelayUrl(text: string): SftpRelayEntry {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true };
  const refusal = sftpRelayUrlRefusal(trimmed, SETTING_NAME);
  return refusal === undefined
    ? { ok: true, url: trimmed }
    : { ok: false, message: refusal.message };
}

/** How reading the stored setting turned out. */
export type SftpRelayRead =
  /** Nothing is stored, or this context has no storage. */
  | { kind: "none" }
  | { kind: "set"; url: string }
  /** A value is stored that this build refuses, or the browser refuses
   * access to its storage, so whether one is set is unknown. */
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

/**
 * Read the stored SFTP relay, its url judged as stored (no trimming) by
 * core's rule.
 */
export function readSftpRelaySetting(): SftpRelayRead {
  let raw: string | null | undefined;
  try {
    raw = storage()?.getItem(STORAGE_KEY);
  } catch {
    return { kind: "unreadable" };
  }
  if (raw === null || raw === undefined) return { kind: "none" };
  try {
    const stored = StoredSftpRelaySchema.parse(parseBoundedJson(raw));
    if (sftpRelayUrlRefusal(stored.url, SETTING_NAME) !== undefined)
      return { kind: "unreadable" };
    return { kind: "set", url: stored.url };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * Store `url` as this browser's SFTP relay, or remove the setting when it is
 * undefined. `url` is judged exactly as given, so text pasted with
 * surrounding whitespace is trimmed by {@link parseSftpRelayUrl} first.
 *
 * @throws the {@link SftpRelayUrlError} core's rule gives for a refused `url`,
 * naming its `problem`, with nothing stored; or an error if storage is
 * unavailable or refuses the write.
 */
export function writeSftpRelaySetting(url: string | undefined): void {
  const store = storage();
  if (store === undefined)
    throw new Error("this browser's storage is not available");
  if (url === undefined) {
    store.removeItem(STORAGE_KEY);
    return;
  }
  const refusal = sftpRelayUrlRefusal(url, SETTING_NAME);
  if (refusal !== undefined) throw refusal;
  const value = StoredSftpRelaySchema.parse({ version: SETTING_VERSION, url });
  store.setItem(STORAGE_KEY, JSON.stringify(value));
}

/** The SFTP relay an exchange dials, and where it came from. */
export type SftpRelayForExchange =
  | { kind: "own"; url: string }
  | { kind: "invitation"; url: string }
  /** Neither this browser nor the invitation names one. */
  | { kind: "none" }
  /** This browser's setting cannot be read, so whether it replaces the
   * invitation's is unknown and neither is chosen. */
  | { kind: "unreadable" };

/**
 * The SFTP relay a browser exchange over an invitation naming
 * `invitationRelayUrl` dials: this browser's own where one is set, which
 * replaces the invitation's, otherwise the invitation's. The invitation's url
 * passed the same rule at decode.
 */
export function sftpRelayForExchange(
  invitationRelayUrl: string | undefined,
  read: () => SftpRelayRead = readSftpRelaySetting,
): SftpRelayForExchange {
  const own = read();
  if (own.kind === "set") return { kind: "own", url: own.url };
  if (own.kind === "unreadable") return { kind: "unreadable" };
  return invitationRelayUrl !== undefined
    ? { kind: "invitation", url: invitationRelayUrl }
    : { kind: "none" };
}
