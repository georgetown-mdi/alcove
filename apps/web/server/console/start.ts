import { getLogger, sanitizeErrorForDisplay, setLogLevel } from "@alcove/core";

import {
  bootSftpCredentialScratchDir,
  registerJobManagerShutdown,
  warnJobApiProfileMismatch,
  warnJobRendezvousProvisioning,
} from "@jobs/index";
import { ConfigManager } from "@utils/serverConfig";
import { JobApiConfigError } from "@jobs/gate";
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

import type { ClientMiddleware } from "./app";
import type { JobRouteDefinition } from "./jobRoute";
import type { Server } from "node:http";
import type { ServerCloseHooks } from "./shutdown";

/** @internal */
export function logUnhandledRejection(error: unknown): void {
  getLogger("console-server").error(
    "Unhandled rejection:",
    sanitizeErrorForDisplay(error),
  );
}

/** @internal */
export function logUncaughtException(error: Error): void {
  getLogger("console-server").error(
    "Uncaught exception:",
    sanitizeErrorForDisplay(error),
  );
}

/** Log an uncaught exception or unhandled rejection and keep serving: the
 * server exiting would cut short the cleanup of a running exchange. Installed
 * once per process however many servers start. */
function logUncaughtErrors(): void {
  if (!process.listeners("unhandledRejection").includes(logUnhandledRejection))
    process.on("unhandledRejection", logUnhandledRejection);
  if (!process.listeners("uncaughtException").includes(logUncaughtException))
    process.on("uncaughtException", logUncaughtException);
}

/**
 * Report a failed {@link startConsoleServer} and exit with status 1. A {@link
 * JobApiConfigError} is a refusal whose message says what to change, so it
 * prints as one line; any other error prints with its stack. Exits rather than
 * rethrowing: once the uncaught-error listeners are installed, a rethrown
 * error is logged and the process keeps running.
 */
export function exitOnBootFailure(error: unknown): never {
  if (error instanceof JobApiConfigError)
    console.error(`The console did not start: ${error.message}`);
  else console.error(error);
  return process.exit(1);
}

/**
 * Boot the console server and listen: load the server configuration, prepare
 * the job API's startup state and its warnings, wire the running exchange and
 * the server into the SIGINT/SIGTERM shutdown, then listen on `PORT` at
 * `HOST` ({@link DEFAULT_BIND_HOST} when unset). Paths no route names are
 * served from the built client under `staticRoot` when it is given, or by
 * `clientMiddleware` in development. A job API configuration error, a
 * `staticRoot` holding no client, or a port already in use rejects with a
 * {@link JobApiConfigError}.
 */
export async function startConsoleServer(options: {
  routes: ReadonlyArray<JobRouteDefinition>;
  staticRoot?: string;
  clientMiddleware?: ClientMiddleware;
}): Promise<{ server: Server; hooks: ServerCloseHooks; url: string }> {
  const config = await new ConfigManager().load();
  setLogLevel(config.LOG_LEVEL);
  const log = getLogger("console-server");

  bootSftpCredentialScratchDir();
  warnJobApiProfileMismatch();
  warnJobRendezvousProvisioning();
  logUncaughtErrors();

  const server = createConsoleServer(createConsoleHandler(options), {
    requestTimeoutMs: jobApiRequestTimeoutMs(),
    ...(options.clientMiddleware === undefined
      ? {}
      : { clientMiddleware: options.clientMiddleware }),
  });
  const hooks = createCloseHooks();
  registerJobManagerShutdown(hooks);
  installGracefulShutdown(server, hooks, { timeoutMs: shutdownTimeoutMs() });

  const host = process.env.HOST?.trim() || DEFAULT_BIND_HOST;
  const url = await listenConsoleServer(server, {
    port: config.PORT,
    host,
  }).catch((error: unknown) => {
    const code =
      error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
    if (code === "EADDRINUSE")
      throw new JobApiConfigError(
        `port ${config.PORT} at ${host} is already in use; set PORT to a ` +
          "free port, or stop the program using it",
      );
    throw error;
  });
  log.info(`Listening on ${url}`);
  return { server, hooks, url };
}
