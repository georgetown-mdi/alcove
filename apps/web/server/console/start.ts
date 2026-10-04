import { getLogger, sanitizeErrorForDisplay, setLogLevel } from "@alcove/core";

import {
  bootSftpCredentialScratchDir,
  registerJobManagerShutdown,
  warnJobApiProfileMismatch,
  warnJobRendezvousProvisioning,
} from "@jobs/index";
import { ConfigManager } from "@utils/serverConfig";
import { jobApiRequestTimeoutMs } from "@jobs/routeSupport";

import {
  DEFAULT_BIND_HOST,
  createConsoleHandler,
  createConsoleServer,
  listenConsoleServer,
} from "./app";
import {
  createCloseHooks,
  installGracefulShutdown,
  shutdownTimeoutMs,
} from "./shutdown";

import type { JobRouteDefinition } from "./routeTable";
import type { Server } from "node:http";
import type { ServerCloseHooks } from "./shutdown";

/** Log an uncaught exception or unhandled rejection and keep serving: the
 * server exiting would cut short the cleanup of a running exchange. */
function logUncaughtErrors(log: ReturnType<typeof getLogger>): void {
  process.on("unhandledRejection", (error) =>
    log.error("Unhandled rejection:", sanitizeErrorForDisplay(error)),
  );
  process.on("uncaughtException", (error) =>
    log.error("Uncaught exception:", sanitizeErrorForDisplay(error)),
  );
}

/**
 * Boot the console server and listen: load the server configuration, prepare
 * the job API's startup state and its warnings, wire the running exchange and
 * the server into the SIGINT/SIGTERM shutdown, then listen on `PORT` at
 * `HOST` ({@link DEFAULT_BIND_HOST} when unset). A job API configuration error
 * rejects before anything listens.
 */
export async function startConsoleServer(options: {
  routes: ReadonlyArray<JobRouteDefinition>;
}): Promise<{ server: Server; hooks: ServerCloseHooks; url: string }> {
  const config = await new ConfigManager().load();
  setLogLevel(config.LOG_LEVEL);
  const log = getLogger("console-server");

  bootSftpCredentialScratchDir();
  warnJobApiProfileMismatch();
  warnJobRendezvousProvisioning();
  logUncaughtErrors(log);

  const server = createConsoleServer(
    createConsoleHandler({ routes: options.routes }),
    { requestTimeoutMs: jobApiRequestTimeoutMs() },
  );
  const hooks = createCloseHooks();
  registerJobManagerShutdown(hooks);
  installGracefulShutdown(server, hooks, { timeoutMs: shutdownTimeoutMs() });

  const host = process.env.HOST?.trim() || DEFAULT_BIND_HOST;
  const url = await listenConsoleServer(server, { port: config.PORT, host });
  log.info(`Listening on ${url}`);
  return { server, hooks, url };
}
