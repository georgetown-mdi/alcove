import { createServer } from "node:http";

import { refusePlainRequest } from "@alcove/peerjs-broker/requestRefusal";
import {
  exitOnSignal,
  refuseToStart,
  UNAVAILABLE_EXIT_CODE,
  USAGE_EXIT_CODE,
  writeLine,
} from "@alcove/peerjs-broker/standaloneRunner";
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

function readOptions(): SftpRelayRunnerOptions {
  try {
    return resolveSftpRelayOptions(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof SftpRelayOptionError)) throw error;
    refuseToStart(DIAGNOSTIC_CONTEXT, error.message, USAGE_EXIT_CODE);
  }
}

const options = readOptions();

const server = createServer((_request, response) =>
  refusePlainRequest(response),
);

applyStandaloneUpgradeBounds(server);

const relay = attachSftpRelay(server, {
  target: options.target,
  allowedOrigins: options.allowedOrigins,
  reportFault: (message) => writeLine(DIAGNOSTIC_CONTEXT, "WARN", message),
});

server.on("error", (error: Error) => {
  refuseToStart(
    DIAGNOSTIC_CONTEXT,
    `the SFTP relay could not serve ${options.host} port ${options.port}: ${error.message}`,
    UNAVAILABLE_EXIT_CODE,
  );
});

server.listen(options.port, options.host, () => {
  const address = server.address() as AddressInfo;
  writeLine(
    DIAGNOSTIC_CONTEXT,
    "INFO",
    `forwarding to ${options.target.host} port ${options.target.port} for ${options.allowedOrigins.join(", ")}`,
  );
  process.stdout.write(`${READY_PREFIX} ${address.port}\n`);
});

exitOnSignal(server, relay);
