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
  /** The key file holding the shared secret, `JOB_FILE_NAMES.key`. */
  sharedSecret: boolean;
  /** A signed receipt, `alcove-receipt-<time>.json`. */
  receipt: boolean;
  /** The diagnostic log. */
  log: boolean;
  /** The operator's input written for an inline intent,
   * `JOB_FILE_NAMES.input`. */
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
