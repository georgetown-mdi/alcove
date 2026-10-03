import { useEffect, useRef } from "react";

import {
  decodeInvitation,
  getLogger,
  parseBoundedJson,
  safeParseMetadata,
  safeParseStandardization,
} from "@alcove/core";

import { invitationUsable } from "@psi/formatting";
import { loadCSVFileOffMainThread } from "@psi/workers/csvParseController";
import { whenDiagnostic } from "@utils/diagnostics";

import type {
  Metadata,
  OwnColumnSelection,
  Standardization,
} from "@alcove/core";
import type { GeneratedInvitation } from "@psi/invitation";
import type { RunFailure } from "./useInviterExchange";
import type { RunOutputs } from "@psi/runOutputs";

/**
 * The invitation a browser inviter is waiting on, kept in this tab's
 * sessionStorage so a reload can wait on it again. It holds the encoded
 * invitation (and with it the shared secret) and this party's own settings for
 * the run, never a row of the file: a resume reads the file again. Every read
 * re-validates it, and removes an entry that is malformed or expired.
 */

const log = getLogger("pendingInvitation");

/** The sessionStorage key the entry is written under. */
const STORAGE_KEY = "alcove-pending-invitation";

/** The entry's schema version; any other version is treated as absent. */
const RECORD_VERSION = 2;

/** What a resume needs beside the file the operator chooses again. */
export interface PendingInvitation {
  /** The invitation as it was minted, less the file rows. */
  invitation: Omit<GeneratedInvitation, "rawRows">;
  /** The name the inviter gave, which signs the message offered for sharing. */
  inviterName: string;
  /** The name of the file the invitation was created from. */
  fileName: string;
  /** The number of data rows that file held. */
  rowCount: number;
  /** The field delimiter that file was read by; absent for a comma. */
  csvDelimiter?: string;
}

interface StoredRecord {
  v: typeof RECORD_VERSION;
  encoded: string;
  deepLink: string;
  inviterName: string;
  fileName: string;
  columns: Array<string>;
  rowCount: number;
  csvDelimiter?: string;
  metadata?: Metadata;
  standardization?: Standardization;
  includeOwnColumns?: OwnColumnSelection;
}

function storage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Keep `invitation` for a resume, best-effort: a storage failure is
 * dev-logged and the run goes on without a resume.
 */
export function writePendingInvitation(
  invitation: GeneratedInvitation,
  context: { inviterName: string; fileName: string; csvDelimiter?: string },
): void {
  const record: StoredRecord = {
    v: RECORD_VERSION,
    encoded: invitation.encoded,
    deepLink: invitation.deepLink,
    inviterName: context.inviterName,
    fileName: context.fileName,
    columns: invitation.columns,
    rowCount: invitation.rawRows.length,
    ...(context.csvDelimiter !== undefined
      ? { csvDelimiter: context.csvDelimiter }
      : {}),
    ...(invitation.metadata !== undefined
      ? { metadata: invitation.metadata }
      : {}),
    ...(invitation.standardization !== undefined
      ? { standardization: invitation.standardization }
      : {}),
    ...(invitation.includeOwnColumns !== undefined
      ? { includeOwnColumns: invitation.includeOwnColumns }
      : {}),
  };
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch (error) {
    whenDiagnostic(() => log.warn("pending invitation write failed:", error));
  }
}

/** Remove the kept invitation, best-effort. */
export function clearPendingInvitation(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch (error) {
    whenDiagnostic(() => log.warn("pending invitation clear failed:", error));
  }
}

function isStringArray(value: unknown): value is Array<string> {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/** The stored fields, or undefined where any is missing or malformed. */
function storedRecordOf(value: unknown): StoredRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const fields = value as Record<string, unknown>;
  const { v, encoded, deepLink, inviterName, fileName, columns, rowCount } =
    fields;
  if (v !== RECORD_VERSION) return undefined;
  if (typeof encoded !== "string" || typeof deepLink !== "string")
    return undefined;
  if (!deepLink.endsWith(`#${encoded}`)) return undefined;
  if (typeof inviterName !== "string" || typeof fileName !== "string")
    return undefined;
  if (!isStringArray(columns) || columns.length === 0) return undefined;
  if (
    typeof rowCount !== "number" ||
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0
  )
    return undefined;
  const { csvDelimiter, includeOwnColumns } = fields;
  if (csvDelimiter !== undefined && typeof csvDelimiter !== "string")
    return undefined;
  if (
    includeOwnColumns !== undefined &&
    includeOwnColumns !== "disclosed" &&
    includeOwnColumns !== "all"
  )
    return undefined;
  let metadata: Metadata | undefined;
  if (fields.metadata !== undefined) {
    const parsed = safeParseMetadata(fields.metadata);
    if (!parsed.success) return undefined;
    metadata = parsed.data;
  }
  let standardization: Standardization | undefined;
  if (fields.standardization !== undefined) {
    const parsed = safeParseStandardization(fields.standardization);
    if (!parsed.success) return undefined;
    standardization = parsed.data;
  }
  return {
    v,
    encoded,
    deepLink,
    inviterName,
    fileName,
    columns,
    rowCount,
    ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(standardization !== undefined ? { standardization } : {}),
    ...(includeOwnColumns !== undefined ? { includeOwnColumns } : {}),
  };
}

/**
 * The kept invitation, or undefined where none is kept, it no longer reads, or
 * it has expired. An entry that does not read or has expired is removed.
 */
export async function readPendingInvitation(
  now: Date,
): Promise<PendingInvitation | undefined> {
  let raw: string | null;
  try {
    raw = storage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  const record = await pendingInvitationOf(raw, now);
  if (record === undefined) clearPendingInvitation();
  return record;
}

async function pendingInvitationOf(
  raw: string,
  now: Date,
): Promise<PendingInvitation | undefined> {
  let stored: StoredRecord | undefined;
  try {
    stored = storedRecordOf(parseBoundedJson(raw));
  } catch {
    return undefined;
  }
  if (stored === undefined) return undefined;
  let token;
  try {
    token = await decodeInvitation(stored.encoded);
  } catch {
    return undefined;
  }
  const { expires } = token;
  if (expires === undefined || !invitationUsable(expires, now))
    return undefined;
  return {
    invitation: {
      encoded: stored.encoded,
      deepLink: stored.deepLink,
      sharedSecret: token.sharedSecret,
      expires,
      linkageTerms: token.linkageTerms,
      columns: stored.columns,
      ...(stored.metadata !== undefined ? { metadata: stored.metadata } : {}),
      ...(stored.standardization !== undefined
        ? { standardization: stored.standardization }
        : {}),
      ...(stored.includeOwnColumns !== undefined
        ? { includeOwnColumns: stored.includeOwnColumns }
        : {}),
    },
    inviterName: stored.inviterName,
    fileName: stored.fileName,
    rowCount: stored.rowCount,
    ...(stored.csvDelimiter !== undefined
      ? { csvDelimiter: stored.csvDelimiter }
      : {}),
  };
}

/** What reading the file chosen again for a resume found. */
export type ResumeFileOutcome =
  | { kind: "resumed"; invitation: GeneratedInvitation }
  /** The file could not be read, or its parse reported a fault. */
  | { kind: "unreadable" }
  /** The file's columns, in order, or its number of rows differ from the
   * file the invitation was created from. */
  | { kind: "mismatch" };

/**
 * Read the file the operator chose again, by the delimiter the invitation's
 * file was read by, and resume the kept invitation on its rows only where it
 * has the same columns in the same order and the same number of rows: the
 * invitation's terms and this party's settings name those columns.
 */
export async function resumeFromChosenFile(
  pending: PendingInvitation,
  file: Parameters<typeof loadCSVFileOffMainThread>[0],
): Promise<ResumeFileOutcome> {
  let result;
  try {
    result = await loadCSVFileOffMainThread(file, {
      ...(pending.csvDelimiter !== undefined
        ? { delimiter: pending.csvDelimiter }
        : {}),
    });
  } catch (error) {
    whenDiagnostic(() => log.warn("resume file read failed:", error));
    return { kind: "unreadable" };
  }
  // A single-column file reports UndetectableDelimiter, and the invitation's
  // own read accepted it; any other code is a fault.
  if (result.errors.some((error) => error.code !== "UndetectableDelimiter"))
    return { kind: "unreadable" };
  const columns = result.meta.fields ?? [];
  const expected = pending.invitation.columns;
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => column !== expected[index]) ||
    result.data.length !== pending.rowCount
  )
    return { kind: "mismatch" };
  return {
    kind: "resumed",
    invitation: { ...pending.invitation, rawRows: result.data },
  };
}

/**
 * Keep the live browser run's invitation for a resume while it can still be
 * waited on: written when the invitation is set, removed when the run
 * completes, when it fails in a way the same invitation cannot retry, when
 * the invitation expires, and when the screen drops the invitation. Leaving
 * the screen keeps it, so coming back offers the resume.
 */
export function usePendingInvitationRecord({
  invitation,
  context,
  outputs,
  failure,
}: {
  /** The invitation to keep, or undefined where nothing is kept: no
   * invitation, or a run this record does not cover. */
  invitation: GeneratedInvitation | undefined;
  context: { inviterName: string; fileName: string; csvDelimiter?: string };
  outputs: RunOutputs | undefined;
  failure: RunFailure | undefined;
}): void {
  const contextRef = useRef(context);
  contextRef.current = context;
  const kept = useRef<GeneratedInvitation | undefined>(undefined);
  useEffect(() => {
    if (invitation === undefined) {
      if (kept.current !== undefined) clearPendingInvitation();
      kept.current = undefined;
      return;
    }
    kept.current = invitation;
    writePendingInvitation(invitation, contextRef.current);
    const remainingMs = Date.parse(invitation.expires) - Date.now();
    if (remainingMs > MAX_TIMER_MS) return;
    const timer = setTimeout(clearPendingInvitation, Math.max(0, remainingMs));
    return () => clearTimeout(timer);
  }, [invitation]);
  const finished =
    invitation !== undefined &&
    (outputs !== undefined ||
      (failure !== undefined &&
        (failure.retry !== "offered" ||
          !invitationUsable(invitation.expires, new Date()))));
  useEffect(() => {
    if (finished) clearPendingInvitation();
  }, [finished]);
}

/** The longest delay `setTimeout` holds; an expiry further out is removed on
 * the read after it instead. */
const MAX_TIMER_MS = 2 ** 31 - 1;
