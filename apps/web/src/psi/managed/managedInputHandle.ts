/**
 * The input side of a managed (recurring) exchange's working folder: the
 * platform layer the runner, the run surface, and the schedule surface call to
 * read a run's input by its one conventioned name, {@link MANAGED_INPUT_FILE_NAME},
 * from the folder the operator granted, check and request permission where the
 * platform offers it, and read the file's last-modified instant for display.
 *
 * The record holds a `FileSystemDirectoryHandle`, never file content, and every
 * run resolves the name afresh through `getFileHandle` and reads it with
 * `getFile()` at run start rather than retaining a `File` or a file handle
 * across runs (see docs/MANAGED_EXCHANGE.md, "The input file each run", and
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, the `workingDirectoryHandle` row). The
 * app reads exactly that one name from the folder and never enumerates it; the
 * results write beside it is {@link ./managedWorkingDirectory.ts}, and
 * `unattendedRuntimeBoundaries.test.ts` holds both to that.
 *
 * The pure standing-terms guard and the input-rejection classification are in
 * {@link ./managedInputGuard.ts}; this module composes them with the platform reads
 * so a run-start acquisition failure or a linkage shortfall each shows as the
 * same benign {@link ManagedInputError}, before any connection, on every run path.
 *
 * The permission layer is a non-standard File System Access extension
 * (`queryPermission` / `requestPermission`) the DOM lib does not type; some handle
 * sources (a picker handle) offer it while others (an origin-private-file-system
 * handle) do not. Reached through {@link browserHandlePermission}, which
 * feature-detects the methods and treats their absence as an already-usable grant;
 * {@link HandlePermissionQuery} stays injectable for tests that cannot summon
 * a real picker grant. It takes any {@link FileSystemHandle} in either mode, so
 * the results write applies the same unattended rule -- query, never prompt.
 */

import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";

import { loadCSVFileOffMainThread } from "../workers/csvParseController";

import {
  ManagedInputError,
  assessManagedInputColumns,
} from "./managedInputGuard";

import type { ExchangeSpec } from "@alcove/core";

import type { CSVParseRows } from "../workers/csvParseController";

/** The one name a run reads its input by, inside the exchange's working folder.
 * It is the name the command-line export's emitted command reads
 * ({@link ./managedCronExport.ts}, `CRON_EXPORT_INPUT_FILE_NAME`), so an exchange
 * taken to the command line keeps the same folder layout. */
export const MANAGED_INPUT_FILE_NAME = "input.csv";

/** Raised when the working folder holds no file under
 * {@link MANAGED_INPUT_FILE_NAME} at run start. Set as the `cause` of the benign
 * {@link ManagedInputError} `"acquire"` rejection, holding the file name looked
 * for and the folder's own name so the run surface can name both. */
export class ManagedInputFileMissingError extends Error {
  /** The name the run looked for. */
  readonly fileName: string;
  /** The working folder's own name, the leaf its handle reports. */
  readonly folderName: string;
  constructor(fileName: string, folderName: string, options?: ErrorOptions) {
    super(`no ${fileName} in the folder ${folderName}`, options);
    this.name = "ManagedInputFileMissingError";
    this.fileName = fileName;
    this.folderName = folderName;
  }
}

/**
 * Resolve {@link MANAGED_INPUT_FILE_NAME} in `directory` afresh and return the
 * file handle it names: the one lookup the app makes in the folder. A folder
 * holding no file under that name, or a folder under it, throws
 * {@link ManagedInputFileMissingError}; any other refusal is rethrown as the
 * platform raised it.
 */
async function inputFileHandleIn(
  directory: FileSystemDirectoryHandle,
): Promise<FileSystemFileHandle> {
  try {
    return await directory.getFileHandle(MANAGED_INPUT_FILE_NAME);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "NotFoundError" || error.name === "TypeMismatchError")
    )
      throw new ManagedInputFileMissingError(
        MANAGED_INPUT_FILE_NAME,
        directory.name,
        { cause: error },
      );
    throw error;
  }
}

/**
 * The permission state a handle reports: `"granted"` is used without a prompt,
 * `"denied"` cannot be used, and `"prompt"` needs an operator gesture to grant.
 * Mirrors the `PermissionState` the File System Access permission methods return.
 * A handle whose source does not implement the permission extension is treated as
 * `"granted"` -- there is no separate permission to hold, so the access is
 * governed only by whether the entry still exists.
 */
export type HandlePermissionState = "granted" | "denied" | "prompt";

/** What a handle is being used for: reading the input file, or writing a results
 * file into the working folder. The mode the grant is queried and requested
 * under, and a `"read"` grant does not admit a write. */
export type HandlePermissionMode = "read" | "readwrite";

/** The `queryPermission` / `requestPermission` extension a File System Access
 * handle MAY hold (a picker handle does; an origin-private-file-system handle does
 * not). Declared locally because the DOM lib does not type these non-standard
 * methods; a handle is narrowed to it by {@link browserHandlePermission} through a
 * runtime feature check rather than an unchecked cast. */
interface FileSystemHandlePermission {
  queryPermission?: (descriptor: {
    mode: HandlePermissionMode;
  }) => Promise<HandlePermissionState>;
  requestPermission?: (descriptor: {
    mode: HandlePermissionMode;
  }) => Promise<HandlePermissionState>;
}

/** The one operation the permission layer performs, factored into an interface so
 * a run path can query without prompting (unattended) or request with a gesture
 * (attended), and so a test can inject an outcome a real origin-private-file-
 * system handle cannot report. The default is {@link browserHandlePermission},
 * the feature-detecting platform implementation. */
export interface HandlePermissionQuery {
  /** Report the handle's current permission state for `mode` WITHOUT prompting --
   * the only check the unattended path may make, since a scheduled run has no
   * operator to answer a prompt. */
  query: (
    handle: FileSystemHandle,
    mode: HandlePermissionMode,
  ) => Promise<HandlePermissionState>;
  /** Prompt for permission in `mode` where the state is `"prompt"`, returning the
   * state after the operator answers. Called only on an attended path (a gesture is
   * present). */
  request: (
    handle: FileSystemHandle,
    mode: HandlePermissionMode,
  ) => Promise<HandlePermissionState>;
}

/**
 * The platform permission layer: feature-detects the handle's non-standard
 * `queryPermission` / `requestPermission` methods and, when they are absent (an
 * origin-private-file-system handle, a runtime without the extension), reports
 * `"granted"` -- there is no separate permission to hold, so the access is
 * governed only by whether the entry still exists. Never prompts on `query`; prompts
 * on `request` only where the method exists.
 */
const browserHandlePermission: HandlePermissionQuery = {
  query: (handle, mode) => {
    const permission = handle as unknown as FileSystemHandlePermission;
    if (permission.queryPermission === undefined)
      return Promise.resolve("granted");
    return permission.queryPermission({ mode });
  },
  request: (handle, mode) => {
    const permission = handle as unknown as FileSystemHandlePermission;
    if (permission.requestPermission === undefined)
      return Promise.resolve("granted");
    return permission.requestPermission({ mode });
  },
};

/** Raised when a handle is held but its permission cannot be secured for a run:
 * the unattended path found a non-`"granted"` state (it must not prompt), or an
 * attended request was denied or rejected (the rejection kept as `cause`). On
 * the input side it is set as the `cause` of the benign {@link ManagedInputError}
 * `"acquire"` rejection, so a gone permission records the same benign `"input"`
 * failure as a missing file, never desync/attack framing. */
export class HandlePermissionError extends Error {
  /** The permission state that blocked the access. */
  readonly state: HandlePermissionState;
  /** The mode the blocked access needed. */
  readonly mode: HandlePermissionMode;
  constructor(
    state: HandlePermissionState,
    mode: HandlePermissionMode,
    options?: ErrorOptions,
  ) {
    super(`managed exchange handle ${mode} permission is ${state}`, options);
    this.name = "HandlePermissionError";
    this.state = state;
    this.mode = mode;
  }
}

/** How a run secures a handle's permission: an unattended (scheduled) run may only
 * proceed on an EXISTING grant and must never prompt; an attended run may request
 * the grant with the operator's gesture. */
export type ManagedRunAttendance = "unattended" | "attended";

/**
 * Secure permission in `mode` for `handle` for a run of the given `attendance`, or
 * throw {@link HandlePermissionError}. The unattended path queries only: a
 * non-`"granted"` state throws (the unattended path may only proceed on an
 * existing grant; it must not prompt). The attended path may additionally
 * request where the state is `"prompt"`; a request the browser rejects (a
 * `SecurityError` where it will not show the prompt) throws
 * {@link HandlePermissionError} too, so it is reported as a permission failure.
 */
export async function ensureHandlePermission(
  handle: FileSystemHandle,
  attendance: ManagedRunAttendance,
  mode: HandlePermissionMode,
  permission: HandlePermissionQuery = browserHandlePermission,
): Promise<void> {
  const current = await permission.query(handle, mode);
  if (current === "granted") return;
  if (attendance === "unattended")
    throw new HandlePermissionError(current, mode);
  if (current === "denied") throw new HandlePermissionError("denied", mode);
  let afterPrompt: HandlePermissionState;
  try {
    afterPrompt = await permission.request(handle, mode);
  } catch (rejection) {
    throw new HandlePermissionError(current, mode, { cause: rejection });
  }
  if (afterPrompt !== "granted")
    throw new HandlePermissionError(afterPrompt, mode);
}

/**
 * Secure the permission a run's input read needs on the working folder. An
 * attended run asks in `readwrite` first, so one answer also covers the results
 * write after the run, which only queries. Where edit is refused it asks in
 * `read`, so the input is still read and the write reports not allowed; a
 * refusal of both names `read`. An unattended run queries `read` and never
 * prompts.
 */
async function secureInputReadPermission(
  directory: FileSystemDirectoryHandle,
  attendance: ManagedRunAttendance,
  permission: HandlePermissionQuery,
): Promise<void> {
  if (attendance === "unattended") {
    await ensureHandlePermission(directory, "unattended", "read", permission);
    return;
  }
  try {
    await ensureHandlePermission(
      directory,
      "attended",
      "readwrite",
      permission,
    );
  } catch (refused) {
    if (!(refused instanceof HandlePermissionError)) throw refused;
    await ensureHandlePermission(directory, "attended", "read", permission);
  }
}

/** A read input for one run: the `File` read at run start
 * (never retained across runs), its parsed CSV rows, and its column names -- what
 * the column-shape guard and the exchange consume. The rows ride the same parse
 * that produced the columns, so a run reads and parses the input exactly once;
 * like the `File`, they are this run's only and are never persisted or retained
 * across runs (the no-second-copy invariant is about the record, which never
 * holds them). */
interface AcquiredManagedInput {
  /** The `File` read at THIS run start (a point-in-time
   * reference; never persisted or retained across runs). */
  file: File;
  /** The read file's parsed CSV rows, from the same parse as {@link columns}, so
   * the run does not parse the file a second time. This run's only; never
   * persisted. */
  rows: CSVParseRows;
  /** The read file's CSV column names, for the column-shape guard and the
   * exchange. */
  columns: Array<string>;
}

/** How a run supplies its input file, per platform and path. `folder` reads
 * {@link MANAGED_INPUT_FILE_NAME} from the exchange's persisted working folder
 * (the unattended and one-action paths); `file` takes an operator-selected `File`
 * directly (the re-selection path on a browser that cannot grant a folder).
 * Exactly one is set. */
export type ManagedInputSource =
  | {
      /** Read the input by its conventioned name from the working folder, the
       * name resolved and the file read at run start. */
      kind: "folder";
      directory: FileSystemDirectoryHandle;
      /** The run's attendance, gating whether a gone permission may be re-prompted
       * (attended) or must fail benignly (unattended). */
      attendance: ManagedRunAttendance;
    }
  | {
      /** An operator-selected file on a browser that cannot grant a folder
       * (re-selection). */
      kind: "file";
      file: File;
    };

/**
 * Read a run's input through its source and parse its column names, throwing a
 * benign {@link ManagedInputError} `"acquire"` rejection on any failure BEFORE
 * the column guard or any connection: no file under the conventioned name
 * ({@link ManagedInputFileMissingError}), a gone or refused read permission, a
 * file over the intake cap (`MAX_CSV_FILE_BYTES`), or an unreadable file. The
 * `File` is read at THIS run start and never retained across runs. On the folder
 * path, permission is secured first.
 *
 * `csvDelimiter` is the field-delimiter choice the record stored for this
 * input; omit it to read by a comma, which is what a record storing none is read
 * by.
 *
 * @throws {ManagedInputError} an `"acquire"` rejection holding the underlying
 *   error, so the runner records the benign `"input"` failure and knows no
 *   connection was attempted.
 */
export async function acquireManagedInput(
  source: ManagedInputSource,
  permission: HandlePermissionQuery = browserHandlePermission,
  csvDelimiter?: string,
): Promise<AcquiredManagedInput> {
  let file: File;
  try {
    if (source.kind === "folder") {
      await secureInputReadPermission(
        source.directory,
        source.attendance,
        permission,
      );
      file = await (await inputFileHandleIn(source.directory)).getFile();
    } else {
      file = source.file;
    }
  } catch (cause) {
    throw new ManagedInputError({ reason: "acquire", cause });
  }
  // The intake cap every attended file selection applies, held here for the
  // file the working folder or a re-selection hands the run.
  if (file.size > MAX_CSV_FILE_BYTES) {
    const maxMb = MAX_CSV_FILE_BYTES / 1024 ** 2;
    throw new ManagedInputError({
      reason: "acquire",
      cause: new Error(
        `The input file is larger than the ${maxMb} MB maximum. Choose a CSV file under ${maxMb} MB.`,
      ),
    });
  }

  let rows: CSVParseRows;
  let columns: Array<string>;
  try {
    const parsed = await loadCSVFileOffMainThread(file, {
      ...(csvDelimiter !== undefined ? { delimiter: csvDelimiter } : {}),
    });
    rows = parsed.data;
    columns = parsed.meta.fields ?? [];
  } catch (cause) {
    throw new ManagedInputError({ reason: "acquire", cause });
  }
  return { file, rows, columns };
}

/**
 * The last-modified instant of the file under {@link MANAGED_INPUT_FILE_NAME} in
 * the working folder, in epoch milliseconds, or `undefined` where this browser
 * cannot read one: no standing read grant (queried, never prompted -- a page
 * being read is not a run), a missing or unreadable entry, or a platform
 * reporting no usable value.
 *
 * It resolves rather than rejects on each of those, because what it feeds is a
 * display note beside the schedule: a file a run cannot read is that run's own
 * benign input failure to report, and a second account of it here would put an
 * error beside a page running nothing.
 *
 * The `File` it reads is this read's only and is not returned, so the
 * no-second-copy invariant is untouched: the caller receives one number.
 */
export async function readInputFileModifiedAt(
  directory: FileSystemDirectoryHandle,
  permission: HandlePermissionQuery = browserHandlePermission,
): Promise<number | undefined> {
  try {
    await ensureHandlePermission(directory, "unattended", "read", permission);
    const { lastModified } = await (
      await inputFileHandleIn(directory)
    ).getFile();
    return Number.isFinite(lastModified) ? lastModified : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Acquire and validate a run's input against the record's standing terms in one
 * step, the guard every run path applies before any connection. Reads the input
 * through {@link acquireManagedInput} -- by the delimiter the stored document
 * states, so an unattended run reads the file the way the operator chose with
 * nobody there to choose again -- then rejects an input that cannot satisfy
 * every linkage key the standing terms declare as a benign `"columns"` rejection
 * ({@link assessManagedInputColumns}) -- never silently linked. Returns the read
 * `File` and its columns when the input is accepted.
 *
 * @throws {ManagedInputError} an `"acquire"` or `"columns"` rejection, both
 *   benign pre-run failures recorded under the kind each one's remedy calls for
 *   (`managedInputFailureKind` in {@link ./managedInputGuard.ts}).
 */
export async function acquireValidatedManagedInput(
  exchangeFile: ExchangeSpec,
  source: ManagedInputSource,
  permission: HandlePermissionQuery = browserHandlePermission,
): Promise<AcquiredManagedInput> {
  const acquired = await acquireManagedInput(
    source,
    permission,
    exchangeFile.csvDelimiter,
  );
  const rejection = assessManagedInputColumns(exchangeFile, acquired.columns);
  if (rejection !== undefined) throw new ManagedInputError(rejection);
  return acquired;
}
