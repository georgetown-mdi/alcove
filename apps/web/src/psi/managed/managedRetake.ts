/**
 * Taking back a managed exchange this browser handed to the command line, with
 * the command-line run's `alcove.yaml` and `.alcove.key` when scheduled runs
 * have rotated the secret since. The files are untrusted and read by the pair
 * import's reader; the store's re-take checks the pair and writes. Contract:
 * docs/spec/MANAGED_EXCHANGE_RECORD.md, "Taking a command-line hand-off back".
 */

import { readManagedCommandLinePair } from "./managedCommandLineImport";
import { retakeHandedOffManagedExchange } from "./managedExchangeStore";

import type { ManagedRetakeOutcome } from "./managedExchangeStore";
import type { RunnableManagedExchangeRecord } from "./managedExchangeRecord";

/** A command-line run's `alcove.yaml` and the `.alcove.key` beside it, as text. */
export interface ManagedRetakeFiles {
  configuration: string;
  key: string;
}

/** The platform boundaries the take-back drives, injected for tests. */
export interface ManagedRetakeDeps {
  /** The store's re-take: checks `taken` against the record, installs its
   * secret and clears the spent state, under the run+rotate lock. */
  retake: (
    id: string,
    at: string,
    taken?: RunnableManagedExchangeRecord,
  ) => Promise<ManagedRetakeOutcome>;
  /** The moment of the take-back. */
  now: () => Date;
}

const defaultDeps: ManagedRetakeDeps = {
  retake: retakeHandedOffManagedExchange,
  now: () => new Date(),
};

/**
 * How a take-back ended: the store's outcomes, or `"unreadable-files"` when the
 * reader refused the chosen files and the store was never reached.
 */
export type ManagedRetakeResult =
  ManagedRetakeOutcome | { kind: "unreadable-files" };

/**
 * Take a handed-off exchange back. `files` is `undefined` when no scheduled run
 * has happened since the hand-off and the stored secret is still current. A pair
 * the reader refuses leaves the store untouched.
 *
 * @throws {ZodError} if the store write produces an invalid record; nothing is
 *   written.
 */
export async function retakeManagedExchange(
  id: string,
  files?: ManagedRetakeFiles,
  deps: ManagedRetakeDeps = defaultDeps,
): Promise<ManagedRetakeResult> {
  let taken: RunnableManagedExchangeRecord | undefined;
  if (files !== undefined) {
    try {
      taken = readManagedCommandLinePair(files.configuration, files.key);
    } catch {
      return { kind: "unreadable-files" };
    }
  }
  return deps.retake(id, deps.now().toISOString(), taken);
}
