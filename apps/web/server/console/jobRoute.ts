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
