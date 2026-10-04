import { createServer } from "node:http";

import { getLogger, sanitizeErrorForDisplay } from "@alcove/core";

import { jobEmptyResponse } from "@jobs/gate";
import { withApiGuard } from "@utils/apiNamespace";
import { withSecurityHeaders } from "@utils/securityHeaders";

import { hardenUpgradeSurface } from "../upgradeHardening";

import { compileJobRoutes, matchJobRoute } from "./routeTable";
import {
  isBridgeableRequest,
  toWebRequest,
  writeWebResponse,
} from "./nodeBridge";

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { JobRouteDefinition, JobRouteMethod } from "./routeTable";

const log = getLogger("console-server");

/** The address the server binds when `HOST` is unset: this host's loopback
 * interface only. */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/** The answer to every request this server serves nothing for: the job API's
 * empty no-store `404`, with the security headers every response has. */
function notFound(): Response {
  return withSecurityHeaders(jobEmptyResponse(404));
}

/**
 * The console server's request handler: the `/api` namespace refusal, then
 * the job route `routes` names for the path and method, then the security
 * response headers. A `HEAD` request is answered by the route's `GET`
 * handler. A path or method with no handler answers {@link notFound}; a
 * handler that throws is logged and answers an empty no-store `500`.
 */
export function createConsoleHandler(options: {
  routes: ReadonlyArray<JobRouteDefinition>;
}): (request: Request) => Promise<Response> {
  const routes = compileJobRoutes(options.routes);
  const route = withApiGuard(async (request) => {
    const match = matchJobRoute(routes, new URL(request.url).pathname);
    const method = (
      request.method === "HEAD" ? "GET" : request.method
    ) as JobRouteMethod;
    const handler = match?.route.handlers[method];
    if (match === null || handler === undefined) return jobEmptyResponse(404);
    try {
      return await handler({ request, params: match.params });
    } catch (error) {
      log.error("A job API request failed:", sanitizeErrorForDisplay(error));
      return jobEmptyResponse(500);
    }
  });
  return async (request) => withSecurityHeaders(await route(request));
}

/** Serve one request through `handler`, answering a request the bridge does
 * not carry with {@link notFound}. */
async function serveRequest(
  handler: (request: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const response = isBridgeableRequest(req)
      ? await handler(toWebRequest(req, res))
      : notFound();
    await writeWebResponse(res, response, req.method);
  } catch (error) {
    log.error(
      "A console request could not be answered:",
      sanitizeErrorForDisplay(error),
    );
    if (res.headersSent) res.destroy();
    else
      await writeWebResponse(
        res,
        withSecurityHeaders(jobEmptyResponse(500)),
        req.method,
      );
  }
}

/**
 * An HTTP server answering every request through `handler`, with the bounds
 * on an incomplete request that `hardenUpgradeSurface` applies.
 * `requestTimeoutMs` is the whole-request bound; unset, that module's default
 * applies. It listens nowhere until {@link listenConsoleServer}.
 */
export function createConsoleServer(
  handler: (request: Request) => Promise<Response>,
  options: { requestTimeoutMs?: number } = {},
): Server {
  const server = createServer((req, res) => {
    void serveRequest(handler, req, res);
  });
  hardenUpgradeSurface(
    server,
    options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs },
  );
  return server;
}

/** Listen on `port` at `host` and resolve with the URL the server answers on. */
export function listenConsoleServer(
  server: Server,
  options: { port: number; host: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: options.port, host: options.host }, () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        resolve(`http://${options.host}:${options.port}`);
        return;
      }
      const host =
        address.family === "IPv6" ? `[${address.address}]` : address.address;
      resolve(`http://${host}:${address.port}`);
    });
  });
}
