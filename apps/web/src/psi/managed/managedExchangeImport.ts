/**
 * The managed-exchange import: one control over two files (see
 * {@link importManagedExchangeFile}), routed by what the file holds rather than
 * by which control the operator used.
 *
 * - The app's own BACKUP artifact installs its exchange on this device (the
 *   rest of this header).
 * - A command-line `alcove.yaml` installs a CONFIGURATION-ONLY record: settings
 *   to edit and export again, with no secret and no run here (see
 *   {@link ./managedCommandLineImport.ts}). It reconciles against nothing -- it
 *   brings no secret to match a stored record on -- and stamps no marker: the
 *   import marker is evidence of a restored secret, and the backup marker
 *   attests a file this browser restores a secret from. A file holding neither
 *   is that record's own backup, on the machine that runs it.
 * - A command-line `alcove.yaml` WITH the `.alcove.key` beside it installs a
 *   runnable record ({@link importManagedCommandLinePair}), reconciled against
 *   the store on the backup leg's own rule: the same secret is the same
 *   exchange. Where no secret matches, a configuration-only record with its
 *   agreed terms and side is offered to take the pair instead.
 *
 * What follows is the backup leg (see docs/MANAGED_EXCHANGE.md, "Eviction
 * recovery is the import flow", and docs/notes/managed-exchange-design.md,
 * "Export/import is migration, not sync"). Restoring after eviction and moving
 * to a new device are the same operation: an import installs the copy that runs
 * here.
 *
 * The file is untrusted structured input, so the whole parse-and-reconstruct is the
 * artifact module's trust boundary ({@link importManagedExchangeArtifact}: bounded
 * sensitive parse, strict reader-rejects-unknown schema, the embedded document
 * re-validated as an exchange file, the reconstructed record re-validated through
 * the record schema). Only a fully-validated record reaches the store, so a
 * malformed or tampered file is rejected before any write and the store is left
 * untouched.
 *
 * Import reconciles per exchange before installing fresh, whatever else the store
 * holds (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Reconciling a backup import"). A
 * backup holds one exchange, so the guard is a lookup: a stored record holding the
 * artifact's secret refuses ({@link ManagedImportAlreadyHeldError}), and a stored
 * record with the artifact's agreed terms and side is named and installed beside
 * only on the operator's word ({@link ManagedImportLiveCopyError}). The import
 * installs a fresh record with a new `id` and NO working-folder grant: the
 * operator grants the folder again.
 *
 * Every import reports whether this browser lacks the source's device-local
 * working folder. The artifact has no field for a File System Access handle, only
 * a marker saying the source had one, so a fresh install holds no folder and a
 * scheduled run would otherwise be the first to say so -- a whole window later.
 *
 * The installed record is marked imported and backed-up as of the import instant:
 * the file just imported from is itself a current backup of the installed secret
 * (so the exchange reads green rather than immediately prompting a re-export), and
 * the import marker is the desync tiering's evidence that a restore happened -- a
 * restored copy can hold a secret the partnership has rotated past, so a later
 * handshake failure shows as the benign import/restore tier, not the attack path
 * (see {@link ./managedFailureTiers.ts}).
 */

import { parseSensitiveYaml } from "@alcove/core";

import {
  MAX_ARTIFACT_IMPORT_BYTES,
  importManagedExchangeArtifact,
} from "./managedExchangeArtifact";
import {
  MAX_CONFIGURATION_IMPORT_BYTES,
  readManagedCommandLineConfigurationImport,
  readManagedCommandLinePairImport,
} from "./managedCommandLineImport";
import {
  createManagedExchange,
  reconcileManagedBackupImport,
  reconcileManagedCommandLinePair,
} from "./managedExchangeStore";
import {
  markManagedExchangeImported,
  markManagedExchangeKeyImported,
} from "./managedLocalState";
import { raisedStandingCondition } from "./managedExchangeRecord";

import type {
  ManagedBackupImportOptions,
  ManagedBackupReconcileOutcome,
  ManagedPairReconcileOutcome,
} from "./managedExchangeStore";
import type {
  ManagedExchangeRecord,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "./managedExchangeRecord";
import type {
  ManagedPairImportOptions,
  ManagedStoredCopy,
} from "./managedPairRecognition";
import type { ManagedPlatformGrant } from "./managedExchangeArtifact";

/**
 * Raised when an import is refused because a record this browser holds already
 * has the file's secret: the same exchange, already here, so nothing is
 * installed beside it. Holds that record's operator label (which may be empty)
 * so the surface can name it.
 */
export class ManagedImportAlreadyHeldError extends Error {
  /** The stored record's operator label; empty when the operator named nothing. */
  readonly label: string;

  constructor(label: string) {
    super(
      "this file's managed exchange already runs in this browser, so importing it is refused",
    );
    this.name = "ManagedImportAlreadyHeldError";
    this.label = label;
  }
}

/**
 * Raised when a backup import stops to ask: no record holds the artifact's
 * secret, but one or more stored ones have its agreed terms and side, so one may
 * be the same exchange run past the backup. Nothing is written. Holds every
 * such record's `id`, which an import the operator confirms passes back in
 * `besideIds`, and its label (which may be empty) so the surface can name it.
 */
export class ManagedImportLiveCopyError extends Error {
  /** The stored records the backup may be an older copy of, each with its
   * operator label (empty when the operator named nothing). */
  readonly copies: ReadonlyArray<{ id: string; label: string }>;

  constructor(copies: ReadonlyArray<{ id: string; label: string }>) {
    super(
      "a managed exchange with this backup's terms and side already runs in this browser, so the import waits for confirmation",
    );
    this.name = "ManagedImportLiveCopyError";
    this.copies = copies;
  }
}

/** The platform boundaries the import drives, injected so the flow is testable. */
export interface ManagedImportDeps {
  /** Reconcile the reconstructed artifact against the store
   * ({@link reconcileManagedBackupImport}): report the outcome that refuses,
   * asks, or installs fresh. */
  reconcile: (
    reconstructed: ManagedExchangeRecord,
    options?: ManagedBackupImportOptions,
  ) => Promise<ManagedBackupReconcileOutcome>;
  /** Install a reconstructed record as a new managed exchange. */
  install: (record: ManagedExchangeRecord) => Promise<ManagedExchangeRecord>;
  /** Stamp the installed record's import and backup markers as of `at` -- the
   * restore evidence the desync tiering reads, plus the current-backup marker. */
  markImported: (id: string, at: string) => Promise<void>;
  /** The moment of the import; injected so the marker date is the caller's clock. */
  now: () => Date;
}

/**
 * The fields a fresh install creates its record from: everything `record`
 * holds but its `id`, which the install assigns anew, and the platform
 * grants, which a file cannot bring. The run bookkeeping, a raised standing
 * condition, and the relay registration -- the registrar and any pending
 * registration with its reason -- are kept, so an install on a new profile
 * clears none of them.
 */
export function managedInstallFields(
  record: ManagedExchangeRecord,
): NewManagedExchange {
  const standingCondition = raisedStandingCondition(record);
  return {
    label: record.label,
    exchangeFile: record.exchangeFile,
    side: record.side,
    sharedSecret: record.sharedSecret,
    ...(record.expires !== undefined ? { expires: record.expires } : {}),
    ...(record.tokenMaxAgeDays !== undefined
      ? { tokenMaxAgeDays: record.tokenMaxAgeDays }
      : {}),
    ...(record.schedule !== undefined ? { schedule: record.schedule } : {}),
    ...(record.lastRun !== undefined ? { lastRun: record.lastRun } : {}),
    ...(standingCondition !== undefined ? { standingCondition } : {}),
    ...(record.relayRegistrar !== undefined
      ? { relayRegistrar: record.relayRegistrar }
      : {}),
    ...(record.relayRegistrationPendingSince !== undefined
      ? { relayRegistrationPendingSince: record.relayRegistrationPendingSince }
      : {}),
    ...(record.relayRegistrationPendingReason !== undefined
      ? {
          relayRegistrationPendingReason: record.relayRegistrationPendingReason,
        }
      : {}),
  };
}

/** The default boundaries: reconcile and install through the store, mark through
 * the sibling store, and read the wall clock. */
const defaultDeps: ManagedImportDeps = {
  reconcile: reconcileManagedBackupImport,
  install: async (record) =>
    createManagedExchange(managedInstallFields(record)),
  markImported: markManagedExchangeImported,
  now: () => new Date(),
};

/** What an import leaves the operator with: the record, and the grants they have to
 * take again on this browser before an unattended run can use them. */
export interface ManagedImportResult {
  /** The installed or completed record. */
  record: ManagedExchangeRecord;
  /** The grants the source record held that {@link record} does not, in the order
   * they are presented. Empty when there is nothing to take again. */
  missingGrants: Array<ManagedPlatformGrant>;
  /** On a pair import, the `connection.turn` urls its configuration names
   * beside a relay registrar, which this browser's own relay settings replace
   * ({@link readManagedCommandLinePairImport}), as the file states them. */
  droppedTurnUrls?: Array<string>;
  /** On a pair import, the names of the fields its key file holds that the
   * import did not read ({@link readManagedCommandLinePairImport}). */
  unreadKeyFileFields?: Array<string>;
  /** On a command-line import, the retired settings its configuration
   * states, which the record does not keep
   * ({@link readManagedCommandLineConfigurationImport}). */
  retiredSettings?: Array<string>;
}

/** The grants the artifact's source held that the imported record does not, which is
 * what the operator has to take again here. */
function grantsMissingHere(
  heldGrants: Array<ManagedPlatformGrant>,
  record: ManagedExchangeRecord,
): Array<ManagedPlatformGrant> {
  const held: Record<ManagedPlatformGrant, boolean> = {
    "working-folder": record.workingDirectoryHandle !== undefined,
  };
  return heldGrants.filter((grant) => !held[grant]);
}

/**
 * Import an artifact's bytes as a managed exchange. Parses and reconstructs through
 * the artifact module's trust boundary (throwing on a malformed or tampered file
 * before any write), then reconciles it per exchange: refuses a stored record
 * holding its secret; stops to ask where stored records have the artifact's
 * agreed terms and side, unless `options.besideIds` names them all; otherwise
 * installs a fresh record and marks it imported and backed up as of the import
 * instant. Returns the installed record, with the grants it does not hold that
 * its source did.
 *
 * The import mark on a fresh install is best-effort after the install succeeds: a
 * valid record is already durable, so a failed marker write must not report the
 * import failed (a retry would then duplicate the record). The exchange simply reads
 * "backup needed" and holds no restore evidence until the next export -- the same
 * bookkeeping-after-durable-write discipline the run path follows.
 *
 * @throws {UsageError} if the bytes are not parseable JSON or the embedded document
 *   is not parseable YAML.
 * @throws {ManagedImportAlreadyHeldError} if a stored record holds the artifact's
 *   secret; nothing is written.
 * @throws {ManagedImportLiveCopyError} if a stored record not in `besideIds` has
 *   the artifact's agreed terms and side; nothing is written.
 * @throws {ZodError} if the artifact or the reconstructed record is invalid, or the
 *   install itself fails.
 */
export async function importManagedExchange(
  source: string,
  deps: ManagedImportDeps = defaultDeps,
  options: ManagedBackupImportOptions = {},
): Promise<ManagedImportResult> {
  const { record: reconstructed, heldGrants } =
    importManagedExchangeArtifact(source);
  const at = deps.now().toISOString();
  const reconciled = await deps.reconcile(reconstructed, options);
  if (reconciled.kind === "held")
    throw new ManagedImportAlreadyHeldError(reconciled.label);
  if (reconciled.kind === "live-copy")
    throw new ManagedImportLiveCopyError(reconciled.copies);
  const installed = await deps.install(reconstructed);
  try {
    await deps.markImported(installed.id, at);
  } catch {
    // Best-effort: the record is durable; a failed marker only shows "backup
    // needed" and holds no restore evidence, and reporting failure here would
    // duplicate on retry.
  }
  return {
    record: installed,
    missingGrants: grantsMissingHere(heldGrants, installed),
  };
}

/** Upper bound, in bytes, on a file this import will read: the picker in
 * `SavedExchanges.tsx` refuses a file above this cap before reading it. The two
 * per-leg constants below name each leg's intended bound; both equal this value
 * today. */
export const MAX_IMPORT_FILE_BYTES = Math.max(
  MAX_ARTIFACT_IMPORT_BYTES,
  MAX_CONFIGURATION_IMPORT_BYTES,
);

/**
 * Which of the two files an import was given, decided on what the bytes hold.
 * The backup artifact is a JSON document tagged with an `artifactVersion`; a
 * command-line configuration is the YAML the CLI loads, which has no such
 * field. The probe reads the bytes through the sensitive-YAML chokepoint (YAML
 * being a superset of the artifact's JSON), and each leg then parses the file
 * again through its own trust boundary, so no leg validates what another
 * decoded.
 *
 * Bytes that parse as neither are the backup leg's: its refusal is the one that
 * tells an operator to check the file they chose, and a file this app never
 * wrote has no version story to tell them.
 */
export function managedImportFileKind(
  source: string,
): "backup" | "command-line-configuration" {
  const probed = probeImportFile(source);
  return probed === "unparseable" ? "backup" : probed;
}

/** What the bytes hold, keeping apart the bytes that parse as neither file:
 * the import control hands those to the backup leg, and the pair import to the
 * configuration's own refusal. */
function probeImportFile(
  source: string,
): "backup" | "command-line-configuration" | "unparseable" {
  let probed: unknown;
  try {
    probed = parseSensitiveYaml(source, "managed exchange import");
  } catch {
    return "unparseable";
  }
  const tagged =
    typeof probed === "object" &&
    probed !== null &&
    "artifactVersion" in probed;
  return tagged ? "backup" : "command-line-configuration";
}

/**
 * Raised when the pair import is given the app's own backup file as its
 * configuration. A backup is imported on its own, so a file tagged as one is
 * refused on that tag and nothing is written.
 */
export class ManagedImportBackupNotConfigurationError extends Error {
  constructor() {
    super(
      "this file is a managed-exchange backup, which the pair import does not take as its configuration",
    );
    this.name = "ManagedImportBackupNotConfigurationError";
  }
}

/**
 * Import a file the operator chose, whichever of the two it is: the app's own
 * backup artifact ({@link importManagedExchange}), or a command-line
 * `alcove.yaml` installed as a configuration-only record
 * ({@link readManagedCommandLineConfigurationImport}). Nothing is written on a
 * refusal by either leg.
 *
 * A configuration import always installs a fresh record. It holds no secret to
 * reconcile against a stored one, and it installs nothing runnable, so it never
 * stands beside a stored record as a second live copy.
 *
 * @throws {UsageError} if the bytes parse as neither file.
 * @throws {ManagedConfigurationRefusedError} if a configuration fails the
 *   exchange-file schema, or is one this app cannot hold.
 * @throws Every refusal {@link importManagedExchange} raises, on the backup leg;
 *   `options.besideIds` reaches that leg alone.
 * @throws {ZodError} if the backup file fails its schema, or the install does.
 */
export async function importManagedExchangeFile(
  source: string,
  deps: ManagedImportDeps = defaultDeps,
  options: ManagedBackupImportOptions = {},
): Promise<ManagedImportResult> {
  if (managedImportFileKind(source) === "backup")
    return importManagedExchange(source, deps, options);
  return installConfiguration(source, deps);
}

/** Read a configuration and install it as a fresh configuration-only record. */
async function installConfiguration(
  source: string,
  deps: Pick<ManagedImportDeps, "install">,
): Promise<ManagedImportResult> {
  const { record: read, retiredSettings } =
    readManagedCommandLineConfigurationImport(source);
  const record = await deps.install(read);
  return {
    record,
    missingGrants: [],
    ...(retiredSettings.length > 0 ? { retiredSettings } : {}),
  };
}

/**
 * Raised when a pair import stops to ask: no stored record holds the key
 * file's secret, but one or more holding a configuration only have its agreed
 * terms and side, so one may be its exchange. Nothing is written. The
 * operator's answer comes back as `into` (take the pair into one of `copies`)
 * or `besideIds` (install it as a new record beside them).
 */
export class ManagedImportStoredCopyError extends Error {
  /** The stored records the pair may belong to, each with its label (empty
   * when the operator named nothing) and why it can take the pair. */
  readonly copies: ReadonlyArray<ManagedStoredCopy>;

  constructor(copies: ReadonlyArray<ManagedStoredCopy>) {
    super(
      "a stored managed exchange with these files' terms and side may be theirs, so the import waits for confirmation",
    );
    this.name = "ManagedImportStoredCopyError";
    this.copies = copies;
  }
}

/**
 * Raised when the stored record the operator chose to take a pair into can no
 * longer take it: it was deleted or changed since they chose. Nothing is
 * written.
 */
export class ManagedImportChosenCopyError extends Error {
  constructor() {
    super(
      "the chosen managed exchange changed since it was chosen, so the files were not taken into it",
    );
    this.name = "ManagedImportChosenCopyError";
  }
}

/** The platform boundaries a command-line pair import drives, injected so the
 * flow is testable. */
export interface ManagedPairImportDeps {
  /** Reconcile the pair's record against the store
   * ({@link reconcileManagedCommandLinePair}). */
  reconcile: (
    imported: RunnableManagedExchangeRecord,
    at: string,
    options?: ManagedPairImportOptions,
  ) => Promise<ManagedPairReconcileOutcome>;
  /** Install the pair's record as a new managed exchange. */
  install: (record: ManagedExchangeRecord) => Promise<ManagedExchangeRecord>;
  /** Stamp the installed record's import marker as of `at`, and no backup
   * marker. */
  markImported: (id: string, at: string) => Promise<void>;
  /** The moment of the import. */
  now: () => Date;
}

/** The default boundaries: reconcile and install through the store, mark
 * through the sibling store, and read the wall clock. */
const defaultPairDeps: ManagedPairImportDeps = {
  reconcile: reconcileManagedCommandLinePair,
  install: defaultDeps.install,
  markImported: markManagedExchangeKeyImported,
  now: () => new Date(),
};

/**
 * Import a command-line `alcove.yaml` and the `.alcove.key` beside it as a
 * runnable managed exchange. Both files are read in full before the store is
 * reached ({@link readManagedCommandLinePairImport}), so a refusal of either
 * writes nothing. The record is then reconciled on the backup import's rule
 * -- a stored record holding the same secret is the same exchange -- and:
 *
 * - a stored record holding the same secret refuses
 *   ({@link ManagedImportAlreadyHeldError});
 * - with no match, configuration-only records that have its agreed terms and
 *   side, other than those `options.besideIds` names, stop the import to ask
 *   ({@link ManagedImportStoredCopyError}). `options.into` completes the one
 *   the operator chose in place;
 * - otherwise the record installs fresh and its import marker is stamped,
 *   best-effort after the durable install as on the backup leg. No backup
 *   marker is stamped: the pair is not the app's backup file.
 *
 * The secret lands in the record's `sharedSecret` alone, the field every
 * runnable record keeps it in; no refusal here states any byte of the key
 * file. A landed import returns the `turn` urls the record did not keep and
 * the names of the key-file fields it did not read, for the notice to name.
 *
 * @throws {ManagedImportBackupNotConfigurationError} if the configuration file
 *   is the app's backup; nothing is written.
 * @throws {UsageError} if the configuration is not parseable YAML.
 * @throws {ManagedConfigurationRefusedError} if the configuration is refused.
 * @throws {ManagedKeyFileRefusedError} if the key file is refused.
 * @throws {ManagedImportAlreadyHeldError} if a stored record holds the key
 *   file's secret.
 * @throws {ManagedImportStoredCopyError} if the import stops to ask.
 * @throws {ManagedImportChosenCopyError} if the record `options.into` names
 *   can no longer take the pair.
 * @throws {ZodError} if the record, the completion, or the install is invalid.
 */
export async function importManagedCommandLinePair(
  configurationSource: string,
  keySource: string,
  deps: ManagedPairImportDeps = defaultPairDeps,
  options: ManagedPairImportOptions = {},
): Promise<ManagedImportResult> {
  if (probeImportFile(configurationSource) === "backup")
    throw new ManagedImportBackupNotConfigurationError();
  const {
    record: imported,
    droppedTurnUrls,
    unreadKeyFileFields,
    retiredSettings,
  } = readManagedCommandLinePairImport(configurationSource, keySource);
  const landed = (record: ManagedExchangeRecord): ManagedImportResult => ({
    record,
    missingGrants: [],
    ...(droppedTurnUrls.length > 0 ? { droppedTurnUrls } : {}),
    ...(unreadKeyFileFields.length > 0 ? { unreadKeyFileFields } : {}),
    ...(retiredSettings.length > 0 ? { retiredSettings } : {}),
  });
  const at = deps.now().toISOString();
  const reconciled = await deps.reconcile(imported, at, options);
  if (reconciled.kind === "completed") return landed(reconciled.record);
  if (reconciled.kind === "stored-copy")
    throw new ManagedImportStoredCopyError(reconciled.copies);
  if (reconciled.kind === "chosen-copy-changed")
    throw new ManagedImportChosenCopyError();
  if (reconciled.kind === "held")
    throw new ManagedImportAlreadyHeldError(reconciled.label);
  const installed = await deps.install(imported);
  try {
    await deps.markImported(installed.id, at);
  } catch {
    // Best-effort, as on the backup leg: the record is durable, and reporting
    // failure here would install a duplicate on retry.
  }
  return landed(installed);
}
