/**
 * The managed-exchange export/import artifact: the plaintext credential file that
 * is the durability backbone against silent browser-storage eviction and the
 * device-migration path (see docs/MANAGED_EXCHANGE.md, "Surviving storage
 * eviction", and docs/spec/MANAGED_EXCHANGE_RECORD.md, "Export artifact"). This
 * module is the pure, platform-free half: it encodes a stored
 * {@link ManagedExchangeRecord} to the artifact and parses an untrusted artifact
 * back to a runnable record, so the format and its trust boundary are unit-testable
 * without a database or a download.
 *
 * The artifact is the browser analog of handing over `alcove.yaml` plus
 * `.alcove.key` together, kept CLI-separable rather than becoming a third format:
 *
 * - `exchangeDocument` embeds the exchange-file document as a valid `alcove.yaml`,
 *   written by core's `serializeExchangeDocument` -- the writer Alcove's own
 *   `saveConfig` uses, so the embedded half is the file the CLI would write;
 * - `key` is the `.alcove.key` pair -- `sharedSecret` and, when a bound is in
 *   force, `expires`, and any pending relay key registration -- so the secret
 *   half maps onto a valid key file;
 * - `local` holds the record fields the two CLI artifacts do not (`label`,
 *   `side`, `schedule`, `lastRun`, `standingCondition`, `tokenMaxAgeDays`, the
 *   relay registrar and the reason a pending registration has, and a marker
 *   saying the source held a working folder), cleanly separable and ignorable
 *   by the CLI toolchain.
 *
 * `recentRuns` is left out: it is the list of earlier outcomes this device's
 * page shows, and an imported record starts it again from the `lastRun` the
 * artifact holds.
 *
 * The working-folder handle is absent by design (a device- and profile-local
 * platform object with no file serialization), so the folder is granted again
 * after an import. What the artifact does hold is a marker saying the source
 * record had one, which is all an import needs to tell the operator to take the
 * grant again here. No secret-derived value and no
 * rotation epoch is written: the artifact snapshots the secret current at export
 * and holds no history (see the spec's "No anti-rollback").
 *
 * Import is a trust boundary: the artifact is untrusted structured input, so the
 * whole document is parsed through the shared sensitive-JSON chokepoint (bounded,
 * path-only errors) and then a strict reader-rejects-unknown schema, and the
 * reconstructed record is re-validated through {@link parseManagedExchangeRecord}
 * before it is a record. A malformed or tampered artifact is rejected by throwing;
 * a caller installs nothing on a rejection, so a bad import cannot corrupt the
 * store.
 */

import {
  RelayRegistrarSchema,
  parseExchangeSpec,
  parseSensitiveJson,
  parseSensitiveYaml,
  serializeExchangeDocument,
} from "@alcove/core";

import { z } from "zod";

import {
  MANAGED_EXCHANGE_ARTIFACT_VERSION,
  MANAGED_EXCHANGE_PREVIOUS_ARTIFACT_VERSION,
  buildManagedExchangeRecord,
  keyPairFieldsSchema,
  lastRunSchema,
  parseManagedExchangeRecord,
  raisedStandingCondition,
  scheduleSchema,
  standingConditionSchema,
  tokenMaxAgeDaysSchema,
} from "./managedExchangeRecord";
import { refuseDocumentNotHeld } from "./managedCommandLineImport";

import type { ExchangeSpec, RelayRegistrar } from "@alcove/core";
import type {
  ManagedExchangeKeyPair,
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
  ManagedExchangeSide,
  ManagedRelayRegistrationPendingReason,
  ManagedStandingCondition,
  RunnableManagedExchangeRecord,
} from "./managedExchangeRecord";
import type { ZodType } from "zod";

/** The MIME type the artifact downloads as; it is a JSON document. */
export const MANAGED_EXCHANGE_ARTIFACT_MIME = "application/json";

/** Upper bound, in bytes, on an artifact file the web import path will read,
 * applied before {@link parseSensitiveJson}'s own bounded parse. Mirrors the
 * linkage-terms import's fixed pre-parse cap. */
export const MAX_ARTIFACT_IMPORT_BYTES = 1_000_000;

/** The record fields the artifact holds alongside the two CLI halves -- the
 * fields the CLI's config-plus-key pair does not have. Cleanly separable and
 * ignorable by the CLI toolchain. */
interface ManagedExchangeArtifactLocal {
  /** The operator's display label. */
  label: string;
  /** This party's side of the partnership, dispatching a re-run. */
  side: ManagedExchangeSide;
  /** The agreed run schedule, when saved as recurring. */
  schedule?: ManagedExchangeSchedule;
  /** The run bookkeeping retained from the imported record. */
  lastRun?: ManagedExchangeLastRun;
  /** The standing condition the source record held, with the operator's answer
   * to it where one was given; omitted where none stood. Both travel because an
   * export that dropped either would be a fourth way to clear a condition, and
   * only the operator's acknowledgement, a re-invite, and a delete may. */
  standingCondition?: ManagedStandingCondition;
  /** The max-token-age policy, when the operator opted in. */
  tokenMaxAgeDays?: number;
  /** The relay registrar the source record registered at. */
  relayRegistrar?: RelayRegistrar;
  /** Why no run can confirm the pending relay registration the key block
   * holds, where the source record held a reason beside it. */
  relayRegistrationPendingReason?: ManagedRelayRegistrationPendingReason;
  /** Read and never written: an artifact from a build that held a separate
   * input-file pointer sets it, and an import reads it as a held working folder,
   * since the folder is what the operator takes again here. */
  heldInputFile?: boolean;
  /** Whether the source record held a working-folder grant. Omitted rather than
   * written `false`, matching the artifact's other optional fields; the handle
   * itself cannot be written at all. */
  heldOutputFolder?: boolean;
}

/** A pointer to somewhere on this device that a record can hold and an artifact
 * cannot: the exchange's working folder, a File System Access handle taken by a
 * picker under an operator gesture and stored by structured clone, so a record
 * restored on another browser profile holds none until the operator takes it
 * again there. */
export type ManagedPlatformGrant = "working-folder";

/**
 * The export artifact: a version tag, the embedded `alcove.yaml` document as
 * text, the `.alcove.key` pair, and the separable local fields. Neither platform
 * handle is a member (no file serialization; see the module header).
 */
interface ManagedExchangeArtifact {
  /** The single recognized artifact-format literal; a reader rejects any other
   * value rather than migrating it. */
  artifactVersion: typeof MANAGED_EXCHANGE_ARTIFACT_VERSION;
  /** The exchange-file document embedded as a valid `alcove.yaml` (snake_case
   * YAML). The CLI half of the record. */
  exchangeDocument: string;
  /** The `.alcove.key` pair (see {@link ManagedExchangeKeyPair}). */
  key: ManagedExchangeKeyPair;
  /** The browser-only fields (see {@link ManagedExchangeArtifactLocal}). */
  local: ManagedExchangeArtifactLocal;
}

/**
 * Derive the `.alcove.key` pair from a record: the current shared secret, the
 * `expires` it lapses at when a bound is in force, and the pending relay key
 * registration when one is recorded. The one place a record's secret half
 * becomes the key file's fields, shared by the artifact's `key` block and the
 * CLI cron export's key file so neither can grow a field the other lacks. An
 * absent field is an omitted key, never an explicit `undefined` a serialize
 * step would render.
 */
export function keyFileFieldsFromRecord(
  record: RunnableManagedExchangeRecord,
): ManagedExchangeKeyPair {
  return {
    sharedSecret: record.sharedSecret,
    ...(record.expires !== undefined ? { expires: record.expires } : {}),
    ...(record.relayRegistrationPendingSince !== undefined
      ? { relayRegistrationPendingSince: record.relayRegistrationPendingSince }
      : {}),
  };
}

/**
 * Encode a stored record as the export artifact (see
 * {@link serializeExchangeDocument} for the embedded document). The
 * working-folder handle is dropped -- it does not serialize, so a record imported
 * from this artifact re-grants the folder -- and leaves behind a marker in
 * `local` recording that the source held it, so an import can name the grant to
 * take again. The record's `id` is not included either, since an import
 * mints a fresh local record rather than copying this one.
 */
export function encodeManagedExchangeArtifact(
  record: RunnableManagedExchangeRecord,
): ManagedExchangeArtifact {
  const standing = raisedStandingCondition(record);
  return {
    artifactVersion: MANAGED_EXCHANGE_ARTIFACT_VERSION,
    exchangeDocument: serializeExchangeDocument(record.exchangeFile),
    key: keyFileFieldsFromRecord(record),
    local: {
      label: record.label,
      side: record.side,
      ...(record.schedule !== undefined ? { schedule: record.schedule } : {}),
      ...(record.lastRun !== undefined ? { lastRun: record.lastRun } : {}),
      ...(standing !== undefined ? { standingCondition: standing } : {}),
      ...(record.tokenMaxAgeDays !== undefined
        ? { tokenMaxAgeDays: record.tokenMaxAgeDays }
        : {}),
      ...(record.relayRegistrar !== undefined
        ? { relayRegistrar: record.relayRegistrar }
        : {}),
      ...(record.relayRegistrationPendingReason !== undefined
        ? {
            relayRegistrationPendingReason:
              record.relayRegistrationPendingReason,
          }
        : {}),
      ...(record.workingDirectoryHandle !== undefined
        ? { heldOutputFolder: true }
        : {}),
    },
  };
}

/**
 * Serialize the artifact to the plaintext file bytes the operator holds outside the
 * browser. Pretty-printed JSON with a trailing newline, matching the CLI key file's
 * on-disk formatting.
 */
export function serializeManagedExchangeArtifact(
  artifact: ManagedExchangeArtifact,
): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

/** The local block's validator: reader-rejects-unknown (strict), reusing the
 * schemas the record validates `schedule`, `lastRun`, `standingCondition`,
 * `tokenMaxAgeDays`, and the relay registrar with, so the artifact cannot be
 * laxer than the record it reconstructs -- a tampered artifact with
 * `intervalDays: 0` is rejected here exactly as a stored record would be, not
 * merely at the reconstructed record's later re-validation.
 * The condition's own schema is strict too, so a member nested inside it is
 * refused rather than dropped from the reconstructed record. */
const artifactLocalSchema: ZodType<ManagedExchangeArtifactLocal> = z
  .object({
    label: z.string(),
    side: z.enum(["inviter", "acceptor"]),
    schedule: scheduleSchema.optional(),
    lastRun: lastRunSchema.optional(),
    standingCondition: standingConditionSchema.optional(),
    tokenMaxAgeDays: tokenMaxAgeDaysSchema.optional(),
    relayRegistrar: RelayRegistrarSchema.optional(),
    relayRegistrationPendingReason: z.literal("reinvite").optional(),
    heldInputFile: z.boolean().optional(),
    heldOutputFolder: z.boolean().optional(),
  })
  .strict();

/** The whole-artifact validator: reader-rejects-unknown at the top level and on
 * the key and local blocks, with the embedded document parsed separately (it is
 * YAML text, validated through {@link parseExchangeSpec} in
 * {@link parseManagedExchangeArtifact}). A pending registration's reason is held
 * only beside the key block's marker and the local block's registrar, as the
 * record holds it, so a backup holding it alone is refused whole. */
const artifactSchema: ZodType<ManagedExchangeArtifact> = z
  .object({
    artifactVersion: z.literal(MANAGED_EXCHANGE_ARTIFACT_VERSION),
    exchangeDocument: z.string(),
    key: keyPairFieldsSchema,
    local: artifactLocalSchema,
  })
  .strict()
  .refine(
    (artifact) =>
      artifact.local.relayRegistrationPendingReason === undefined ||
      (artifact.key.relayRegistrationPendingSince !== undefined &&
        artifact.local.relayRegistrar !== undefined),
    {
      message:
        "local.relayRegistrationPendingReason is held only beside " +
        "key.relayRegistrationPendingSince and local.relayRegistrar",
    },
  );

/** Raised when a backup file holds the previous artifact format
 * ({@link MANAGED_EXCHANGE_PREVIOUS_ARTIFACT_VERSION}). The strict schema refuses
 * the tag either way; this names which direction the difference runs, so the
 * import states the remedy an older file has -- a fresh exchange -- rather than
 * the version-gap remedies that only close a newer file's. */
export class ManagedArtifactOutdatedError extends Error {
  constructor() {
    super("the backup file holds the previous artifact format");
    this.name = "ManagedArtifactOutdatedError";
  }
}

/** Matches any document whose `artifactVersion` is the previous literal, ahead of
 * the strict schema that refuses it. The rest of the document is left unchecked:
 * an older file's other fields are not this build's to read, and the tag alone
 * decides what the operator is told. */
const previousArtifactSchema = z.object({
  artifactVersion: z.literal(MANAGED_EXCHANGE_PREVIOUS_ARTIFACT_VERSION),
});

/**
 * Parse untrusted artifact bytes into a validated {@link ManagedExchangeArtifact}.
 * The whole document is parsed through the shared sensitive-JSON chokepoint
 * ({@link parseSensitiveJson}: structurally bounded before the parse, path-only
 * errors so no artifact bytes leak) and then the strict reader-rejects-unknown
 * {@link artifactSchema}. The embedded exchange document's YAML is not validated
 * here; {@link reconstructRecordFromArtifact} validates it through the exchange-file
 * parser.
 *
 * The previous format's tag is refused first, with its own error: it fails the
 * schema as surely, but as a rejection it is indistinguishable from a newer build's
 * export, whose remedies do not apply to a file this build has already moved past.
 * Nothing is reconstructed either way.
 *
 * @throws {UsageError} if the bytes are not parseable JSON.
 * @throws {ManagedArtifactOutdatedError} if the document holds the previous
 *   artifact format.
 * @throws {ZodError} if the parsed value is not a valid artifact.
 */
export function parseManagedExchangeArtifact(
  source: string,
): ManagedExchangeArtifact {
  const raw = parseSensitiveJson(source, "managed exchange backup");
  if (previousArtifactSchema.safeParse(raw).success)
    throw new ManagedArtifactOutdatedError();
  return artifactSchema.parse(raw);
}

/**
 * Reconstruct a runnable record from a validated artifact: a take-over that
 * installs the one owner. The embedded document is parsed back through
 * {@link parseSensitiveYaml} and {@link parseExchangeSpec}, the secret,
 * `expires`, and any pending relay registration come from the key pair, and
 * the local fields pass through unchanged, so the first run of a restored
 * record retries a pending registration before it connects. Built through
 * {@link buildManagedExchangeRecord} -- a fresh `id`, the v4 `schemaVersion`,
 * re-validated through the record schema -- so a malformed document or secret
 * is rejected and nothing is installed. Holds no working-folder handle: the
 * operator grants the folder again.
 *
 * @throws {UsageError} if the embedded document is not parseable YAML.
 * @throws {ZodError} if the embedded document or the reconstructed record is invalid.
 * @throws {ManagedConfigurationRefusedError} if the embedded document holds
 *   what a command-line import of it refuses.
 */
export function reconstructRecordFromArtifact(
  artifact: ManagedExchangeArtifact,
): ManagedExchangeRecord {
  const document = parseSensitiveYaml(
    artifact.exchangeDocument,
    "managed exchange backup document",
  );
  const exchangeFile: ExchangeSpec = parseExchangeSpec(document);
  refuseDocumentNotHeld(exchangeFile, document);
  return buildManagedExchangeRecord({
    label: artifact.local.label,
    exchangeFile,
    side: artifact.local.side,
    sharedSecret: artifact.key.sharedSecret,
    ...(artifact.key.expires !== undefined
      ? { expires: artifact.key.expires }
      : {}),
    ...(artifact.local.tokenMaxAgeDays !== undefined
      ? { tokenMaxAgeDays: artifact.local.tokenMaxAgeDays }
      : {}),
    ...(artifact.local.schedule !== undefined
      ? { schedule: artifact.local.schedule }
      : {}),
    ...(artifact.local.lastRun !== undefined
      ? { lastRun: artifact.local.lastRun }
      : {}),
    ...(artifact.local.standingCondition !== undefined
      ? { standingCondition: artifact.local.standingCondition }
      : {}),
    ...(artifact.local.relayRegistrar !== undefined
      ? { relayRegistrar: artifact.local.relayRegistrar }
      : {}),
    ...(artifact.key.relayRegistrationPendingSince !== undefined
      ? {
          relayRegistrationPendingSince:
            artifact.key.relayRegistrationPendingSince,
        }
      : {}),
    ...(artifact.local.relayRegistrationPendingReason !== undefined
      ? {
          relayRegistrationPendingReason:
            artifact.local.relayRegistrationPendingReason,
        }
      : {}),
  });
}

/** Which platform grants the source record held when the artifact was written.
 * Empty for a source that held none, and for an artifact written before the
 * markers existed -- both read as "nothing to say" rather than as a claim the
 * source had nothing. */
function heldPlatformGrants(
  artifact: ManagedExchangeArtifact,
): Array<ManagedPlatformGrant> {
  return [
    ...(artifact.local.heldOutputFolder === true ||
    artifact.local.heldInputFile === true
      ? (["working-folder"] as const)
      : []),
  ];
}

/** What an import gets out of the artifact's bytes: the runnable record, and which
 * device-local grants the source record held that no artifact can bring with it. */
export interface ImportedManagedExchangeArtifact {
  /** The reconstructed record, holding neither platform handle. */
  record: ManagedExchangeRecord;
  /** The grants the source held (see {@link heldPlatformGrants}). */
  heldGrants: Array<ManagedPlatformGrant>;
}

/**
 * Parse and reconstruct in one step: the untrusted-input entry point a caller uses
 * to turn artifact bytes into a runnable record and the grants its source held.
 * Rejects a malformed or tampered artifact by throwing, so a caller installs nothing
 * on a rejection and the store is left untouched.
 *
 * @throws {UsageError} if the bytes are not parseable JSON or the embedded document
 *   is not parseable YAML.
 * @throws {ManagedArtifactOutdatedError} if the bytes hold the previous artifact
 *   format.
 * @throws {ZodError} if the artifact or the reconstructed record is invalid.
 */
export function importManagedExchangeArtifact(
  source: string,
): ImportedManagedExchangeArtifact {
  const artifact = parseManagedExchangeArtifact(source);
  return {
    record: reconstructRecordFromArtifact(artifact),
    heldGrants: heldPlatformGrants(artifact),
  };
}
