import { getLogger, parseBoundedJson } from "@alcove/core";

import { invitationUsable } from "@psi/formatting";
import { whenDiagnostic } from "@utils/diagnostics";

/**
 * The invitations this browser created from the sample data, kept in
 * localStorage so the accept screen in any tab of this browser profile offers
 * the sample partner file for one of them and for no other invitation: the
 * invitation does not state whether its inviter used the sample. Each entry is
 * a SHA-256 digest of the encoded invitation and its expiry, never the
 * invitation or its secret; every read and write drops expired entries.
 */

const log = getLogger("sampleInvitationRecord");

/** The localStorage key the record is kept under. */
export const SAMPLE_INVITATIONS_STORAGE_KEY = "alcove-sample-invitations";

/** The record's schema version; a value under any other version is treated as
 * empty. */
const RECORD_VERSION = 1;

/** The most entries kept; a new entry past it displaces the oldest. */
const MAX_ENTRIES = 8;

/** The longest expiry string kept: an ISO 8601 instant is far shorter. */
const MAX_EXPIRES_LENGTH = 64;

interface Entry {
  digest: string;
  expires: string;
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The hex SHA-256 digest of `encoded`, or undefined where this context
 * cannot compute one. */
async function digestOf(encoded: string): Promise<string | undefined> {
  try {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(encoded),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch (error) {
    whenDiagnostic(() => log.warn("sample invitation digest failed:", error));
    return undefined;
  }
}

function isEntry(value: unknown): value is Entry {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const { digest, expires } = value as Record<string, unknown>;
  return (
    typeof digest === "string" &&
    /^[0-9a-f]{64}$/.test(digest) &&
    typeof expires === "string" &&
    expires.length <= MAX_EXPIRES_LENGTH
  );
}

/** The unexpired entries kept, oldest first; empty where none are kept or the
 * value does not read. Where the stored list holds any other entry, the kept
 * ones are written back in its place. */
function readEntries(now: Date): Array<Entry> {
  let raw: string | null;
  try {
    raw = storage()?.getItem(SAMPLE_INVITATIONS_STORAGE_KEY) ?? null;
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = parseBoundedJson(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const { v, entries } = parsed as Record<string, unknown>;
  if (v !== RECORD_VERSION || !Array.isArray(entries)) return [];
  const kept = entries
    .filter(isEntry)
    .filter((entry) => invitationUsable(entry.expires, now))
    .slice(-MAX_ENTRIES);
  if (kept.length !== entries.length) writeEntries(kept);
  return kept;
}

function writeEntries(entries: Array<Entry>): void {
  try {
    if (entries.length === 0)
      storage()?.removeItem(SAMPLE_INVITATIONS_STORAGE_KEY);
    else
      storage()?.setItem(
        SAMPLE_INVITATIONS_STORAGE_KEY,
        JSON.stringify({ v: RECORD_VERSION, entries }),
      );
  } catch (error) {
    whenDiagnostic(() => log.warn("sample invitation write failed:", error));
  }
}

/**
 * Note that this browser created the invitation `encoded`, which expires at
 * `expires`, from the sample data. Best-effort: a storage failure is
 * dev-logged and the accept screen then offers no sample.
 */
export async function recordSampleInvitation(
  encoded: string,
  expires: string,
  now: Date = new Date(),
): Promise<void> {
  if (!invitationUsable(expires, now)) return;
  const digest = await digestOf(encoded);
  if (digest === undefined) return;
  const kept = readEntries(now).filter((entry) => entry.digest !== digest);
  writeEntries([...kept, { digest, expires }].slice(-MAX_ENTRIES));
}

/** Whether this browser created the invitation `encoded` from the sample data
 * and that invitation has not expired. */
export async function createdFromSampleInThisBrowser(
  encoded: string,
  now: Date = new Date(),
): Promise<boolean> {
  const entries = readEntries(now);
  if (entries.length === 0) return false;
  const digest = await digestOf(encoded);
  return (
    digest !== undefined && entries.some((entry) => entry.digest === digest)
  );
}
