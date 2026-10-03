import path from "node:path";

import { JOB_FILE_NAMES } from "./intentSchemas";
import { jobPathPresent } from "./workdir";

/**
 * Which of a run's files its folder holds, as named presence flags only: the
 * files the operator may want to keep before the folder is deleted. Presence is
 * an `lstat`, so a file the console cannot read still counts, since deleting the
 * folder removes it all the same.
 */
export interface JobFolderContents {
  /** The matched result, {@link JOB_FILE_NAMES.output}. */
  results: boolean;
  /** Either half of the exchange-record pair. */
  record: boolean;
  /** The key file holding the shared secret, {@link JOB_FILE_NAMES.key}. */
  sharedSecret: boolean;
  /** The dual-signed receipt. */
  receipt: boolean;
  /** The diagnostic log. */
  log: boolean;
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
  return {
    results: present(JOB_FILE_NAMES.output),
    record:
      present(JOB_FILE_NAMES.record) || present(JOB_FILE_NAMES.recordKeys),
    sharedSecret: present(JOB_FILE_NAMES.key),
    receipt: present(JOB_FILE_NAMES.receipt),
    log: present(JOB_FILE_NAMES.log),
  };
}
