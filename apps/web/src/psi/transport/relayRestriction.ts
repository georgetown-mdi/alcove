/**
 * This browser's relay restriction: the relays the run of an invitation it
 * creates may use, each an entry of core's `connection.allowed_relays` form
 * (`normalizeAllowedRelay`). Kept in localStorage beside the own relay setting,
 * and so held per origin. A saved exchange and an accepted invitation each
 * set their own list instead. Operator page: docs/EXCHANGE_REFERENCE.md,
 * connection.allowed_relays.
 */

import { z } from "zod";

import {
  ALLOWED_RELAY_FORM,
  maxCodeUnits,
  normalizeAllowedRelay,
  parseBoundedJson,
  sanitizeForDisplay,
} from "@alcove/core";

/** The localStorage key the setting is written under. */
const STORAGE_KEY = "alcove-relay-restriction";

/**
 * The stored value's schema version; a value under any other is treated as
 * none saved.
 */
const SETTING_VERSION = 1;

/**
 * How many allowed relays the list holds at most: an arbitrary working value,
 * the bound of each url list on the same page (`MAX_RELAY_URLS`).
 */
export const MAX_ALLOWED_RELAYS = 8;

/**
 * How long one entry may be, in UTF-16 code units: the bound of a url on the
 * same page (`MAX_RELAY_URL_LENGTH`), since an entry is part of a url.
 */
const MAX_ALLOWED_RELAY_LENGTH = 1024;

const StoredEntrySchema = z
  .string()
  .check(maxCodeUnits(MAX_ALLOWED_RELAY_LENGTH))
  .refine((entry) => normalizeAllowedRelay(entry) === entry, {
    message: "an allowed relay is not in its normalized form",
  });

const StoredRelayRestrictionSchema = z.strictObject({
  version: z.literal(SETTING_VERSION),
  allowedRelays: z
    .array(StoredEntrySchema)
    .min(1)
    .max(MAX_ALLOWED_RELAYS)
    .optional(),
});

/** Which relays a browser run may use. */
export interface RelayRestriction {
  /**
   * The relays a run may use; unset, every relay it lists. A run allocates
   * on, enrolls at and names in the invitations it creates only the TURN urls
   * an entry names (`turnUrlIsAllowed` in core).
   */
  allowedRelays?: ReadonlyArray<string>;
}

const UNRESTRICTED: RelayRestriction = {};

function storage(): Storage | undefined {
  try {
    const store: Storage | undefined = globalThis.localStorage;
    return store;
  } catch {
    return undefined;
  }
}

/**
 * Read the stored relay restriction. Nothing stored, storage that cannot be
 * read, and a stored value this build cannot read all restrict nothing.
 */
export function readRelayRestriction(): RelayRestriction {
  let raw: string | null | undefined;
  try {
    raw = storage()?.getItem(STORAGE_KEY);
  } catch {
    return UNRESTRICTED;
  }
  if (raw === null || raw === undefined) return UNRESTRICTED;
  try {
    const parsed = StoredRelayRestrictionSchema.parse(parseBoundedJson(raw));
    return parsed.allowedRelays === undefined
      ? UNRESTRICTED
      : { allowedRelays: parsed.allowedRelays };
  } catch {
    return UNRESTRICTED;
  }
}

/**
 * Store `restriction`, or remove the setting when it restricts nothing.
 *
 * @throws if an entry is not in its normalized form, a bound is exceeded, or
 *   storage refuses the write.
 */
export function writeRelayRestriction(restriction: RelayRestriction): void {
  const store = storage();
  if (store === undefined)
    throw new Error("this browser's storage is not available");
  if (restriction.allowedRelays === undefined) {
    store.removeItem(STORAGE_KEY);
    return;
  }
  const value = StoredRelayRestrictionSchema.parse({
    version: SETTING_VERSION,
    allowedRelays: [...restriction.allowedRelays],
  });
  store.setItem(STORAGE_KEY, JSON.stringify(value));
}

/** A refusal of the entered text: why, and the 1-based line it is about. */
export interface AllowedRelayProblem {
  line?: number;
  message: string;
}

/** What {@link parseAllowedRelayLines} made of the entered text. */
export type AllowedRelayLines =
  /** `entries` absent where no line names a relay: the setting is unset. */
  | { ok: true; entries?: Array<string> }
  | { ok: false; problems: Array<AllowedRelayProblem> };

function readAllowedRelayLines(
  text: string,
  maxEntryLength: number | undefined,
): AllowedRelayLines {
  const entries: Array<string> = [];
  const problems: Array<AllowedRelayProblem> = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    const entry =
      maxEntryLength !== undefined && line.length > maxEntryLength
        ? undefined
        : normalizeAllowedRelay(line);
    if (entry === undefined)
      problems.push({
        line: index + 1,
        message: `enter ${ALLOWED_RELAY_FORM}, with no turn: or turns: scheme`,
      });
    else if (!entries.includes(entry)) entries.push(entry);
  });
  if (problems.length > 0) return { ok: false, problems };
  return entries.length === 0 ? { ok: true } : { ok: true, entries };
}

/**
 * Read one allowed relay per line from `text` for this browser's stored
 * setting, skipping blank lines, each normalized as core's
 * `connection.allowed_relays` entry is, within the stored setting's bounds.
 * Every refused line is reported.
 */
export function parseAllowedRelayLines(text: string): AllowedRelayLines {
  const lines = readAllowedRelayLines(text, MAX_ALLOWED_RELAY_LENGTH);
  if (lines.ok && (lines.entries?.length ?? 0) > MAX_ALLOWED_RELAYS)
    return {
      ok: false,
      problems: [{ message: `enter at most ${MAX_ALLOWED_RELAYS} relays` }],
    };
  return lines;
}

/**
 * Read one allowed relay per line from `text` for an exchange's own
 * configuration: as {@link parseAllowedRelayLines}, under core's entry rule
 * alone, with no bound on how many entries or how long one is.
 */
export function parseExchangeAllowedRelayLines(
  text: string,
): AllowedRelayLines {
  return readAllowedRelayLines(text, undefined);
}

/**
 * The text that shows an allowed-relays list in the field, one entry per
 * line; empty where the list is unset or empty.
 */
export function allowedRelaysText(
  allowedRelays: ReadonlyArray<string> | undefined,
): string {
  return (allowedRelays ?? []).join("\n");
}

/**
 * The field error for a parse of the allowed relays, each problem prefixed
 * with its line where it names one, or `undefined` where the text parsed.
 */
export function allowedRelayLinesError(
  lines: AllowedRelayLines,
): string | undefined {
  if (lines.ok) return undefined;
  return lines.problems
    .map((problem) =>
      problem.line === undefined
        ? problem.message
        : `Line ${problem.line}: ${problem.message}`,
    )
    .join("; ");
}

// --- The words a run and the acceptance review use ---------------------------

/** The mark of a TURN url the setting keeps. */
export const KEPT_BY_ALLOWED_RELAYS = "kept by your allowed relays";

/** The mark of a TURN url the setting leaves out. */
export const LEFT_OUT_BY_ALLOWED_RELAYS = "left out by your allowed relays";

/** What this browser's stored setting decides, and what it does not. */
export const ALLOWED_RELAYS_SCOPE =
  "Your allowed relays decide which relays an invitation you create names, " +
  "and which relays its run connects through and enrolls at; a run still " +
  "registers each new key at its own relay's registrar whatever the " +
  "setting keeps. " +
  "Your partner's side can still connect through a relay you leave out. " +
  "That setting covers relay servers only: the STUN servers a run lists " +
  "are still contacted.";

/**
 * What a saved exchange's own allowed relays decide, and what they do not:
 * the counterpart of {@link ALLOWED_RELAYS_SCOPE} shown with the list on the
 * exchange's page.
 */
export const EXCHANGE_ALLOWED_RELAYS_SCOPE =
  "This exchange's allowed relays decide which relays its runs connect " +
  "through and enroll at, and which it names in the invitations it " +
  "creates; a run still registers each new key at its own relay's " +
  "registrar whatever the list keeps. " +
  "Your partner's side can still connect through a relay the list leaves " +
  "out. The list covers relay servers only: the STUN servers a run lists " +
  "are still contacted.";

/**
 * What an accepted invitation's allowed relays decide, and what they do not:
 * the counterpart of {@link EXCHANGE_ALLOWED_RELAYS_SCOPE} shown with the list
 * on the invitation's review.
 */
export const ACCEPTED_INVITATION_ALLOWED_RELAYS_SCOPE =
  "This exchange's allowed relays decide which relays its run connects " +
  "through and enrolls at; a run still registers each new key at its own " +
  "relay's registrar whatever the list keeps. " +
  "Your partner's side can still connect through a relay the list leaves " +
  "out. The list covers relay servers only: the STUN servers a run lists " +
  "are still contacted. Saving this exchange as a recurring exchange keeps " +
  "the list as its own.";

/**
 * The accepted invitation's review notice after Start met Allowed relays
 * edited since that step's Continue.
 */
export const ALLOWED_RELAYS_CHANGED_SINCE_CONTINUE =
  "Allowed relays changed since you pressed Continue, so the exchange did " +
  "not start. Press Continue to use them.";

/** What to do when a run that left relays out did not connect. */
export const ALLOWED_RELAYS_REMEDY =
  "To let a run try a relay left out, add its host to Allowed relays, or " +
  "remove the setting. A saved exchange sets them on its own page, an " +
  "invitation you accept on its review, and an invitation you create on the " +
  "Relay server page.";

function urlList(urls: ReadonlyArray<string>): string {
  return urls.map((url) => sanitizeForDisplay(url)).join(", ");
}

/**
 * The run notice a run shows when the setting is set: the TURN urls it keeps
 * and the ones it leaves out, escaped, since an invitation's are partner text.
 */
export function allowedRelaysRunNotice(
  kept: ReadonlyArray<string>,
  leftOut: ReadonlyArray<string>,
): string {
  const keeps =
    kept.length === 0 ? "keep no TURN url" : `keep ${urlList(kept)}`;
  const leaves =
    leftOut.length === 0 ? "leave out none" : `leave out ${urlList(leftOut)}`;
  return `Your allowed relays ${keeps} and ${leaves} for this run.`;
}
