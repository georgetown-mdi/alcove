import path from "node:path";

import { JOB_FILE_NAMES } from "@jobContract/intentSchemas";
import { jobPathPresent } from "./workdir";
import { runArtifactKindsIn } from "./runArtifacts";

/**
 * Which of a run's files its folder holds, as named presence flags only: the
 * files the operator may want to keep before the folder is deleted. Presence is
 * an `lstat` or a directory listing, so a file the console cannot read still
 * counts, since deleting the folder removes it all the same. A run artifact
 * counts for whichever run wrote it, since the discard deletes them all.
 */
export interface JobFolderContents {
  /** A matched result, `alcove-results-<time>.csv`. */
  results: boolean;
  /** Either half of an exchange-record pair, or its agreed-terms file. */
  record: boolean;
  /** The key file holding the shared secret, {@link JOB_FILE_NAMES.key}. */
  sharedSecret: boolean;
  /** A signed receipt, `alcove-receipt-<time>.json`. */
  receipt: boolean;
  /** The diagnostic log. */
  log: boolean;
  /** The operator's input written for an inline intent,
   * {@link JOB_FILE_NAMES.input}. */
  input: boolean;
}

/**
 * What a job's folder holds and whether the console still holds the job: `live`
 * false is a folder a restart left behind, which the console no longer runs or
 * serves files from.
 */
export interface JobFolderView {
  live: boolean;
  contents: JobFolderContents;
}

/** Read which of a run's files are in `workdir`, an already-resolved job
 * workdir. */
export function readJobFolderContents(workdir: string): JobFolderContents {
  const present = (name: string) => jobPathPresent(path.join(workdir, name));
  const artifacts = runArtifactKindsIn(workdir);
  return {
    results: artifacts.has("result"),
    record:
      artifacts.has("record") ||
      artifacts.has("keys") ||
      artifacts.has("terms"),
    sharedSecret: present(JOB_FILE_NAMES.key),
    receipt: artifacts.has("receipt"),
    log: present(JOB_FILE_NAMES.log),
    input: present(JOB_FILE_NAMES.input),
  };
}
