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
 *   exchange. Where no secret matches, a stored record with its agreed terms
 *   and side is offered to take the pair instead.
 *
 * What follows is the backup leg (see docs/MANAGED_EXCHANGE.md, "Eviction
 * recovery is the import flow", and docs/notes/managed-exchange-design.md,
 * "Export/import is migration, not sync"). Restoring after eviction, moving to
 * a new device, and bringing back an exchange run elsewhere are the same
 * operation: an import installs or replaces the copy that runs here.
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
 * artifact's secret refuses ({@link ManagedImportAlreadyHeldError}), and stored
 * records with the artifact's agreed terms and side are named
 * ({@link ManagedImportLiveCopyError}): the import replaces the one the operator
 * chooses, keeping its `id` and working-folder grant, or installs beside them
 * all, only on the operator's word. A fresh install holds a new `id` and NO
 * working-folder grant: the operator grants the folder again.
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
  readManagedCommandLineConfiguration,
  readManagedCommandLinePairImport,
} from "./managedCommandLineImport";
import {
  createManagedExchange,
  reconcileManagedBackupImport,
  reconcileManagedCommandLinePair,
  replaceManagedExchangeFromImport,
} from "./managedExchangeStore";
import {
  markManagedExchangeImported,
  markManagedExchangeKeyImported,
} from "./managedLocalState";
import { orderManagedStoredCopies } from "./managedCopyOrder";
import { raisedStandingCondition } from "./managedExchangeRecord";

import type {
  ManagedBackupImportOptions,
  ManagedBackupReconcileOutcome,
  ManagedPairReconcileOutcome,
  ManagedReplaceOutcome,
} from "./managedExchangeStore";
import type {
  ManagedExchangeRecord,
  ManagedImportSource,
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
  /** Whether the stored record's sibling entry does not parse, so its page
   * cannot load. */
  readonly stateUnreadable: boolean;

  constructor(label: string, stateUnreadable = false) {
    super(
      "this file's managed exchange already runs in this browser, so importing it is refused",
    );
    this.name = "ManagedImportAlreadyHeldError";
    this.label = label;
    this.stateUnreadable = stateUnreadable;
  }
}

/**
 * Raised when a backup import stops to ask: no record holds the artifact's
 * secret, but one or more stored ones have its agreed terms and side, so one may
 * be the same exchange, run here past the backup or run elsewhere since it was
 * saved here. Nothing is written. Holds every such record's `id`, label
 * (which may be empty), and whether it runs here: the operator's answer passes
 * one back as `into` to replace it, or all of them in `besideIds` to install
 * beside them.
 */
export class ManagedImportLiveCopyError extends Error {
  /** The stored records the backup may be a copy of. */
  readonly copies: ReadonlyArray<ManagedStoredCopy>;

  constructor(copies: ReadonlyArray<ManagedStoredCopy>) {
    super(
      "a managed exchange with this backup's terms and side already runs in this browser, so the import waits for confirmation",
    );
    this.name = "ManagedImportLiveCopyError";
    this.copies = copies;
  }
}

/** Why the stored record the operator chose could not take an import: a run
 * of it holds its run lock, or it was deleted or changed since they chose. */
export type ManagedChosenCopyRefusal = "run-in-flight" | "changed";

/**
 * Raised when the stored record the operator chose to take an import into can
 * no longer take it ({@link ManagedChosenCopyRefusal}). Nothing is written.
 */
export class ManagedImportChosenCopyError extends Error {
  /** Why the chosen record could not take the import. */
  readonly reason: ManagedChosenCopyRefusal;

  constructor(reason: ManagedChosenCopyRefusal) {
    super(
      reason === "run-in-flight"
        ? "the chosen managed exchange is running, so the import was not taken into it"
        : "the chosen managed exchange changed since it was chosen, so the import was not taken into it",
    );
    this.name = "ManagedImportChosenCopyError";
    this.reason = reason;
  }
}

/** Replace the stored record the operator chose with an imported one, marking
 * it in the same write ({@link replaceManagedExchangeFromImport}). */
type ManagedReplace = (
  id: string,
  expectedSharedSecret: string | undefined,
  at: string,
  imported: ManagedExchangeRecord,
  source: ManagedImportSource,
) => Promise<ManagedReplaceOutcome>;

/** The replaced record, or the refusal a replace that wrote nothing is. */
async function replacedOrRefuse(
  replace: ManagedReplace,
  target: { id: string; sharedSecret?: string },
  at: string,
  imported: ManagedExchangeRecord,
  source: ManagedImportSource,
): Promise<ManagedExchangeRecord> {
  const replaced = await replace(
    target.id,
    target.sharedSecret,
    at,
    imported,
    source,
  );
  if (replaced.kind === "replaced") return replaced.record;
  throw new ManagedImportChosenCopyError(replaced.kind);
}

/** The platform boundaries the import drives, injected so the flow is testable. */
export interface ManagedImportDeps {
  /** Reconcile the reconstructed artifact against the store
   * ({@link reconcileManagedBackupImport}): report the outcome that refuses,
   * asks, replaces, or installs fresh. */
  reconcile: (
    reconstructed: ManagedExchangeRecord,
    options?: ManagedBackupImportOptions,
  ) => Promise<ManagedBackupReconcileOutcome>;
  /** Replace the stored record the operator chose. */
  replace: ManagedReplace;
  /** Install a reconstructed record as a new managed exchange. */
  install: (record: ManagedExchangeRecord) => Promise<ManagedExchangeRecord>;
  /** Stamp the installed record's import and backup markers as of `at` -- the
   * restore evidence the desync tiering reads, plus the current-backup marker. */
  markImported: (id: string, at: string) => Promise<void>;
  /** The moment of the import; injected so the marker date is the caller's clock. */
  now: () => Date;
  /** State which copy is newer on each stored copy the import asks about
   * ({@link orderManagedStoredCopies}); absent, the question states none. */
  orderCopies?: ManagedOrderCopies;
}

/** {@link orderManagedStoredCopies} as an import calls it. */
type ManagedOrderCopies = (
  copies: ReadonlyArray<ManagedStoredCopy>,
  imported: ManagedExchangeRecord,
) => Promise<ReadonlyArray<ManagedStoredCopy>>;

/** `copies` with the order `orderCopies` states, or as they are without it. */
async function orderedCopies(
  copies: ReadonlyArray<ManagedStoredCopy>,
  imported: ManagedExchangeRecord,
  orderCopies: ManagedOrderCopies | undefined,
): Promise<ReadonlyArray<ManagedStoredCopy>> {
  return orderCopies === undefined ? copies : orderCopies(copies, imported);
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
    ...(record.rotationHistory !== undefined
      ? { rotationHistory: record.rotationHistory }
      : {}),
  };
}

/** The default boundaries: reconcile and install through the store, mark through
 * the sibling store, and read the wall clock. */
const defaultDeps: ManagedImportDeps = {
  reconcile: reconcileManagedBackupImport,
  replace: replaceManagedExchangeFromImport,
  install: async (record) =>
    createManagedExchange(managedInstallFields(record)),
  markImported: markManagedExchangeImported,
  now: () => new Date(),
  orderCopies: orderManagedStoredCopies,
};

/** What an import leaves the operator with: the record, and the grants they have to
 * take again on this browser before an unattended run can use them. */
export interface ManagedImportResult {
  /** The installed, completed, or replaced record. */
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
 * agreed terms and side, unless `options.into` chooses one to replace or
 * `options.besideIds` names them all; otherwise installs a fresh record and
 * marks it imported and backed up as of the import instant. A replace marks the
 * record in its own write ({@link replaceManagedExchangeFromImport}). Returns
 * the installed or replaced record, with the grants it does not hold that its
 * source did.
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
 *   the artifact's agreed terms and side, and `into` chose none; nothing is
 *   written.
 * @throws {ManagedImportChosenCopyError} if the record `into` names can no
 *   longer take the backup; nothing is written.
 * @throws {ZodError} if the artifact or the reconstructed record is invalid, or the
 *   install or replace itself fails.
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
    throw new ManagedImportAlreadyHeldError(
      reconciled.label,
      reconciled.stateUnreadable === true,
    );
  if (reconciled.kind === "live-copy")
    throw new ManagedImportLiveCopyError(
      await orderedCopies(reconciled.copies, reconstructed, deps.orderCopies),
    );
  if (reconciled.kind === "chosen-copy-changed")
    throw new ManagedImportChosenCopyError("changed");
  if (reconciled.kind === "replace") {
    const replaced = await replacedOrRefuse(
      deps.replace,
      reconciled,
      at,
      reconstructed,
      "backup",
    );
    return {
      record: replaced,
      missingGrants: grantsMissingHere(heldGrants, replaced),
    };
  }
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
 * ({@link readManagedCommandLineConfiguration}). Nothing is written on a
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
 *   `options` reaches that leg alone.
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
  const record = await deps.install(
    readManagedCommandLineConfiguration(source),
  );
  return { record, missingGrants: [] };
}

/**
 * Raised when a pair import stops to ask: no stored record holds the key
 * file's secret, but one or more -- holding a configuration only, or running
 * here with another secret -- have its agreed terms and side, so one may be its
 * exchange. Nothing is written. The operator's answer comes back as `into`
 * (take the pair into one of `copies`) or `besideIds` (install it as a new
 * record beside them).
 */
export class ManagedImportStoredCopyError extends Error {
  /** The stored records the pair may belong to, each with its label (empty
   * when the operator named nothing) and what it holds. */
  readonly copies: ReadonlyArray<ManagedStoredCopy>;

  constructor(copies: ReadonlyArray<ManagedStoredCopy>) {
    super(
      "a stored managed exchange with these files' terms and side may be theirs, so the import waits for confirmation",
    );
    this.name = "ManagedImportStoredCopyError";
    this.copies = copies;
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
  /** Replace the runnable record the operator chose. */
  replace: ManagedReplace;
  /** Install the pair's record as a new managed exchange. */
  install: (record: ManagedExchangeRecord) => Promise<ManagedExchangeRecord>;
  /** Stamp the installed record's import marker as of `at`, and no backup
   * marker. */
  markImported: (id: string, at: string) => Promise<void>;
  /** The moment of the import. */
  now: () => Date;
  /** As {@link ManagedImportDeps.orderCopies}. */
  orderCopies?: ManagedOrderCopies;
}

/** The default boundaries: reconcile and install through the store, mark
 * through the sibling store, and read the wall clock. */
const defaultPairDeps: ManagedPairImportDeps = {
  reconcile: reconcileManagedCommandLinePair,
  replace: replaceManagedExchangeFromImport,
  install: defaultDeps.install,
  markImported: markManagedExchangeKeyImported,
  now: () => new Date(),
  orderCopies: orderManagedStoredCopies,
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
 * - with no match, stored records that have its agreed terms and side, other
 *   than those `options.besideIds` names, stop the import to ask
 *   ({@link ManagedImportStoredCopyError}). `options.into` completes the
 *   configuration-only record the operator chose in place, or replaces the
 *   runnable one under its run lock ({@link replaceManagedExchangeFromImport});
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
 * @throws {ZodError} if the record, the completion, the replace, or the
 *   install is invalid.
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
  } = readManagedCommandLinePairImport(configurationSource, keySource);
  const landed = (record: ManagedExchangeRecord): ManagedImportResult => ({
    record,
    missingGrants: [],
    ...(droppedTurnUrls.length > 0 ? { droppedTurnUrls } : {}),
    ...(unreadKeyFileFields.length > 0 ? { unreadKeyFileFields } : {}),
  });
  const at = deps.now().toISOString();
  const reconciled = await deps.reconcile(imported, at, options);
  if (reconciled.kind === "completed") return landed(reconciled.record);
  if (reconciled.kind === "replace")
    return landed(
      await replacedOrRefuse(
        deps.replace,
        reconciled,
        at,
        imported,
        "command-line",
      ),
    );
  if (reconciled.kind === "stored-copy")
    throw new ManagedImportStoredCopyError(
      await orderedCopies(reconciled.copies, imported, deps.orderCopies),
    );
  if (reconciled.kind === "chosen-copy-changed")
    throw new ManagedImportChosenCopyError("changed");
  if (reconciled.kind === "held")
    throw new ManagedImportAlreadyHeldError(
      reconciled.label,
      reconciled.stateUnreadable === true,
    );
  const installed = await deps.install(imported);
  try {
    await deps.markImported(installed.id, at);
  } catch {
    // Best-effort, as on the backup leg: the record is durable, and reporting
    // failure here would install a duplicate on retry.
  }
  return landed(installed);
}
