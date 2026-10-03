import {
  MAX_JOB_STATUS_RESPONSE_BYTES,
  isRecord,
  readBoundedJson,
} from "@psi/jobClient/jobApiBody";

import type { JobFolderContents } from "@jobs/jobFolder";

/**
 * What one ask told the browser about a console run's folder: which of its files
 * the folder holds, that there is no such folder, or no answer.
 *
 * `absent` is only a 404. Anything else that fails -- a lost connection, a
 * non-2xx, a body that does not parse -- is `unanswered`, so a hiccup is never
 * treated as a folder with nothing in it.
 */
export type JobFolderAnswer =
  | ({ kind: "present"; live: boolean } & JobFolderContents)
  | { kind: "absent" }
  | { kind: "unanswered" };

const CONTENT_FIELDS = [
  "results",
  "record",
  "sharedSecret",
  "receipt",
  "log",
] as const satisfies ReadonlyArray<keyof JobFolderContents>;

/** Validate a folder body, or null when any field is missing or not a
 * boolean. */
function folderAnswerOf(body: unknown): JobFolderAnswer | null {
  if (!isRecord(body) || typeof body.live !== "boolean") return null;
  const contents: Partial<JobFolderContents> = {};
  for (const field of CONTENT_FIELDS) {
    const value = body[field];
    if (typeof value !== "boolean") return null;
    contents[field] = value;
  }
  return {
    kind: "present",
    live: body.live,
    ...(contents as JobFolderContents),
  };
}

/** Ask the console which of a run's files its folder holds
 * (`GET /api/jobs/:jobId/folder`). Never throws. */
export async function fetchJobFolder(
  jobId: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<JobFolderAnswer> {
  try {
    const response = await fetchImpl(`/api/jobs/${jobId}/folder`, {
      method: "GET",
      signal,
    });
    if (response.status === 404) return { kind: "absent" };
    if (!response.ok) return { kind: "unanswered" };
    return (
      folderAnswerOf(
        await readBoundedJson(response, MAX_JOB_STATUS_RESPONSE_BYTES),
      ) ?? { kind: "unanswered" }
    );
  } catch {
    return { kind: "unanswered" };
  }
}

/** Whether the folder holds any file a discard would cost the operator. */
export function folderHoldsKeepableFiles(contents: JobFolderContents): boolean {
  return CONTENT_FIELDS.some((field) => contents[field]);
}
