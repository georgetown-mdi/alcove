import { useEffect, useState } from "react";

import { fetchJobFolder } from "@psi/jobClient/jobFolder";

import type { JobFolderAnswer } from "@psi/jobClient/jobFolder";

/**
 * Ask the console which of a console run's files its folder holds, for the
 * confirms that delete it to name them.
 *
 * `jobId` undefined means no console job, and nothing is asked. The ask is made
 * again when `settled` turns true, since a run writes its results and record
 * near its end. Undefined until the answer for this job and phase lands.
 */
export function useJobFolder(
  jobId: string | undefined,
  settled: boolean,
): JobFolderAnswer | undefined {
  const key = jobId === undefined ? undefined : `${jobId}:${settled}`;
  const [resolved, setResolved] = useState<{
    key: string;
    answer: JobFolderAnswer;
  }>();
  const answer =
    resolved !== undefined && resolved.key === key
      ? resolved.answer
      : undefined;

  useEffect(() => {
    if (jobId === undefined || key === undefined) return;
    const controller = new AbortController();
    void fetchJobFolder(jobId, controller.signal).then((asked) => {
      if (!controller.signal.aborted) setResolved({ key, answer: asked });
    });
    return () => {
      controller.abort();
    };
  }, [jobId, key]);

  return answer;
}
