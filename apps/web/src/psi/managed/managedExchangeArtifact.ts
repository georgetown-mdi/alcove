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
  migrateOnRead,
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

import type {
  ExchangeSpec,
  FormatMigrations,
  RelayRegistrar,
} from "@alcove/core";
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
  /** The artifact-format literal this build writes; a reader migrates the
   * previous one and refuses any other value. */
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
 * `expires` it lapses at when a bound is in force, the pending relay key
 * registration when one is recorded, and the rotation history when the record
 * has one. The one place a record's secret half becomes the key file's fields,
 * shared by the artifact's `key` block and the CLI cron export's key file so
 * neither can grow a field the other lacks; its type
 * ({@link ManagedExchangeKeyPair}) has no field for a previous secret. An
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
    ...(record.rotationHistory !== undefined
      ? { rotationHistory: [...record.rotationHistory] }
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

/**
 * The v2 -> v3 step. A v2 backup is the v3 shape with no answer in a raised
 * condition, so the step moves only the tag. One holding an answer is refused
 * rather than read: no build writing v2 knew the member, so the file was not
 * written as it stands.
 */
function migrateArtifactFromV2(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const local = document["local"];
  if (typeof local !== "object" || local === null) return document;
  const condition = (local as Record<string, unknown>)["standingCondition"];
  if (
    typeof condition === "object" &&
    condition !== null &&
    Object.hasOwn(condition, "response")
  )
    throw new Error(
      "it records that the exchange was treated as a possible compromise, " +
        "which a backup of that version cannot record",
    );
  return document;
}

/** The backup file's migrations, run in memory at every import. A backup is
 * never rewritten: the next one an export writes is at the current version. */
export const MANAGED_EXCHANGE_ARTIFACT_MIGRATIONS: FormatMigrations<string> =
  Object.freeze({
    fileName: "The backup file",
    versionField: "artifactVersion",
    current: MANAGED_EXCHANGE_ARTIFACT_VERSION,
    steps: Object.freeze([
      {
        from: MANAGED_EXCHANGE_PREVIOUS_ARTIFACT_VERSION,
        to: MANAGED_EXCHANGE_ARTIFACT_VERSION,
        migrate: migrateArtifactFromV2,
      },
    ]),
    failureRemedy:
      "Export the backup again from the device that holds the exchange, or " +
      "set up a new exchange with your partner.",
  });

/**
 * Parse untrusted artifact bytes into a validated {@link ManagedExchangeArtifact}.
 * The whole document is parsed through the shared sensitive-JSON chokepoint
 * ({@link parseSensitiveJson}: structurally bounded before the parse, path-only
 * errors so no artifact bytes leak), migrated in memory where it is at an
 * earlier version, and then held to the strict reader-rejects-unknown
 * {@link artifactSchema}. The embedded exchange document's YAML is not validated
 * here; {@link reconstructRecordFromArtifact} validates it through the exchange-file
 * parser.
 *
 * @param migrations the backup's migrations; this build's by default.
 * @throws {UsageError} if the bytes are not parseable JSON.
 * @throws {FormatMigrationError} if the document is at an earlier version and
 *   its migration fails, naming the cause.
 * @throws {ZodError} if the parsed value is not a valid artifact.
 */
export function parseManagedExchangeArtifact(
  source: string,
  migrations: FormatMigrations<string> = MANAGED_EXCHANGE_ARTIFACT_MIGRATIONS,
): ManagedExchangeArtifact {
  const raw = parseSensitiveJson(source, "managed exchange backup");
  return artifactSchema.parse(migrateOnRead(raw, migrations));
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
    ...(artifact.key.rotationHistory !== undefined
      ? { rotationHistory: artifact.key.rotationHistory }
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
 * @throws {FormatMigrationError} if the bytes hold an earlier artifact version
 *   whose migration fails.
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
