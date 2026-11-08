import {
  exitOnSignal,
  refuseToStart,
  UNAVAILABLE_EXIT_CODE,
  USAGE_EXIT_CODE,
  writeLine,
} from "@alcove/peerjs-broker/standaloneRunner";
import { applyStandaloneUpgradeBounds } from "@alcove/peerjs-broker/standaloneUpgradeBounds";

import { startRelayCountersFile } from "./countersFile.ts";
import { openRelayKeyTable } from "./keyTable.ts";
import { attachWebSocketRelay, createWebSocketRelayServer } from "./relay.ts";
import { RelayOptionError, resolveRelayOptions } from "./standaloneOptions.ts";

import type { AddressInfo } from "node:net";

import type { RelayOptions } from "./standaloneOptions.ts";

// The relay on an HTTP server of its own, as a process entry point:
// `npm start -w packages/websocket-relay`, or spawned under `tsx`. It prints
// one `alcove-websocket-relay <port>` line on stdout once listening and stays
// up until signalled; diagnostics go to stderr, and its refusal counts to the
// file `--counters-file` names, when it names one. It terminates no TLS, so a
// deployment reachable off the host puts it behind a front that does.

const READY_PREFIX = "alcove-websocket-relay";
const DIAGNOSTIC_CONTEXT = "websocket-relay";

// No exchange id starts with "-", so the startup probe matches no row.
const PROBE_EXCHANGE_ID = "-";

function readOptions(): RelayOptions {
  try {
    return resolveRelayOptions(process.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof RelayOptionError)) throw error;
    refuseToStart(DIAGNOSTIC_CONTEXT, error.message, USAGE_EXIT_CODE);
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
    DIAGNOSTIC_CONTEXT,
    "WARN",
    `${error instanceof Error ? error.message : String(error)}; ` +
      "every hello is refused until it can be read",
  );
}

const server = createWebSocketRelayServer();

applyStandaloneUpgradeBounds(server);

const relay = attachWebSocketRelay(server, {
  keyTable,
  reportFault: (message) => writeLine(DIAGNOSTIC_CONTEXT, "WARN", message),
});

if (options.countersPath !== undefined) {
  startRelayCountersFile({
    path: options.countersPath,
    counts: () => relay.counts(),
    reportFailure: (message) => writeLine(DIAGNOSTIC_CONTEXT, "WARN", message),
  });
}

server.on("error", (error: Error) => {
  refuseToStart(
    DIAGNOSTIC_CONTEXT,
    `the WebSocket relay could not serve ${options.host} port ${options.port}: ${error.message}`,
    UNAVAILABLE_EXIT_CODE,
  );
});

server.listen(options.port, options.host, () => {
  const address = server.address() as AddressInfo;
  process.stdout.write(`${READY_PREFIX} ${address.port}\n`);
});

exitOnSignal(server, relay);
