import { redactAndSanitizeForDisplay } from "@alcove/core/websocket-relay";
import { applyStandaloneUpgradeBounds } from "@alcove/peerjs-broker/standaloneUpgradeBounds";

import { openRelayKeyTable } from "./keyTable.ts";
import { attachWebSocketRelay, createWebSocketRelayServer } from "./relay.ts";
import { RelayOptionError, resolveRelayOptions } from "./standaloneOptions.ts";

import type { AddressInfo } from "node:net";

import type { RelayOptions } from "./standaloneOptions.ts";

// The relay on an HTTP server of its own, as a process entry point:
// `npm start -w packages/websocket-relay`, or spawned under `tsx`. It prints
// one `alcove-websocket-relay <port>` line on stdout once listening and stays
// up until signalled; diagnostics go to stderr. It terminates no TLS, so a
// deployment reachable off the host puts it behind a front that does.

const READY_PREFIX = "alcove-websocket-relay";
const DIAGNOSTIC_CONTEXT = "websocket-relay";

/** The CLI's usage exit (docs/CLI.md). */
const USAGE_EXIT_CODE = 64;

/** A bind the operating system refused, or a later fault on the listener. */
const UNAVAILABLE_EXIT_CODE = 69;

// No exchange id starts with "-", so the startup probe matches no row.
const PROBE_EXCHANGE_ID = "-";

/** Write one line to stderr, escaping the raw text once, here at the sink. */
function writeLine(level: "WARN" | "ERROR", message: string): void {
  const timestamp = new Date().toISOString();
  process.stderr.write(
    `[${timestamp}] [${level}] [${DIAGNOSTIC_CONTEXT}] ${redactAndSanitizeForDisplay(message)}\n`,
  );
}

function refuseToStart(message: string, code: number): never {
  writeLine("ERROR", message);
  process.exit(code);
}

function readOptions(): RelayOptions {
  try {
    return resolveRelayOptions(process.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof RelayOptionError)) throw error;
    refuseToStart(error.message, USAGE_EXIT_CODE);
  }
}

const options = readOptions();
const keyTable = openRelayKeyTable(options.keyTablePath);

// coturn creates the table at its first start, which may follow this one, so
// an unreadable table is a warning here and each hello is refused until it
// can be read.
try {
  keyTable.lookup(PROBE_EXCHANGE_ID);
} catch (error) {
  writeLine(
    "WARN",
    `${error instanceof Error ? error.message : String(error)}; ` +
      "every hello is refused until it can be read",
  );
}

const server = createWebSocketRelayServer();

applyStandaloneUpgradeBounds(server);

const relay = attachWebSocketRelay(server, {
  keyTable,
  reportFault: (message) => writeLine("WARN", message),
});

server.on("error", (error: Error) => {
  refuseToStart(
    `the WebSocket relay could not serve ${options.host} port ${options.port}: ${error.message}`,
    UNAVAILABLE_EXIT_CODE,
  );
});

server.listen(options.port, options.host, () => {
  const address = server.address() as AddressInfo;
  process.stdout.write(`${READY_PREFIX} ${address.port}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    relay.close();
    server.close(() => process.exit(0));
    // A socket still answering its close keeps `close` from completing; do not
    // wait on it past the grace window.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
