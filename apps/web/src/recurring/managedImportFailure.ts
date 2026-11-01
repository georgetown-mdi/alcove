/**
 * What the import affordance says when it will not take a backup file (see
 * docs/MANAGED_EXCHANGE.md, "Eviction recovery is the import flow").
 *
 * A command-line configuration this app will not take is the one refusal that
 * states its own reason: the file is in front of the operator, who wrote it by
 * hand, and what stops it is a line in it -- a field off the exchange-file
 * schema, a channel this app does not run, a credential it will not store, a
 * missing role -- so the refusal names the lines and what to do about them
 * ({@link ManagedConfigurationRefusedError}).
 *
 * Three things stop a file that says nothing of its own, and they call for
 * different actions. Bytes that are not
 * a parseable document at all -- along with a file over the import cap, which is
 * refused before it is read -- leave only the file itself to check. A document
 * that parses and then fails the artifact's strict
 * reader-rejects-unknown schema has a cause the operator cannot see from the file:
 * an export written by a newer build holds keys, or an artifact version, that this
 * build's schema refuses whole (see docs/spec/MANAGED_EXCHANGE_RECORD.md, "Export
 * artifact"). That case names the version difference and both ways out of it --
 * bring this page up to date, or write the file from a build that matches -- before
 * the wrong-file and modified-file checks, which are what is left when the two
 * builds already agree. A file at an earlier artifact version is migrated on
 * read, so the one that stops is a migration that failed, and its refusal names
 * the versions and the cause.
 *
 * The refusals that name an exchange this browser already holds -- the same
 * secret, or the same agreed terms and side -- are here too, since they say what
 * to do with the listed exchange rather than with the file.
 */

import { ZodError } from "zod";

import { FormatMigrationError, sanitizeErrorForDisplay } from "@alcove/core";

import {
  ManagedConfigurationRefusedError,
  ManagedKeyFileRefusedError,
} from "@psi/managed/managedCommandLineImport";
import { ManagedImportBackupNotConfigurationError } from "@psi/managed/managedExchangeImport";

import type { ManagedChosenCopyRefusal } from "@psi/managed/managedExchangeImport";
import type { ManagedStoredCopy } from "@psi/managed/managedPairRecognition";

/** The heading every import refusal here is shown under. */
export const IMPORT_FAILURE_TITLE = "That file could not be imported";

/** The file's bytes are not a document this app can parse, or it is over the
 * import cap and was refused before any parse. Nothing was placed, so what is left
 * to check is which file was chosen and whether it still holds what was exported. */
export const UNREADABLE_IMPORT_REASON =
  "The backup file could not be read. Check that you chose the backup file you " +
  "exported and that it was not modified.";

/** The file parsed and then failed the artifact schema. A newer build's export is
 * the cause the operator has no way to see, so it is named first, with the two
 * remedies that close a version gap; the file's own possible faults follow. */
export const UNRECOGNIZED_IMPORT_REASON =
  "This app does not recognize what the backup file holds. It may have been " +
  "exported by a newer version of this app than this page is running: reload " +
  "this page to use the current version, or export the backup again from the " +
  "device that wrote this file. Otherwise check that you chose the backup file " +
  "you exported and that it was not modified.";

/**
 * Which refusal an import error is shown as. A command-line configuration this
 * app cannot hold carries its own reason and is checked first; it is escaped for
 * display here, at the one altitude, since it names fields read out of the file.
 * A file at an earlier artifact version whose migration failed raises a
 * {@link FormatMigrationError}, which states its own versions and cause and is
 * escaped the same way: it would otherwise read as the newer-build case below,
 * whose remedies an older file does not have. A schema rejection anywhere else in the
 * parse-and-reconstruct -- the artifact's own strict schema, the embedded exchange
 * document, or the reconstructed record -- raises a {@link ZodError}, and that is
 * the version-difference case. Everything else, a failed parse and a store that
 * would not take the record alike, leaves the operator with the file to check.
 */
export function importFailureReason(error: unknown): string {
  if (
    error instanceof ManagedConfigurationRefusedError ||
    error instanceof FormatMigrationError
  )
    return sanitizeErrorForDisplay(error);
  return error instanceof ZodError
    ? UNRECOGNIZED_IMPORT_REASON
    : UNREADABLE_IMPORT_REASON;
}

/** The configuration-only import's file is not a document this app can parse,
 * or it is over the import cap and was refused before any parse. */
export const UNREADABLE_CONFIGURATION_REASON =
  "The configuration file could not be read. Check that you chose the " +
  "alcove.yaml the command line runs and that it is a valid YAML file.";

/** The pair import was given the app's backup file as its configuration. */
export const BACKUP_NOT_PAIR_REASON =
  "This is a backup file exported from this app, not a command-line " +
  "alcove.yaml. A backup file is imported on its own, without a key file.";

/** The pair import's key file is over the cap, refused before it is read. */
export const OVERSIZE_KEY_FILE_REASON =
  "The key file is larger than a .alcove.key can be. Choose the " +
  ".alcove.key Alcove wrote beside this alcove.yaml and import the two " +
  "again. Nothing was imported.";

/**
 * Which refusal an alcove.yaml imported with its `.alcove.key` is shown as,
 * where the refusal is about the files. A configuration or key file this app
 * will not take states its own reason, escaped for display at this one
 * altitude; neither reason holds a byte of the key file. A backup file is named
 * as one; everything else leaves the configuration file to check.
 */
export function pairImportFailureReason(error: unknown): string {
  if (
    error instanceof ManagedConfigurationRefusedError ||
    error instanceof ManagedKeyFileRefusedError
  )
    return sanitizeErrorForDisplay(error);
  if (error instanceof ManagedImportBackupNotConfigurationError)
    return BACKUP_NOT_PAIR_REASON;
  return UNREADABLE_CONFIGURATION_REASON;
}

/** The heading an import is refused under when this browser already runs the
 * exchange its file belongs to. */
export const ALREADY_HELD_IMPORT_TITLE = "That exchange is already here";

/** What a refusal names a held exchange as: its label, or "That exchange". */
function heldName(label: string): string {
  return label === "" ? "That exchange" : `"${label}"`;
}

/** What a held-exchange refusal says where the held record's saved state does
 * not parse: its page cannot be opened, so the way on is to remove it and
 * import `what` again. */
function unreadableHeldReason(
  label: string,
  secret: string,
  what: string,
): string {
  return (
    `${heldName(label)} is in this browser with ${secret}, but part of its ` +
    "saved state cannot be read, so it cannot be opened. Remove it from the " +
    `list, then import ${what} again.`
  );
}

/** The refusal a pair import meets when a record this browser runs already
 * holds the key file's secret: it is the same exchange, so nothing is added.
 * `stateUnreadable` where that record's saved state does not parse. */
export function alreadyHeldImportReason(
  label: string,
  stateUnreadable = false,
): string {
  if (stateUnreadable)
    return unreadableHeldReason(
      label,
      "the secret this .alcove.key holds",
      "these files",
    );
  return (
    `${heldName(label)} already runs in this browser with the secret this ` +
    ".alcove.key holds, so nothing was imported. Open it from the list. If " +
    "the command line runs it on a schedule too, stop one of the two: each " +
    "run changes the shared secret, and the copy that falls behind can no " +
    "longer connect to your partner."
  );
}

/** The refusal a backup import meets when a record this browser runs already
 * holds the backup's secret: it is the same exchange, and nothing is added.
 * `stateUnreadable` where that record's saved state does not parse. */
export function alreadyHeldBackupImportReason(
  label: string,
  stateUnreadable = false,
): string {
  if (stateUnreadable)
    return unreadableHeldReason(label, "this backup's secret", "this backup");
  return (
    `${heldName(label)} already runs in this browser with the secret this ` +
    "backup file holds, so nothing was imported. Open it from the list to " +
    "run it."
  );
}

/** The heading a backup import stops under when a listed exchange has the
 * backup's agreed terms and side. */
export const LIVE_COPY_IMPORT_TITLE =
  "This may be an exchange you already have";

/** The listed names a several-exchange question gives in brackets: each label,
 * then a count of those with none. Empty when none is named. */
function listedNames(labels: ReadonlyArray<string>): string {
  const names = labels.filter((label) => label !== "").map((l) => `"${l}"`);
  const unnamed = labels.length - names.length;
  return names.length === 0
    ? ""
    : ` (${names.join(", ")}${unnamed === 0 ? "" : `, and ${unnamed} with no name`})`;
}

/** The sentences stating the order each listed exchange of several has
 * against the import, where the rotation histories found one: `subject` is
 * the import as the question names it. Empty where none was found. */
function listedOrders(
  copies: ReadonlyArray<ManagedStoredCopy>,
  subject: "This backup is" | "These files are",
): string {
  return copies
    .map(({ label, order }, index) => {
      if (order === undefined) return "";
      const named =
        label === "" ? `listed exchange ${index + 1}` : `"${label}"`;
      return ` ${subject} ${order === "import-newer" ? "newer" : "older"} than ${named}.`;
    })
    .join("");
}

/**
 * What a backup import says when it stops to ask: one or more listed exchanges
 * have the same agreed terms and side, and a different secret. Either copy may
 * be the newer -- the backup, where the exchange ran elsewhere since, or the
 * saved copy, where it ran here since the backup was taken. Where the two
 * rotation histories order them ({@link ManagedStoredCopy.order}) the question
 * states that order; otherwise it states when each answer fits. Either way the
 * operator chooses: replace the saved copy, keep it, or add the backup as a
 * separate exchange with the same terms. A listed exchange holding a
 * configuration only never ran here, so the backup completes it where it is of
 * that exchange. Nothing is imported until they answer.
 */
export function liveCopyImportReason(
  copies: ReadonlyArray<ManagedStoredCopy>,
): string {
  const separate =
    " If this is a separate exchange with the same terms, add the backup as a " +
    "new exchange.";
  if (copies.length === 1) {
    const [{ label, state, order }] = copies;
    const named = label === "" ? "An exchange in the list" : `"${label}"`;
    if (state === "configuration-only")
      return (
        `${named} holds a configuration without its key file and has the ` +
        "same terms and the same side as this backup. Nothing was imported. " +
        "If the backup is of that exchange, replace the saved copy with it." +
        separate
      );
    const found =
      `${named} has the same terms and the same side as this backup, with a ` +
      "different secret. Nothing was imported.";
    if (order === "import-newer")
      return (
        `${found} This backup is newer than the saved copy: replace the ` +
        "saved copy with it, and the saved copy's run history and accounting " +
        "of disclosures are kept." +
        separate
      );
    if (order === "import-older")
      return (
        `${found} This backup is older than the saved copy, so keep the ` +
        "saved copy." +
        separate
      );
    return (
      `${found} If the exchange ran on ` +
      "another device since the saved copy last ran here, this backup is the " +
      "newer one: replace the saved copy with it, and the saved copy's run " +
      "history and accounting of disclosures are kept. If this backup is " +
      "older than the saved copy, keep the saved copy." +
      separate
    );
  }
  const names = listedNames(copies.map(({ label }) => label));
  const orders = listedOrders(copies, "This backup is");
  if (copies.every(({ state }) => state === "runs-here"))
    return (
      `${copies.length} exchanges in the list${names} have the same terms ` +
      "and the same side as this backup, with different secrets. Nothing was " +
      "imported. If the exchange ran on another device since one of them " +
      "last ran here, this backup is the newer one: replace that saved copy " +
      "with it, and its run history and accounting of disclosures are kept. " +
      "If this backup is older, keep the saved copies." +
      orders +
      separate
    );
  const runsHere = copies.some(({ state }) => state === "runs-here");
  return (
    `${copies.length} exchanges in the list${names} have the same terms and ` +
    "the same side as this backup, and none holds its secret. Nothing was " +
    "imported. If the backup is of one of them, replace that saved copy with " +
    "it." +
    (runsHere
      ? " Replace one that runs here only if the exchange ran on another " +
        "device since it last ran here: its run history and accounting of " +
        "disclosures are kept."
      : "") +
    orders +
    separate
  );
}

/** The button replacing the listed exchange at `index` of `labels` with the
 * backup, from {@link liveCopyImportReason}'s alert: one button when one
 * exchange is listed, else one per exchange, named by its label or its place
 * in the list. */
export function liveCopyReplaceLabel(
  labels: ReadonlyArray<string>,
  index: number,
): string {
  if (labels.length === 1) return "Replace the saved copy";
  const label = labels[index];
  return label === ""
    ? `Replace listed exchange ${index + 1}`
    : `Replace "${label}"`;
}

/** The button on {@link liveCopyImportReason}'s alert that imports nothing
 * and keeps the `count` listed exchanges as they are. */
export function liveCopyKeepLabel(count: number): string {
  return count === 1 ? "Keep the saved copy" : "Keep the saved copies";
}

/** The button on {@link liveCopyImportReason}'s alert that adds the backup
 * beside every listed exchange. */
export const LIVE_COPY_IMPORT_CONFIRM = "Add as a new exchange";

/** The heading a pair import stops under when a stored exchange it may belong
 * to has its agreed terms and side. */
export const STORED_COPY_IMPORT_TITLE =
  "These files may belong to an exchange you already have";

/**
 * What a pair import says when it stops to ask: no stored exchange holds the
 * key file's secret, and one or more have its agreed terms and side. One that
 * holds a configuration only is completed with the files; one that runs here
 * is replaced by them, and as on the backup import, either copy may be the
 * newer, so the question states the order the rotation histories found, if
 * any, and the operator chooses. Two exchanges can share terms and side, so
 * nothing is imported until they answer.
 */
export function storedCopyImportReason(
  copies: ReadonlyArray<ManagedStoredCopy>,
): string {
  const separate =
    " If this is a separate exchange with the same terms, add these files as " +
    "a new one.";
  if (copies.length === 1) {
    const [{ label, state, order }] = copies;
    const named = label === "" ? "An exchange in the list" : `"${label}"`;
    if (state === "configuration-only")
      return (
        `${named} holds a configuration without its key file and has the ` +
        "same terms and the same side as these files - this key file may be " +
        "the one it lacks. Nothing was imported. If they belong to it, " +
        "complete it with these files." +
        separate
      );
    const found =
      `${named} runs in this browser and has the same terms and the same ` +
      "side as these files, with a different secret. Nothing was imported.";
    if (order === "import-newer")
      return (
        `${found} These files are newer than the saved copy: replace the ` +
        "saved copy with them, and its run history and accounting of " +
        "disclosures are kept." +
        separate
      );
    if (order === "import-older")
      return (
        `${found} These files are older than the saved copy, so cancel to ` +
        "keep the saved copy." +
        separate
      );
    return (
      `${found} ` +
      "If the exchange ran from these files since the saved copy last ran " +
      "here, they are the newer copy: replace the saved copy with them, and " +
      "its run history and accounting of disclosures are kept. If these " +
      "files are older than the saved copy, cancel to keep the saved copy." +
      separate
    );
  }
  const runsHere = copies.some(({ state }) => state === "runs-here");
  return (
    `${copies.length} exchanges in the list` +
    `${listedNames(copies.map(({ label }) => label))} have the same terms ` +
    "and the same side as these files, and none holds their secret. Nothing " +
    "was imported. If they belong to one of them, choose it below." +
    (runsHere
      ? " Replace one that runs here only if the exchange ran from these " +
        "files since it last ran here: its run history and accounting of " +
        "disclosures are kept."
      : "") +
    listedOrders(copies, "These files are") +
    separate
  );
}

/** The button taking the pair into the stored exchange at `index` of `copies`
 * from {@link storedCopyImportReason}'s alert, in the words of what it does
 * to that exchange, named by its label or its place in the list. */
export function storedCopyTakeLabel(
  copies: ReadonlyArray<ManagedStoredCopy>,
  index: number,
): string {
  const { label, state } = copies[index];
  if (state === "runs-here") {
    const named =
      label !== ""
        ? `"${label}"`
        : copies.length === 1
          ? "the saved copy"
          : `listed exchange ${index + 1}`;
    return `Replace ${named}`;
  }
  const named =
    label !== ""
      ? `"${label}"`
      : copies.length === 1
        ? "it"
        : `listed exchange ${index + 1}`;
  return `Complete ${named}`;
}

/** The decline on {@link storedCopyImportReason}'s alert: the pair installs as
 * a new exchange beside every one named. */
export const STORED_COPY_IMPORT_CONFIRM = "Add them as a new exchange";

/** The heading an import is refused under when the exchange the operator
 * chose to take it in can no longer take it. */
export const CHOSEN_COPY_IMPORT_TITLE = "Nothing was imported";

/** Why the exchange the operator chose could not take the import, and what to
 * do: wait for a run to finish, or import `what` again to be asked afresh. */
export function chosenCopyImportReason(
  reason: ManagedChosenCopyRefusal,
  what: "backup" | "files",
): string {
  const again = what === "backup" ? "the backup" : "the files";
  return reason === "run-in-flight"
    ? "That exchange is running right now - in this browser, in another " +
        "tab, or on its schedule - so nothing was imported. When the run " +
        `finishes, import ${again} again.`
    : "That exchange changed since you chose it - it was deleted or edited " +
        `- so nothing was imported. Import ${again} again.`;
}
