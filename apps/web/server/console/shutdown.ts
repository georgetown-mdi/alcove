import { getLogger, sanitizeErrorForDisplay } from "@alcove/core";

import type { Server } from "node:http";

const log = getLogger("console-server");

/** How long a graceful shutdown waits (ms) before closing every connection
 * and exiting, unless `SHUTDOWN_TIMEOUT_MS` sets another bound. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/** The environment variable that overrides {@link DEFAULT_SHUTDOWN_TIMEOUT_MS}. */
export const SHUTDOWN_TIMEOUT_ENV = "SHUTDOWN_TIMEOUT_MS";

/** The signals that start a graceful shutdown. */
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** The shutdown bound `env` sets: a positive whole number of milliseconds, or
 * {@link DEFAULT_SHUTDOWN_TIMEOUT_MS} when it is unset or not one. */
export function shutdownTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[SHUTDOWN_TIMEOUT_ENV]?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const parsed = Number(raw);
  return parsed > 0 && Number.isSafeInteger(parsed)
    ? parsed
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

/** The work a shutdown awaits before the process exits, in registration
 * order. The shape `registerJobManagerShutdown` registers its wait on. */
export interface ServerCloseHooks {
  hook: (name: "close", handler: () => Promise<void>) => void;
  callClose: () => Promise<void>;
}

/** An empty {@link ServerCloseHooks}. A handler that rejects is logged and
 * the rest still run. */
export function createCloseHooks(): ServerCloseHooks {
  const handlers: Array<() => Promise<void>> = [];
  return {
    hook: (_name, handler) => {
      handlers.push(handler);
    },
    callClose: async () => {
      for (const handler of handlers) {
        try {
          await handler();
        } catch (error) {
          log.error("A shutdown step failed:", sanitizeErrorForDisplay(error));
        }
      }
    },
  };
}

/** Resolve once `server` has closed and every connection has ended. */
function serverClosed(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.once("close", () => resolve());
  });
}

/**
 * Shut `server` down on SIGINT or SIGTERM: stop accepting connections, close
 * the idle ones, await `hooks`' close handlers, then wait for the remaining
 * connections to end. Past `timeoutMs` every connection is closed regardless.
 * The process then exits with status 0. A repeated signal is ignored.
 * Register after any signal listener that must run first: listeners run in
 * registration order.
 */
export function installGracefulShutdown(
  server: Server,
  hooks: ServerCloseHooks,
  options: { timeoutMs: number; exit?: (code: number) => void },
): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    const closed = serverClosed(server);
    server.close();
    server.closeIdleConnections();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), options.timeoutMs);
    });
    const finished = (async () => {
      await hooks.callClose();
      server.closeIdleConnections();
      await closed;
      return false;
    })();
    if (await Promise.race([finished, timedOut]))
      log.warn(
        `Shutdown did not finish within ${options.timeoutMs} ms; closing ` +
          "every connection and exiting.",
      );
    clearTimeout(timer);
    server.closeAllConnections();
    exit(0);
  };
  const onSignal = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown();
  };
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, onSignal);
}
