/**
 * The working-folder grant of a managed exchange: the platform layer that asks
 * the operator for the one folder a run reads its input from and writes its
 * results into, reports whether this runtime can offer that at all, and writes
 * one run's results CSV into the folder. The input read, by its one conventioned
 * name, is {@link ./managedInputHandle.ts}.
 *
 * The grant is taken under an operator gesture -- where the exchange is put on
 * a schedule, or on the run surface -- never at run time: `showDirectoryPicker`
 * needs a user gesture, and a scheduled run has nobody to make one. At run time
 * the permission is queried and never prompted, through the permission layer in
 * {@link ./managedInputHandle.ts}, in `readwrite` mode for the results write.
 *
 * The folder is never enumerated: the results write looks up and creates only
 * the one name it writes, and removes only an entry that write created.
 *
 * Delivery is total: every outcome classifies rather than throwing
 * ({@link ResultsDelivery}), because the run it belongs to has already rotated
 * its secret and filed its disclosure. A grant this platform will not honour
 * without a prompt, and a write the folder refuses, each name themselves so the
 * caller keeps the results another way: a scheduled run parks them (see
 * {@link ./managedScheduleRuntime.ts}), and an attended run still offers the
 * download.
 *
 * What the record holds is the handle, never a path: the folder is named to the
 * operator by the handle's own `name`, which is the leaf the picker returned.
 */

import { runResultsFileName } from "../parkedResults";

import {
  HandlePermissionError,
  ensureHandlePermission,
} from "./managedInputHandle";

import type {
  HandlePermissionQuery,
  HandlePermissionState,
} from "./managedInputHandle";
import type { ManagedExchangeRecord } from "./managedExchangeRecord";

/** The directory picker the File System Access API offers, which the DOM lib does
 * not type. Declared locally, and reached only behind
 * {@link workingDirectoryGrantSupported}'s runtime feature check. */
interface DirectoryPicker {
  showDirectoryPicker?: (options: {
    mode: "read" | "readwrite";
    id?: string;
    startIn?: string;
  }) => Promise<FileSystemDirectoryHandle>;
}

/** The picker's `id`, so the browser reopens this app's folder grant where the
 * operator last took it rather than at an unrelated default. */
const WORKING_DIRECTORY_PICKER_ID = "alcove-exchange-folder";

/**
 * Whether this runtime can take a working-folder grant at all: the directory
 * picker exists. A `false` is what routes the surfaces to state that this
 * browser offers no folder grant, so each run is attended and the operator
 * chooses the input file for it. Never throws, so it is safe under SSR and on
 * older engines.
 */
export function workingDirectoryGrantSupported(): boolean {
  return (
    typeof (globalThis as DirectoryPicker).showDirectoryPicker === "function"
  );
}

/**
 * Whether a record's stored working-folder grant can be followed in this runtime:
 * a handle is held AND this engine has directory handles to follow it with. Both
 * halves are required, so the run path and the schedule surface decide it
 * identically.
 */
export function storedWorkingDirectoryUsable(
  handle: FileSystemDirectoryHandle | undefined,
): boolean {
  return (
    handle !== undefined &&
    typeof globalThis.FileSystemDirectoryHandle !== "undefined"
  );
}

/**
 * Ask the operator for the exchange's working folder, in `readwrite` mode so the
 * one grant covers both the input read and the results write. Resolves
 * `undefined` where the operator dismissed the picker, which is not a failure.
 *
 * MUST be called from a user gesture: the picker refuses otherwise, which is the
 * whole reason the grant is taken while the operator is present rather than at
 * run time.
 *
 * @throws if this runtime has no directory picker, or the picker refused for any
 *   reason other than the operator dismissing it.
 */
export async function chooseManagedWorkingDirectory(): Promise<
  FileSystemDirectoryHandle | undefined
> {
  const picker = (globalThis as DirectoryPicker).showDirectoryPicker;
  if (picker === undefined)
    throw new Error("this browser has no directory picker");
  try {
    return await picker({
      mode: "readwrite",
      id: WORKING_DIRECTORY_PICKER_ID,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return undefined;
    throw error;
  }
}

/** How delivering one run's results into the granted folder turned out. Every
 * outcome is a value: the run is already complete, so nothing here may reject. */
export type ResultsDelivery =
  /** The results are in the folder, under `fileName`. */
  | { kind: "written"; fileName: string; directoryName: string }
  /** The grant is not one this run may use without a prompt -- revoked, or a
   * state only an operator gesture could raise to `"granted"`. Nothing was
   * written, and nothing was prompted. */
  | { kind: "ungranted"; state: HandlePermissionState }
  /** The folder was granted and the write did not land: the entry could not be
   * created, or the stream refused the bytes. */
  | { kind: "write-failed"; error: unknown };

/** Whether the folder already holds an entry under this name, so a failed write
 * removes only an entry that write created itself. */
async function entryHeldAlready(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<boolean> {
  return directory.getFileHandle(fileName).then(
    () => true,
    () => false,
  );
}

/**
 * How long the removal keeps asking while the platform still holds the write lock
 * the aborted stream took; Chromium releases it a task turn after `abort()`
 * resolves. Measured worst case for the lock to clear: 13.4 ms after the first
 * refusal, over 2400 failed writes under load; 200 ms is about fifteen times that.
 * Measurement and method: docs/notes/output-directory-removal-lock.md.
 */
const REMOVAL_LOCK_BUDGET_MS = 200;

/** Whether a removal was refused because the write lock is still held, rather
 * than for a reason waiting cannot clear. */
function removalBlockedByLock(error: unknown): boolean {
  return error instanceof Error && error.name === "NoModificationAllowedError";
}

/** Drop the entry a failed write created, best-effort: a folder that refuses the
 * removal leaves the empty file behind, which a completed run may not fail over.
 * A refusal naming the lock is asked again until {@link REMOVAL_LOCK_BUDGET_MS}
 * is spent, since that lock outlives the abort that released the stream. */
async function dropCreatedEntry(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<void> {
  let deadline: number | undefined;
  for (;;) {
    try {
      await directory.removeEntry(fileName);
      return;
    } catch (error) {
      if (!removalBlockedByLock(error)) return;
      deadline ??= Date.now() + REMOVAL_LOCK_BUDGET_MS;
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

/**
 * Write one run's results CSV into the granted folder, under a name that holds
 * the exchange's label and the run's own instant so successive runs accumulate
 * rather than overwrite ({@link ../parkedResults.ts}, `runResultsFileName`).
 *
 * The permission is QUERIED in `readwrite` and never prompted: a scheduled run
 * has nobody present, and an attended run writes after its run has finished,
 * past the gesture a prompt needs. `permission` is the injectable permission
 * layer, defaulting to the platform's.
 *
 * A write that fails leaves the folder as it found it: the platform creates the
 * entry before any byte reaches it, so the empty file is removed rather than left
 * standing for results the caller then keeps in the browser.
 */
export async function writeResultsToWorkingDirectory(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  csv: Blob,
  permission?: HandlePermissionQuery,
): Promise<ResultsDelivery> {
  try {
    await ensureHandlePermission(
      directory,
      "unattended",
      "readwrite",
      permission,
    );
  } catch (error) {
    return {
      kind: "ungranted",
      state: error instanceof HandlePermissionError ? error.state : "denied",
    };
  }
  let writable: FileSystemWritableFileStream | undefined;
  let heldAlready = true;
  try {
    heldAlready = await entryHeldAlready(directory, fileName);
    const file = await directory.getFileHandle(fileName, { create: true });
    writable = await file.createWritable();
    await writable.write(csv);
    await writable.close();
    return { kind: "written", fileName, directoryName: directory.name };
  } catch (error) {
    // Aborting releases the stream a failed write left open; a stream that never
    // closes commits nothing. What it does not undo is the entry `getFileHandle`
    // created, which the removal takes -- and only when this write created it, so
    // a file the folder already held is never the one dropped.
    if (writable !== undefined) await writable.abort().catch(() => undefined);
    if (!heldAlready) await dropCreatedEntry(directory, fileName);
    return { kind: "write-failed", error };
  }
}

/** The diagnostic for a matched run whose results URL is not one its caller
 * allocated, so the caller holds no file to write or keep. `run` names the run,
 * and `consequence` what was therefore not done. Shared by the scheduled and
 * attended runs, which log the same condition. */
export function unallocatedResultsMessage(
  run: string,
  consequence: string,
): string {
  return (
    `${run}: the run's results file was not built through this runtime's ` +
    `own allocation, so ${consequence}`
  );
}

/** How writing one run's results into its exchange's working folder turned out:
 * `"no-folder"` where the record holds no grant this runtime can follow, so
 * nothing was attempted, and otherwise the folder's own {@link ResultsDelivery}. */
export type RunResultsFolderWrite = { kind: "no-folder" } | ResultsDelivery;

/**
 * Write a completed run's results CSV into the working folder its record holds,
 * under {@link runResultsFileName}'s name for the record's label and the run's
 * own instant. The one entry both a scheduled run and an attended run write
 * through, so the two leave the same file under the same name.
 *
 * Never rejects, and never prompts ({@link writeResultsToWorkingDirectory}).
 */
export async function writeRunResultsToWorkingFolder(
  record: Pick<ManagedExchangeRecord, "label" | "workingDirectoryHandle">,
  runAt: string,
  csv: Blob,
  permission?: HandlePermissionQuery,
): Promise<RunResultsFolderWrite> {
  const directory = record.workingDirectoryHandle;
  if (directory === undefined || !storedWorkingDirectoryUsable(directory))
    return { kind: "no-folder" };
  return writeResultsToWorkingDirectory(
    directory,
    runResultsFileName(record.label, runAt),
    csv,
    permission,
  );
}
