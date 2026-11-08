import { createServer } from "node:http";

import { CreatePeerServerWSOnly } from "./contrib/index.ts";
import { createDeploymentStatusReader } from "./deploymentStatus.ts";
import {
  createStandaloneRequestHandler,
  resolveStandaloneOptions,
  StandaloneOptionError,
} from "./standaloneOptions.ts";
import {
  exitOnSignal,
  refuseToStart,
  UNAVAILABLE_EXIT_CODE,
  USAGE_EXIT_CODE,
  writeDisplayableLine,
} from "./standaloneRunner.ts";
import { applyStandaloneUpgradeBounds } from "./standaloneUpgradeBounds.ts";

import type { StandaloneOptions } from "./standaloneOptions.ts";

import type { Displayable } from "@alcove/core/untrusted-text";
import type { AddressInfo } from "node:net";

/**
 * The vendored PeerJS broker on an HTTP server of its own, as a process entry
 * point: `npm start -w packages/peerjs-broker`, or spawned under `tsx`.
 *
 * It is what makes the broker startable without an application around it, so a
 * consumer outside the web app drives the REAL signaling wire rather than a
 * stand-in: the CLI's WebRTC transport hand-writes a broker client
 * (apps/cli/src/connection/webrtc/brokerClient.ts) against facts measured here,
 * and its harness (apps/cli/test/signaling/brokerProcess.ts) spawns this file.
 * That is why .github/workflows/cli_build_and_test.yaml filters on this
 * workspace.
 *
 * It is also what the web app's dev server forwards its `/api/` to
 * (scripts/dev.mjs, apps/web/test/devServer/globalSetup.ts). In-process
 * consumers inside the web app's tests want its
 * `test/utils/signalingHarness.ts` instead: it builds the `WebSocketServer`
 * directly and hands back the realm. This runner goes through
 * `CreatePeerServerWSOnly`, the package's one builder, so what a spawning test
 * sees is the deployed wiring rather than a subset of it.
 *
 * Protocol with the parent process: it prints one `alcove-broker <port>` line
 * on stdout once listening, then stays up until it is signalled. Nothing else
 * goes to stdout, so the parent can read the port with a single match. The line
 * reports the port alone -- the address is the operator's own instruction, while
 * the port is what an ephemeral bind leaves for the parent to learn.
 *
 * Its operator surface -- the bind address, the port, the mount, the realm key,
 * and the readiness endpoint -- is resolved in `standaloneOptions.ts` and stated
 * in this workspace's README.
 *
 * It bounds the window before it has a request in hand
 * (`standaloneUpgradeBounds.ts`) but terminates no TLS, so a deployment
 * reachable off the host puts it behind a front that does.
 */

/** The line the parent matches to learn the port. */
const READY_PREFIX = "alcove-broker";

/** What marks this process's lines for an operator reading a stream several
 * processes write to. The same context `@alcove/core`'s prefixed loggers give
 * the broker's diagnostics in the web app, so one line shape serves both
 * embeddings -- an equality apps/cli/test/integration/webrtc/broker.test.ts
 * holds by reading a diagnostic off this runner's stderr and comparing its
 * prefix with what core's prefixer writes for the same instant. */
const DIAGNOSTIC_CONTEXT = "peerjs-broker";

/** This runner's diagnostic sink, wired below with no flag in front of it: a
 * broker left unwatched is the case the reports exist for, so there is nothing
 * to switch on. Diagnostics go to stderr because stdout carries the ready-line
 * protocol above. The text arrives escaped, capped and rate limited from the
 * diagnostics module, so it is written as it stands. */
function writeDiagnostic(message: Displayable): void {
  writeDisplayableLine(DIAGNOSTIC_CONTEXT, "WARN", message);
}

function readOptions(): StandaloneOptions {
  try {
    return resolveStandaloneOptions(process.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof StandaloneOptionError)) throw error;
    refuseToStart(DIAGNOSTIC_CONTEXT, error.message, USAGE_EXIT_CODE);
  }
}

const options = readOptions();

const server = createServer(
  createStandaloneRequestHandler(
    options.readinessPath,
    createDeploymentStatusReader(options),
  ),
);

applyStandaloneUpgradeBounds(server);

CreatePeerServerWSOnly(server, writeDiagnostic, {
  path: options.path,
  key: options.key,
});

// The signaling server's own reports are attached to its WebSocket server, not
// to this one, so what reaches here is the HTTP server's: a bind the operating
// system refused, and an accept-side fault. An `error` with no listener at all
// is thrown, which ends the process either way; this states what happened first.
// A fault after `listen` resolved an ephemeral port reports the bound address,
// not the port-0 request that produced it; a pre-bind refusal has no bound
// address yet, so it falls back to what was requested.
server.on("error", (error: Error) => {
  const bound = server.address();
  const host =
    typeof bound === "object" && bound !== null ? bound.address : options.host;
  const port =
    typeof bound === "object" && bound !== null ? bound.port : options.port;
  refuseToStart(
    DIAGNOSTIC_CONTEXT,
    `the signaling broker could not serve ${host} port ${port}: ${error.message}`,
    UNAVAILABLE_EXIT_CODE,
  );
});

server.listen(options.port, options.host, () => {
  const address = server.address() as AddressInfo;
  process.stdout.write(`${READY_PREFIX} ${address.port}\n`);
});

exitOnSignal(server);
