import { JOB_FILE_NAMES } from "@jobContract/intentSchemas";
import { RUN_ARTIFACT_NAME_PATTERNS } from "@jobContract/runArtifactNames";

import { folderHoldsKeepableFiles } from "@psi/jobClient/jobFolder";

import { useJobFolder } from "./useJobFolder";

import type { JobFolderAnswer } from "@psi/jobClient/jobFolder";
import type { JobFolderContents } from "@jobs/jobFolder";

/** A run's folder as a discard confirm names it: the folder's name inside the
 * console's working directory, and which of the run's files it holds. */
export interface DiscardFolder {
  name: string;
  contents: JobFolderContents;
}

/**
 * The folder a confirm names, or undefined where the console did not answer or
 * the folder holds none of the files a discard would cost. A console job's
 * folder is named by its job id.
 */
export function discardFolderFor(
  jobId: string | undefined,
  answer: JobFolderAnswer | undefined,
): DiscardFolder | undefined {
  if (jobId === undefined || answer?.kind !== "present") return undefined;
  if (!folderHoldsKeepableFiles(answer)) return undefined;
  return { name: jobId, contents: answer };
}

/**
 * The run's folder and what in it a discard deletes, for every confirm that
 * discards the run to name. `jobId` undefined means no console job. Undefined
 * until the console answers for this job and phase (see {@link useJobFolder}).
 */
export function useDiscardFolder(
  jobId: string | undefined,
  settled: boolean,
): DiscardFolder | undefined {
  return discardFolderFor(jobId, useJobFolder(jobId, settled));
}

/** One line per file the folder holds, each naming the file as it is on disk
 * and what it is. A run's own files hold the time it ran in their names, which
 * the folder answer does not state, so `<time>` stands in for it. */
export function discardFolderItems(contents: JobFolderContents): Array<{
  files: string;
  what: string;
}> {
  const items: Array<{ files: string; what: string }> = [];
  if (contents.results)
    items.push({
      files: RUN_ARTIFACT_NAME_PATTERNS.result,
      what: "the matched result",
    });
  if (contents.record)
    items.push({
      files: `${RUN_ARTIFACT_NAME_PATTERNS.record}, ${RUN_ARTIFACT_NAME_PATTERNS.keys} and ${RUN_ARTIFACT_NAME_PATTERNS.terms}`,
      what: "the exchange record, its verification keys and the agreed terms",
    });
  if (contents.sharedSecret)
    items.push({
      files: JOB_FILE_NAMES.key,
      what: "the shared secret; your next run of this exchange with your partner needs it",
    });
  if (contents.receipt)
    items.push({
      files: RUN_ARTIFACT_NAME_PATTERNS.receipt,
      what: "the signed receipt",
    });
  if (contents.log)
    items.push({ files: JOB_FILE_NAMES.log, what: "the diagnostic log" });
  if (contents.input)
    items.push({ files: JOB_FILE_NAMES.input, what: "your input file" });
  return items;
}

/**
 * The list a discard confirm shows under its own text: the run's folder by name
 * and each file in it that the discard deletes, so the operator can copy out
 * what they need first.
 */
export function DiscardFolderList({ folder }: { folder: DiscardFolder }) {
  const items = discardFolderItems(folder.contents);
  if (items.length === 0)
    return (
      <p>
        This deletes the folder <code>{folder.name}</code> in the console&apos;s
        working directory.
      </p>
    );
  return (
    <>
      <p>
        This deletes the folder <code>{folder.name}</code> in the console&apos;s
        working directory, with:
      </p>
      <ul>
        {items.map((item) => (
          <li key={item.files}>
            <code>{item.files}</code> -- {item.what}
          </li>
        ))}
      </ul>
      <p>Copy out anything you need from that folder first.</p>
    </>
  );
}
