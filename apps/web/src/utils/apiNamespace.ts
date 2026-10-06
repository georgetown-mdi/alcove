/**
 * The refusal the console server (server/console/app.ts) applies to the `/api`
 * namespace ahead of its route table.
 *
 * The only server API under `/api` is the console job API (`/api/jobs/...`),
 * enabled only on the console deployment profile; the peer-coordination broker
 * runs as a service of its own (packages/peerjs-broker). The whole namespace is
 * refused unless the job API is enabled.
 *
 * A refused request is answered with the job gate's own empty `404`
 * ({@link jobEmptyResponse}) and never reaches the router. What the refusal
 * reaches, and what it leaves: docs/spec/SERVER_JOB_API.md, The `/api`
 * namespace's refusal.
 */

import {
  isJobApiEnabled,
  jobEmptyResponse,
  readJobApiConfig,
} from "@jobs/gate";

/** The path the app's server API routes are served under. */
const API_PATH_ROOT = "/api";

/** How many times a path is percent-decoded while looking for a fixed point. A
 * path still decoding past this is refused outright when it is under `/api`. */
const MAX_DECODE_ROUNDS = 4;

/** Whether `pathname` is `prefix` itself or a path under it, by whole segments. */
function isUnderPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Percent-decode `pathname` once, leaving any sequence that does not decode as
 * it was written and never throwing, so a malformed sequence cannot carry a
 * path out of the namespace.
 */
function decodeOnce(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname.replace(/%[0-9a-f]{2}/gi, (sequence) => {
      try {
        return decodeURIComponent(sequence);
      } catch {
        return sequence;
      }
    });
  }
}

/**
 * Resolve `pathname` to its segments: empty segments dropped (a doubled or
 * trailing slash), `.` dropped, `..` popping the segment before it.
 */
function withoutDotSegments(pathname: string): string {
  const segments: Array<string> = [];
  for (const segment of pathname.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * Every spelling of `pathname` the refusal is decided over: the path as written
 * and its case-folded, dot-resolved, and repeatedly percent-decoded forms.
 * `settled` is false when decoding was still changing the path at
 * {@link MAX_DECODE_ROUNDS}, so where further decoding lands is unknown.
 */
function spellingsOf(pathname: string): {
  spellings: Array<string>;
  settled: boolean;
} {
  const spellings = new Set<string>();
  let current = pathname;
  let settled = false;
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round += 1) {
    for (const spelling of [current, current.toLowerCase()]) {
      spellings.add(spelling);
      spellings.add(withoutDotSegments(spelling));
    }
    const decoded = decodeOnce(current);
    if (decoded === current) {
      settled = true;
      break;
    }
    current = decoded;
  }
  return { spellings: [...spellings], settled };
}

/**
 * Whether any spelling of `pathname` -- as written, case-folded,
 * dot-resolved, or percent-decoded -- is `/api` or under it, or decoding was
 * still changing the path at {@link MAX_DECODE_ROUNDS}.
 */
export function isApiNamespacePath(pathname: string): boolean {
  const { spellings, settled } = spellingsOf(pathname);
  return (
    !settled ||
    spellings.some((spelling) => isUnderPrefix(spelling, API_PATH_ROOT))
  );
}

/**
 * Whether the request for `url` is refused: any spelling of its path lands
 * under `/api` while the job API is not enabled. Deciding over every spelling
 * rather than one normal form makes the refusal wider than the router's own
 * resolution and never narrower -- a spelling the router resolves to a route
 * under `/api` is refused whether or not this agrees with the router on which
 * route that is. A path still decoding at the round bound is refused on being
 * under `/api` at all.
 */
function isRefusedApiPath(url: string): boolean {
  const { spellings, settled } = spellingsOf(new URL(url).pathname);
  if (!spellings.some((spelling) => isUnderPrefix(spelling, API_PATH_ROOT)))
    return false;
  return !settled || !isJobApiEnabled(readJobApiConfig());
}

/**
 * Wrap `route` -- the server's request handler -- in the `/api` refusal: a
 * refused path is answered without calling `route` at all. The profile and
 * enablement are read per request from the same {@link readJobApiConfig} and
 * {@link isJobApiEnabled} the per-route job gate reads, so the two cannot
 * disagree about which profile they are on.
 */
export function withApiGuard(
  route: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (isRefusedApiPath(request.url)) return jobEmptyResponse(404);
    return route(request);
  };
}
