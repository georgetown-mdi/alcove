import { createServer } from "node:http";

import { redactAndSanitizeForDisplay } from "@alcove/core/websocket-relay";
import { applyStandaloneUpgradeBounds } from "@alcove/peerjs-broker/standaloneUpgradeBounds";

import { attachSftpRelay } from "./relay.ts";
import {
  SftpRelayOptionError,
  resolveSftpRelayOptions,
} from "./standaloneOptions.ts";

import type { AddressInfo } from "node:net";

import type { SftpRelayRunnerOptions } from "./standaloneOptions.ts";

// The SFTP relay on an HTTP server of its own, as a process entry point:
// `npm start -w packages/sftp-relay`, spawned under `tsx`, or the bundle the
// image runs. It prints one `alcove-sftp-relay <port>` line on stdout once
// listening and stays up until signalled; diagnostics go to stderr. It
// terminates no TLS, so a deployment puts it behind a front that does.

const READY_PREFIX = "alcove-sftp-relay";
const DIAGNOSTIC_CONTEXT = "sftp-relay";

/** The CLI's usage exit (docs/CLI.md). */
const USAGE_EXIT_CODE = 64;

/** A bind the operating system refused, or a later fault on the listener. */
const UNAVAILABLE_EXIT_CODE = 69;

/** Write one line to stderr, escaping the raw text once, here at the sink. */
function writeLine(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const timestamp = new Date().toISOString();
  process.stderr.write(
    `[${timestamp}] [${level}] [${DIAGNOSTIC_CONTEXT}] ${redactAndSanitizeForDisplay(message)}\n`,
  );
}

function refuseToStart(message: string, code: number): never {
  writeLine("ERROR", message);
  process.exit(code);
}

function readOptions(): SftpRelayRunnerOptions {
  try {
    return resolveSftpRelayOptions(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof SftpRelayOptionError)) throw error;
    refuseToStart(error.message, USAGE_EXIT_CODE);
  }
}

const options = readOptions();

const server = createServer((_request, response) => {
  response.writeHead(404);
  response.end();
});

applyStandaloneUpgradeBounds(server);

const relay = attachSftpRelay(server, {
  target: options.target,
  allowedOrigins: options.allowedOrigins,
  reportFault: (message) => writeLine("WARN", message),
});

server.on("error", (error: Error) => {
  refuseToStart(
    `the SFTP relay could not serve ${options.host} port ${options.port}: ${error.message}`,
    UNAVAILABLE_EXIT_CODE,
  );
});

server.listen(options.port, options.host, () => {
  const address = server.address() as AddressInfo;
  writeLine(
    "INFO",
    `forwarding to ${options.target.host} port ${options.target.port} for ${options.allowedOrigins.join(", ")}`,
  );
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
