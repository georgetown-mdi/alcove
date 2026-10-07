import { readBoundedJsonBody } from "@alcove/core";

/**
 * Body-shape helpers shared by the same-origin job-API clients: the one bounded
 * read every answer goes through, its per-endpoint byte caps, and the narrowing
 * applied before reading fields. Whole-body reads are banned by lint
 * (apps/web/eslint.config.js). What fixes each cap:
 * docs/spec/SERVER_JOB_API.md, Size caps.
 */

/**
 * The cap on a fixed-shape status body: `GET /api/jobs/:jobId`, the `{ id }` of
 * a created or busy `POST /api/jobs`, `GET /api/jobs/slot`,
 * `GET /api/jobs/rendezvous`, `POST /api/jobs/signing/fingerprint`,
 * `POST /api/jobs/sftp/probe`, and a 400's `{ error }` body. Headroom over a few
 * hundred bytes, not a shape check.
 */
export const MAX_JOB_STATUS_RESPONSE_BYTES = 16 * 1024;

/**
 * The cap on the SFTP connection projection (`GET`/`PUT /api/jobs/sftp`), equal
 * to `MAX_SFTP_AUTHOR_BODY_BYTES`, the authoring body it echoes.
 */
export const MAX_SFTP_CONNECTION_RESPONSE_BYTES = 64 * 1024;

/**
 * The cap on the recurring-run hand-off (`GET /api/jobs/:jobId/handoff`), derived
 * from the create intent's field caps; an intent inflating a standardization
 * step's `function` or `params` past it gets no hand-off.
 * jobHandoffResponseCap.unit.test.ts pins the derivation.
 */
export const MAX_JOB_HANDOFF_RESPONSE_BYTES = 32 * 1024 ** 2;

/**
 * The cap on the variable-length bodies: `GET /api/jobs/inputs`,
 * `GET /api/jobs/mounts/secrets/entries`, `GET /api/jobs/inputs/profile`,
 * `POST /api/jobs/inputs/coverage`, and `GET /api/jobs/config`. No code bound
 * fixes their length, so this is headroom rather than a derived bound.
 */
export const MAX_JOB_LISTING_RESPONSE_BYTES = 8 * 1024 ** 2;

/**
 * Thrown by {@link readBoundedJson} when a console answer is over its cap or
 * unreadable (absent, cut off, not UTF-8 or JSON, or past `parseBoundedJson`'s
 * structural bound). The message is fixed text with no body bytes.
 */
export class JobApiBodyError extends Error {
  constructor(kind: "too-large" | "invalid") {
    super(
      kind === "too-large"
        ? "The console's answer exceeded the size this request reads"
        : "The console's answer was not readable JSON",
    );
    this.name = "JobApiBodyError";
  }
}

/**
 * Read a console answer's body as JSON under `maxBytes`, the one route every
 * job-API client takes to a decoded body. Throws {@link JobApiBodyError} on an
 * over-cap or unreadable body.
 */
export async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const result = await readBoundedJsonBody(response, maxBytes);
  if (result.kind !== "parsed") throw new JobApiBodyError(result.kind);
  return result.value;
}

/** Narrow a decoded body to a plain object, excluding null and arrays, so a
 * caller can read named fields off it. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Decode a response body as JSON under `maxBytes`, or null when it is empty,
 * over the cap, failed part-way through the stream, or not JSON (an error
 * response may have no body). */
export async function readJsonOrNull(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const result = await readBoundedJsonBody(response, maxBytes);
  return result.kind === "parsed" ? result.value : null;
}
