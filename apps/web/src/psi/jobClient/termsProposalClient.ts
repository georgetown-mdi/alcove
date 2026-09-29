import {
  MAX_JOB_STATUS_RESPONSE_BYTES,
  isRecord,
  readJsonOrNull,
} from "./jobApiBody";

/**
 * How asking the console to apply a run's terms proposal ended
 * (`POST /api/jobs/:jobId/apply-terms`, docs/spec/SERVER_JOB_API.md):
 * - `applied`: the mounted `alcove.yaml` took on the partner's terms.
 * - `refused`: `alcove apply` refused and changed nothing.
 * - `configuration-changed`: the mounted `alcove.yaml` changed after it was
 *   opened, so nothing was applied.
 * - `busy`: an apply is running, or the run has not finished closing.
 * - `unavailable`: the console holds no proposal for this run to apply.
 * - `error`: anything else, a request that did not complete included.
 */
export type TermsProposalApplyOutcome =
  | "applied"
  | "refused"
  | "configuration-changed"
  | "busy"
  | "unavailable"
  | "error";

const ANSWERED_STATUSES: ReadonlySet<string> = new Set([
  "applied",
  "refused",
  "configuration-changed",
]);

/**
 * Ask the console to apply the partner's changed terms that job `jobId`
 * stopped on to the mounted configuration. The console runs `alcove apply`;
 * the request carries nothing but the job id.
 */
export async function applyJobTermsProposal(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TermsProposalApplyOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(
      `/api/jobs/${encodeURIComponent(jobId)}/apply-terms`,
      { method: "POST" },
    );
  } catch {
    return "error";
  }
  if (response.status === 404) return "unavailable";
  if (response.status === 409) return "busy";
  if (!response.ok) return "error";
  const body = await readJsonOrNull(response, MAX_JOB_STATUS_RESPONSE_BYTES);
  const status = isRecord(body) ? body.status : undefined;
  return typeof status === "string" && ANSWERED_STATUSES.has(status)
    ? (status as TermsProposalApplyOutcome)
    : "error";
}
