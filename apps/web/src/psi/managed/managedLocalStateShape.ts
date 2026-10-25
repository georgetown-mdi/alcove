/**
 * The shape and validation of a managed exchange's local sibling state -- the pure,
 * IndexedDB-free half of {@link ./managedLocalState.ts}. It is a separate module so
 * both the sibling-state IDB layer and the record store's rotation write (which
 * clears the backup marker in the same cross-store transaction) can validate the
 * sibling entry without an import cycle: the record store cannot import the sibling
 * IDB layer, which already imports the store for its database handle.
 *
 * The sibling state is validated on every read and write through
 * {@link managedLocalStateSchema} with the same reader-rejects-unknown discipline
 * the record store follows, so a corrupted or app-upgrade-invalidated entry rejects
 * loudly rather than loading.
 */

import { z } from "zod";

import { LinkageTermsSchema, maxCodeUnits } from "@alcove/core";

import type {
  LinkageTerms,
  PartnerDeduplicateChange,
  PayloadColumnsChange,
} from "@alcove/core";
import type {
  ManagedBackupLocation,
  ManagedBackupMarker,
} from "./managedBackupState";
import type { ZodType } from "zod";

/** This device's import marker for a record: stamped when the record was installed
 * from a backup artifact or a command-line pair, or completed by a pair.
 * It is the evidence the desync tiering reads to tell an import-since-last-success
 * apart from an unexplained handshake failure: an imported copy can hold a secret
 * the partnership has rotated past, so a handshake failure after an import newer
 * than the last success is the benign import/restore tier, not the attack path. A
 * plain instant -- no secret material, no rotation epoch -- and a local sibling by
 * design: it is this device's own restore history, meaningless to an imported
 * copy, so it must never enter the export artifact. */
export interface ManagedImportMarker {
  /** ISO 8601 UTC instant the record was installed or completed. */
  importedAt: string;
}

/** One direction's changed payload columns, as a stored terms proposal keeps
 * them. */
export type ManagedStoredColumnsChange = PayloadColumnsChange;

/**
 * The partner terms change an unattended run refused, kept for the operator's
 * next visit to apply or decline: when the run met it, the partner's terms as
 * they crossed the wire, and how they differ from the stored exchange's
 * (core's `TermsDelta`, each part present where it differs). It holds the
 * partner's column names and diagnostics raw, as the run received them; the
 * run surface escapes them where it shows them. A local sibling rather than a
 * record field: it is this device's pending decision, not a term of the
 * partnership, and an older build reading a record that held it would drop it.
 */
export interface ManagedTermsProposal {
  /** ISO 8601 UTC instant the run refused the change. */
  proposedAt: string;
  partnerTerms: LinkageTerms;
  delta: {
    received?: ManagedStoredColumnsChange;
    sent?: ManagedStoredColumnsChange;
    partnerDeduplicate?: PartnerDeduplicateChange;
    otherTerms: Array<string>;
  };
}

/** The local sibling state for a record: the optional backup marker, the optional
 * import marker, and the optional terms proposal, each present independently. An
 * entry with none is meaningless and never written (a cleared state deletes the
 * entry). */
export interface ManagedLocalState {
  /** When a backup was last taken (see {@link ManagedBackupMarker}); absent until
   * the first export. */
  backup?: ManagedBackupMarker;
  /** When this device installed or completed the record from imported
   * files (see {@link ManagedImportMarker}); absent for a record created by an
   * invite/accept deposit and not imported since. */
  imported?: ManagedImportMarker;
  /** The partner terms change the last unattended run refused (see
   * {@link ManagedTermsProposal}); absent when none is pending. */
  termsProposal?: ManagedTermsProposal;
}

const storedColumnsChangeSchema: ZodType<ManagedStoredColumnsChange> = z
  .object({ added: z.array(z.string()), removed: z.array(z.string()) })
  .strict();

/** The terms proposal's own validator, reader-rejects-unknown like the rest of
 * the entry. A write validates the proposal with it before storing it. */
export const managedTermsProposalSchema: ZodType<ManagedTermsProposal> = z
  .object({
    proposedAt: z.iso.datetime(),
    partnerTerms: LinkageTermsSchema,
    delta: z
      .object({
        received: storedColumnsChangeSchema.optional(),
        sent: storedColumnsChangeSchema.optional(),
        partnerDeduplicate: z
          .object({ expected: z.boolean(), presented: z.boolean() })
          .strict()
          .optional(),
        otherTerms: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

/** The longest folder or file name a backup location holds: the common
 * file-system limit on one path component. */
const MAX_BACKUP_LOCATION_NAME_LENGTH = 255;

const backupLocationNameSchema = z
  .string()
  .min(1)
  .check(maxCodeUnits(MAX_BACKUP_LOCATION_NAME_LENGTH));

/** Whether `name` fits the bound a stored backup location's names hold to. */
export function backupLocationNameFits(name: string): boolean {
  return backupLocationNameSchema.safeParse(name).success;
}

const backupLocationSchema: ZodType<ManagedBackupLocation> = z.union([
  z
    .object({
      kind: z.literal("downloaded"),
      fileName: backupLocationNameSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("folder"),
      folderName: backupLocationNameSchema.optional(),
      fileName: backupLocationNameSchema,
    })
    .strict(),
]);

/**
 * The sibling-state validator: reader-rejects-unknown at every level, so a
 * corrupted or app-upgrade-invalidated entry rejects rather than loading. The
 * one exception is the terms proposal, validated on its own: one that does
 * not parse is dropped and the entry loads without it, so a proposal core's
 * terms schema no longer accepts cannot take the backup and import markers
 * down with it.
 */
export const managedLocalStateSchema: ZodType<ManagedLocalState> = z
  .object({
    termsProposal: z.unknown().optional(),
    backup: z
      .object({
        backedUpAt: z.iso.datetime(),
        savedAs: backupLocationSchema.optional(),
      })
      .strict()
      .optional(),
    imported: z.object({ importedAt: z.iso.datetime() }).strict().optional(),
  })
  .strict()
  .transform(({ termsProposal, ...markers }): ManagedLocalState => {
    if (termsProposal === undefined) return markers;
    const proposal = managedTermsProposalSchema.safeParse(termsProposal);
    return proposal.success
      ? { ...markers, termsProposal: proposal.data }
      : markers;
  });

/**
 * Parse and validate a value read from the sibling store as a
 * {@link ManagedLocalState}. Throws on an unknown key or a malformed instant rather
 * than silently accepting -- the reader-rejects-unknown rule -- except inside the
 * terms proposal, which is dropped instead ({@link managedLocalStateSchema}).
 *
 * @throws {ZodError} if the value is not valid local state.
 */
export function parseManagedLocalState(raw: unknown): ManagedLocalState {
  return managedLocalStateSchema.parse(raw);
}

/** The sibling entries a per-entry read could parse, and the stored keys of
 * those it could not. */
export interface ManagedReadableLocalState {
  /** Each parsed entry, keyed by the record id it is stored under. */
  states: Map<string, ManagedLocalState>;
  /** The stored keys of the entries that did not parse. */
  unreadableIds: Array<string>;
}

/**
 * Partition a sibling store's parallel key and value arrays into the entries
 * that parse and the keys of those that do not: the tolerant counterpart of
 * mapping {@link parseManagedLocalState} over the values, for the unattended
 * read (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Every admitted schedule
 * renders"). Never throws.
 */
export function partitionReadableManagedLocalState(
  keys: ReadonlyArray<IDBValidKey>,
  values: ReadonlyArray<unknown>,
): ManagedReadableLocalState {
  const states = new Map<string, ManagedLocalState>();
  const unreadableIds: Array<string> = [];
  for (let index = 0; index < keys.length; index += 1) {
    const parsed = managedLocalStateSchema.safeParse(values[index]);
    if (parsed.success) states.set(String(keys[index]), parsed.data);
    else unreadableIds.push(String(keys[index]));
  }
  return { states, unreadableIds };
}
