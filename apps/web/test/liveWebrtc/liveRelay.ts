import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { once } from "node:events";
import path from "node:path";
import { tmpdir } from "node:os";

import { RELAY_PATH } from "@alcove/websocket-relay/protocol";
import { attachWebSocketRelay } from "@alcove/websocket-relay";

import { relayTlsCert } from "../devServer/relayTls.ts";

import { LEG_ENVIRONMENT_FAILURE } from "./legTypes.ts";

import type { AddressInfo } from "node:net";
import type { LiveRelayObservations } from "./legTypes.ts";

/**
 * The WebSocket relay of the live leg's relay case: the repository's relay
 * (packages/websocket-relay) on a loopback HTTPS server in the leg's Node
 * process, serving `wss` under the certificate `../devServer/relayTls.ts`
 * holds for the run, which the `live-webrtc` project's Chromium launch trusts
 * and the CLI party trusts through `NODE_EXTRA_CA_CERTS`.
 *
 * It records what the leg asserts the relay saw: each socket it upgraded and
 * when that socket closed, each hello it checked under the one enrolled
 * exchange id, and each message it forwarded on that exchange's pairing.
 */

/** A relay standing on loopback with one exchange's key enrolled. */
export interface LiveRelay {
  /** The relay's `wss://` url, its path included. */
  url: string;
  /** The PEM file of the certificate it serves, for `NODE_EXTRA_CA_CERTS`. */
  certificatePath: string;
  /** Enroll `relayKey` under `exchangeId`, the one exchange it serves. */
  enroll: (exchangeId: string, relayKey: string) => void;
  /** Resolve at the first hello checked under the enrolled exchange id. */
  firstHello: Promise<void>;
  /** What it has seen so far. */
  observations: () => LiveRelayObservations;
  /** Close every socket and the server, and remove the certificate file.
   * Idempotent. */
  stop: () => Promise<void>;
}

/** Start the relay on an ephemeral loopback port. */
export async function startLiveRelay(): Promise<LiveRelay> {
  const credentials = relayTlsCert();
  if (credentials === null)
    throw new Error(
      `${LEG_ENVIRONMENT_FAILURE} no loopback TLS certificate could be ` +
        "minted for the WebSocket relay; the relay case needs `openssl`.",
    );
  const work = mkdtempSync(path.join(tmpdir(), "alcove-live-relay-"));
  const certificatePath = path.join(work, "relay-cert.pem");
  writeFileSync(certificatePath, credentials.cert);

  let enrolled: { exchangeId: string; relayKey: string } | undefined;
  let hellos = 0;
  let forwarded = 0;
  const sockets: LiveRelayObservations["sockets"] = [];
  let helloSeen!: () => void;
  const firstHello = new Promise<void>((resolve) => (helloSeen = resolve));

  const server = createServer(credentials);
  let closes = 0;
  server.on("upgrade", (request, socket) => {
    const record: LiveRelayObservations["sockets"][number] = {
      fromBrowser: request.headers.origin !== undefined,
      upgradedAt: Date.now(),
      closedAt: null,
      closeOrder: null,
    };
    sockets.push(record);
    socket.once("close", () => {
      record.closedAt = Date.now();
      record.closeOrder = closes++;
    });
  });
  const relay = attachWebSocketRelay(server, {
    keyTable: {
      lookup: (exchangeId) => {
        if (exchangeId !== enrolled?.exchangeId) return undefined;
        hellos += 1;
        helloSeen();
        return enrolled.relayKey;
      },
    },
    reportFault: (message) => console.error(`[websocket-relay] ${message}`),
    testing: {
      observer: {
        forwarded: (key) => {
          if (key === enrolled?.relayKey) forwarded += 1;
        },
      },
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  let stopped: Promise<void> | undefined;
  return {
    url: `wss://127.0.0.1:${port}${RELAY_PATH}`,
    certificatePath,
    enroll: (exchangeId, relayKey) => {
      enrolled = { exchangeId, relayKey };
    },
    firstHello,
    observations: () => ({
      sockets: sockets.map((record) => ({ ...record })),
      hellos,
      forwarded,
    }),
    stop: () =>
      (stopped ??= (async () => {
        relay.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        rmSync(work, { recursive: true, force: true });
      })()),
  };
}
