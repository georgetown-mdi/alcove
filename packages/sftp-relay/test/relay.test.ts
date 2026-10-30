import { once } from "node:events";
import { createServer } from "node:http";
import { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { SFTP_RELAY_PATH, SftpRelayCloseCode } from "../src/protocol.ts";
import { attachSftpRelay } from "../src/relay.ts";

import type { AddressInfo } from "node:net";

// The connect timeout, driven in process: no loopback target fails to complete
// the TCP handshake reliably, so the relay is given a socket that never
// connects in place of its connection to the target. Every other close row
// runs against real targets in apps/cli/test/integration/sftpRelay.test.ts.

const ORIGIN = "https://app.example.org";
const CONNECT_TIMEOUT_MS = 100;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("the connect timeout", () => {
  it("closes the WebSocket with 4001 and reports when the target does not accept in time", async () => {
    const server = createServer();
    const faults: string[] = [];
    const targets: Socket[] = [];
    const relay = attachSftpRelay(server, {
      target: { host: "192.0.2.1", port: 22 },
      allowedOrigins: [ORIGIN],
      reportFault: (message) => faults.push(message),
      testing: {
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        connectTarget: () => {
          const neverConnects = new Socket();
          targets.push(neverConnects);
          return neverConnects;
        },
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(() => {
      relay.close();
      server.closeAllConnections();
      server.close();
    });
    const { port } = server.address() as AddressInfo;

    const opened = performance.now();
    const socket = new WebSocket(`ws://127.0.0.1:${port}${SFTP_RELAY_PATH}`, {
      headers: { Origin: ORIGIN },
    });
    cleanups.push(() => socket.terminate());
    const [code] = (await once(socket, "close")) as [number];

    expect(code).toBe(SftpRelayCloseCode.targetUnreachable);
    expect(performance.now() - opened).toBeGreaterThanOrEqual(
      CONNECT_TIMEOUT_MS / 2,
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].destroyed).toBe(true);
    expect(faults).toEqual([
      `the SFTP relay could not connect to 192.0.2.1 port 22: no answer within ${CONNECT_TIMEOUT_MS} ms`,
    ]);
  });
});
