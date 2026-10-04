import { Route as ApplyTermsRoute } from "../../src/routes/api/jobs/$jobId/apply-terms";
import { Route as CancelRoute } from "../../src/routes/api/jobs/$jobId/cancel";
import { Route as ConfigRoute } from "../../src/routes/api/jobs/config";
import { Route as CoverageRoute } from "../../src/routes/api/jobs/inputs/coverage";
import { Route as EventsRoute } from "../../src/routes/api/jobs/$jobId/events";
import { Route as FolderEntriesRoute } from "../../src/routes/api/jobs/mounts/folder/entries";
import { Route as FolderRoute } from "../../src/routes/api/jobs/$jobId/folder";
import { Route as HandoffRoute } from "../../src/routes/api/jobs/$jobId/handoff";
import { Route as InputsRoute } from "../../src/routes/api/jobs/inputs/index";
import { Route as JobRoute } from "../../src/routes/api/jobs/$jobId/index";
import { Route as JobsRoute } from "../../src/routes/api/jobs/index";
import { Route as KeysRoute } from "../../src/routes/api/jobs/$jobId/keys";
import { Route as LogRoute } from "../../src/routes/api/jobs/$jobId/log";
import { Route as ProfileRoute } from "../../src/routes/api/jobs/inputs/profile";
import { Route as ReceiptRoute } from "../../src/routes/api/jobs/$jobId/receipt";
import { Route as RecordRoute } from "../../src/routes/api/jobs/$jobId/record";
import { Route as RendezvousRoute } from "../../src/routes/api/jobs/rendezvous";
import { Route as ResultRoute } from "../../src/routes/api/jobs/$jobId/result";
import { Route as SamplesRoute } from "../../src/routes/api/jobs/inputs/samples";
import { Route as SecretsEntriesRoute } from "../../src/routes/api/jobs/mounts/secrets/entries";
import { Route as SftpProbeRoute } from "../../src/routes/api/jobs/sftp/probe";
import { Route as SftpRoute } from "../../src/routes/api/jobs/sftp/index";
import { Route as SigningFingerprintRoute } from "../../src/routes/api/jobs/signing/fingerprint";
import { Route as SlotRoute } from "../../src/routes/api/jobs/slot";

/** The request methods a job route may declare a handler for. */
export const JOB_ROUTE_METHODS = ["GET", "POST", "PUT", "DELETE"] as const;

/** One of {@link JOB_ROUTE_METHODS}. */
export type JobRouteMethod = (typeof JOB_ROUTE_METHODS)[number];

/** What a job route handler receives: the request and its path parameters,
 * each decoded once. */
export interface JobRouteContext {
  request: Request;
  params: Record<string, string>;
}

/** A job route's handlers, keyed by the method each answers. */
export type JobRouteHandlers = Partial<
  Record<
    JobRouteMethod,
    (context: JobRouteContext) => Response | Promise<Response>
  >
>;

/** A job route: its path, with `$name` marking a one-segment parameter, and its
 * handlers. */
export interface JobRouteDefinition {
  path: string;
  handlers: JobRouteHandlers;
}

/** Declare a job route. */
export function defineJobRoute(
  definition: JobRouteDefinition,
): JobRouteDefinition {
  return definition;
}

/**
 * The plain handlers object a router file route declares, refused at startup
 * unless every key is one of {@link JOB_ROUTE_METHODS} and every value a
 * function, so a route declaring a shape this server does not dispatch fails
 * the boot rather than answering `404` at request time.
 */
function fileRouteHandlers(route: {
  options: { server?: { handlers?: unknown } };
}): JobRouteHandlers {
  const handlers = route.options.server?.handlers;
  if (typeof handlers !== "object" || handlers === null)
    throw new Error("A job route exposes no plain handlers object.");
  for (const [method, handler] of Object.entries(handlers)) {
    if (!(JOB_ROUTE_METHODS as ReadonlyArray<string>).includes(method))
      throw new Error(`A job route declares an unsupported method ${method}.`);
    if (typeof handler !== "function")
      throw new Error(`A job route's ${method} handler is not a function.`);
  }
  return handlers;
}

/** A router file route paired with the path this server serves it at. */
function fromFileRoute(
  path: string,
  route: Parameters<typeof fileRouteHandlers>[0],
): JobRouteDefinition & { fileRoute: unknown } {
  return { path, handlers: fileRouteHandlers(route), fileRoute: route };
}

/**
 * Every job route the console serves. A router index route (`/api/jobs/`) is
 * served without its trailing slash, the form clients request.
 */
export const jobRoutes: ReadonlyArray<
  JobRouteDefinition & { fileRoute: unknown }
> = [
  fromFileRoute("/api/jobs", JobsRoute),
  fromFileRoute("/api/jobs/config", ConfigRoute),
  fromFileRoute("/api/jobs/rendezvous", RendezvousRoute),
  fromFileRoute("/api/jobs/slot", SlotRoute),
  fromFileRoute("/api/jobs/inputs", InputsRoute),
  fromFileRoute("/api/jobs/inputs/coverage", CoverageRoute),
  fromFileRoute("/api/jobs/inputs/profile", ProfileRoute),
  fromFileRoute("/api/jobs/inputs/samples", SamplesRoute),
  fromFileRoute("/api/jobs/mounts/folder/entries", FolderEntriesRoute),
  fromFileRoute("/api/jobs/mounts/secrets/entries", SecretsEntriesRoute),
  fromFileRoute("/api/jobs/sftp", SftpRoute),
  fromFileRoute("/api/jobs/sftp/probe", SftpProbeRoute),
  fromFileRoute("/api/jobs/signing/fingerprint", SigningFingerprintRoute),
  fromFileRoute("/api/jobs/$jobId", JobRoute),
  fromFileRoute("/api/jobs/$jobId/apply-terms", ApplyTermsRoute),
  fromFileRoute("/api/jobs/$jobId/cancel", CancelRoute),
  fromFileRoute("/api/jobs/$jobId/events", EventsRoute),
  fromFileRoute("/api/jobs/$jobId/folder", FolderRoute),
  fromFileRoute("/api/jobs/$jobId/handoff", HandoffRoute),
  fromFileRoute("/api/jobs/$jobId/keys", KeysRoute),
  fromFileRoute("/api/jobs/$jobId/log", LogRoute),
  fromFileRoute("/api/jobs/$jobId/receipt", ReceiptRoute),
  fromFileRoute("/api/jobs/$jobId/record", RecordRoute),
  fromFileRoute("/api/jobs/$jobId/result", ResultRoute),
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
