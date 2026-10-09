import { route as ApplyTermsRoute } from "./routes/$jobId/apply-terms";
import { route as CancelRoute } from "./routes/$jobId/cancel";
import { route as ConfigRoute } from "./routes/config";
import { route as CoverageRoute } from "./routes/inputs/coverage";
import { route as EventsRoute } from "./routes/$jobId/events";
import { route as FolderEntriesRoute } from "./routes/mounts/folder/entries";
import { route as FolderRoute } from "./routes/$jobId/folder";
import { route as HandoffRoute } from "./routes/$jobId/handoff";
import { route as InputsRoute } from "./routes/inputs/index";
import { route as JobRoute } from "./routes/$jobId/index";
import { route as JobsRoute } from "./routes/index";
import { route as KeysRoute } from "./routes/$jobId/keys";
import { route as LogRoute } from "./routes/$jobId/log";
import { route as ProfileRoute } from "./routes/inputs/profile";
import { route as ReceiptRoute } from "./routes/$jobId/receipt";
import { route as RecordRoute } from "./routes/$jobId/record";
import { route as RendezvousRoute } from "./routes/rendezvous";
import { route as ResultRoute } from "./routes/$jobId/result";
import { route as SamplesRoute } from "./routes/inputs/samples";
import { route as SecretsEntriesRoute } from "./routes/mounts/secrets/entries";
import { route as SftpProbeRoute } from "./routes/sftp/probe";
import { route as SftpRoute } from "./routes/sftp/index";
import { route as SigningFingerprintRoute } from "./routes/signing/fingerprint";
import { route as SlotRoute } from "./routes/slot";
import { route as WebrtcRoute } from "./routes/webrtc";

import { JOB_ROUTE_METHODS } from "./jobRoute";

import type { JobRouteDefinition, JobRouteHandlers } from "./jobRoute";

const JOB_API_PREFIX = "/api/jobs";

/** Every job route the console serves. */
export const jobRoutes: ReadonlyArray<JobRouteDefinition> = [
  JobsRoute,
  ConfigRoute,
  RendezvousRoute,
  SlotRoute,
  InputsRoute,
  CoverageRoute,
  ProfileRoute,
  SamplesRoute,
  FolderEntriesRoute,
  SecretsEntriesRoute,
  SftpRoute,
  SftpProbeRoute,
  WebrtcRoute,
  SigningFingerprintRoute,
  JobRoute,
  ApplyTermsRoute,
  CancelRoute,
  EventsRoute,
  FolderRoute,
  HandoffRoute,
  KeysRoute,
  LogRoute,
  ReceiptRoute,
  RecordRoute,
  ResultRoute,
];

type PathSegment =
  { kind: "static"; value: string } | { kind: "param"; name: string };

/** A route compiled for matching. */
export interface CompiledJobRoute {
  segments: ReadonlyArray<PathSegment>;
  handlers: JobRouteHandlers;
}

/** The segments of an absolute path, or null when any is empty: a trailing,
 * doubled, or missing leading slash. */
function segmentsOf(path: string): Array<string> | null {
  if (!path.startsWith("/")) return null;
  const segments = path.slice(1).split("/");
  return segments.includes("") ? null : segments;
}

/**
 * Compile `routes` for {@link matchJobRoute}, ordered so a static segment is
 * tried before a parameter in the same position (`/api/jobs/slot` before
 * `/api/jobs/$jobId`). A malformed or duplicate path throws.
 */
export function compileJobRoutes(
  routes: ReadonlyArray<JobRouteDefinition>,
): ReadonlyArray<CompiledJobRoute> {
  const seen = new Set<string>();
  const compiled = routes.map((route) => {
    const raw = segmentsOf(route.path);
    if (raw === null)
      throw new Error(`Malformed job route path ${route.path}.`);
    if (
      route.path !== JOB_API_PREFIX &&
      !route.path.startsWith(`${JOB_API_PREFIX}/`)
    )
      throw new Error(
        `Job route path ${route.path} is outside ${JOB_API_PREFIX}.`,
      );
    for (const [method, handler] of Object.entries(route.handlers))
      if (
        !(JOB_ROUTE_METHODS as ReadonlyArray<string>).includes(method) ||
        typeof handler !== "function"
      )
        throw new Error(
          `Job route path ${route.path} has an invalid handler ${method}.`,
        );
    const segments = raw.map((segment): PathSegment =>
      segment.startsWith("$")
        ? { kind: "param", name: segment.slice(1) }
        : { kind: "static", value: segment },
    );
    const shape = segments
      .map((segment) => (segment.kind === "param" ? "$" : segment.value))
      .join("/");
    if (seen.has(shape))
      throw new Error(`Duplicate job route path ${route.path}.`);
    seen.add(shape);
    return { segments, handlers: route.handlers };
  });
  const rank = (route: CompiledJobRoute): string =>
    route.segments
      .map((segment) => (segment.kind === "param" ? 1 : 0))
      .join("");
  return compiled.sort((left, right) =>
    rank(left) < rank(right) ? -1 : rank(left) > rank(right) ? 1 : 0,
  );
}

/**
 * The route `pathname` names, with its parameters each percent-decoded once.
 * A static segment matches only as written; a parameter that does not decode,
 * and an empty segment anywhere, match nothing.
 */
export function matchJobRoute(
  routes: ReadonlyArray<CompiledJobRoute>,
  pathname: string,
): { route: CompiledJobRoute; params: Record<string, string> } | null {
  const segments = segmentsOf(pathname);
  if (segments === null) return null;
  for (const route of routes) {
    if (route.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const matched = route.segments.every((segment, index) => {
      const written = segments[index];
      if (segment.kind === "static") return segment.value === written;
      try {
        params[segment.name] = decodeURIComponent(written);
        return true;
      } catch {
        return false;
      }
    });
    if (matched) return { route, params };
  }
  return null;
}
