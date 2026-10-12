import {
  MAX_JOB_STATUS_RESPONSE_BYTES,
  isRecord,
  readJsonOrNull,
} from "./jobApiBody";

import type { RelayLocator } from "@alcove/core";
import type { SignalingServerProjection } from "@jobContract/signalingServer";

/**
 * The browser-side client for the coordination server a console webrtc run
 * dials: `GET`, `PUT` and `DELETE /api/jobs/webrtc`. Off the console the route
 * answers 404, which reads as no server set. A malformed body reads as no
 * server rather than arming a run against an address the operator did not set.
 */

const ROUTE = "/api/jobs/webrtc";

/** Read the projection off a `GET` or `PUT` body, or null when it reports
 * `configured: false` or is malformed.
 *
 * @internal exported for testing */
export function signalingServerProjectionOf(
  body: unknown,
): SignalingServerProjection | null {
  if (!isRecord(body) || body.configured !== true) return null;
  const { host, port, path, secure, webAppOrigin, warnings } = body;
  if (typeof host !== "string" || host.length === 0) return null;
  if (
    port !== undefined &&
    (typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535)
  )
    return null;
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  if (typeof secure !== "boolean") return null;
  if (webAppOrigin !== undefined && !isWebOrigin(webAppOrigin)) return null;
  return {
    host,
    ...(port !== undefined ? { port } : {}),
    path,
    secure,
    ...(webAppOrigin !== undefined ? { webAppOrigin } : {}),
    warnings: Array.isArray(warnings)
      ? warnings.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

/** Whether `value` is an `http:` or `https:` origin, the only shape a link
 * the share screen offers may start with. */
function isWebOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

/** The coordination server the console holds, or null when none is set or the
 * console did not answer. */
export async function fetchSignalingServer(
  fetchImpl: typeof fetch = fetch,
): Promise<SignalingServerProjection | null> {
  try {
    const response = await fetchImpl(ROUTE, { method: "GET" });
    if (!response.ok) return null;
    return signalingServerProjectionOf(
      await readJsonOrNull(response, MAX_JOB_STATUS_RESPONSE_BYTES),
    );
  } catch {
    return null;
  }
}

/**
 * What setting the address came to:
 * - `ok`: the console holds it; `server` is what it holds.
 * - `refused`: a `400` or `502`; `message` is the console's own two
 *   sentences, what happened and what to type instead.
 * - `superseded`: a `409`; a later change took effect first.
 * - `error`: anything else, or a malformed success body.
 */
export type PutSignalingServerResult =
  | { kind: "ok"; server: SignalingServerProjection }
  | { kind: "refused"; message: string }
  | { kind: "superseded" }
  | { kind: "error" };

/** Set the coordination server from the address the operator typed, or
 * from an accepted invitation's server and relay. */
export async function putSignalingServer(
  address: string,
  fetchImpl: typeof fetch = fetch,
  invitationRelay?: RelayLocator,
): Promise<PutSignalingServerResult> {
  let response: Response;
  try {
    response = await fetchImpl(ROUTE, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address,
        ...(invitationRelay !== undefined ? { invitationRelay } : {}),
      }),
    });
  } catch {
    return { kind: "error" };
  }
  if (response.ok) {
    const server = signalingServerProjectionOf(
      await readJsonOrNull(response, MAX_JOB_STATUS_RESPONSE_BYTES),
    );
    return server === null ? { kind: "error" } : { kind: "ok", server };
  }
  if (response.status === 409) return { kind: "superseded" };
  if (response.status === 400 || response.status === 502) {
    const body = await readJsonOrNull(response, MAX_JOB_STATUS_RESPONSE_BYTES);
    if (isRecord(body) && typeof body.error === "string" && body.error !== "")
      return { kind: "refused", message: body.error };
  }
  return { kind: "error" };
}

/** Forget the coordination server. The caller treats any outcome as done. */
export async function deleteSignalingServer(
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(ROUTE, { method: "DELETE" });
  } catch {
    // Best-effort, as for the SFTP connection: the card returns to its form.
  }
}
