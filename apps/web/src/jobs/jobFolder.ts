import path from "node:path";

import { JOB_FILE_NAMES } from "@jobContract/intentSchemas";
import { jobPathPresent } from "./workdir";
import { runArtifactKindsIn } from "./runArtifacts";

import type { JobFolderContents } from "@jobContract/jobFolderContents";

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
