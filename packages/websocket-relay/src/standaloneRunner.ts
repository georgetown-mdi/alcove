import { redactAndSanitizeForDisplay } from "@alcove/core/websocket-relay";

import type { Server } from "node:http";

// What the relays' standalone runners share: the diagnostic line, the startup
// refusal and its exit codes, and the shutdown on a signal.

/** The CLI's usage exit (docs/CLI.md). */
export const USAGE_EXIT_CODE = 64;

/** A bind the operating system refused, or a later fault on the listener. */
export const UNAVAILABLE_EXIT_CODE = 69;

/** The levels of a runner's diagnostic line. */
export type DiagnosticLevel = "INFO" | "WARN" | "ERROR";

/** Write one line to stderr, escaping the raw text once, here at the sink. */
export function writeLine(
  context: string,
  level: DiagnosticLevel,
  message: string,
): void {
  const timestamp = new Date().toISOString();
  process.stderr.write(
    `[${timestamp}] [${level}] [${context}] ${redactAndSanitizeForDisplay(message)}\n`,
  );
}

export function refuseToStart(
  context: string,
  message: string,
  code: number,
): never {
  writeLine(context, "ERROR", message);
  process.exit(code);
}

/** On SIGTERM or SIGINT, close `relay` and `server`, then exit 0. */
export function exitOnSignal(server: Server, relay: { close(): void }): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      relay.close();
      server.close(() => process.exit(0));
      // A socket still answering its close keeps `close` from completing; do
      // not wait on it past the grace window.
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
}
