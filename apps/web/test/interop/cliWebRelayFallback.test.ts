import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { once } from "node:events";
import path from "node:path";
import tls from "node:tls";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  ConnectionError,
  deriveRelayExchangeId,
  deriveRelayKey,
} from "@alcove/core";
import { RELAY_PATH } from "@alcove/websocket-relay/protocol";
import { attachWebSocketRelay } from "@alcove/websocket-relay";
import { loopbackTlsCert } from "@alcove/testkit/loopbackTlsCert";

import { openRunConnectionWithRelayFallback } from "@psi/transport/relayFallback";
import { relayPlanForRun } from "@psi/transport/runRelayPlan";

import { startStandaloneBroker } from "../utils/standaloneBroker";

import { acceptAsWebParty, exchangeOver } from "./webParty";
import {
  expectCliSucceeded,
  fillInConnection,
  invitationFrom,
  pairsFromResultCsv,
  resultFileIn,
  startCli,
} from "./cliParty";

import type { AddressInfo } from "node:net";
import type { Server } from "node:https";
import type { StandaloneBroker } from "../utils/standaloneBroker";
import type { WebSocketRelay } from "@alcove/websocket-relay";

/**
 * A CLI party and a web party completing one exchange over the WebSocket relay
 * with WebRTC blocked: the real `alcove` process meets the broker and parks at
 * a `wss` relay, and a web party assembled in Node from the app's own relay
 * plan, fallback race, relay client, handshake and PSI engine parks there too.
 *
 * The one piece that is the harness's is the web party's WebRTC open: Node
 * cannot stand up a browser peer connection, so it reports the path failed and
 * rejects at once, as a browser's does on a network that stops WebRTC. The web
 * party then sends its start, and the CLI party, still waiting at the broker,
 * abandons WebRTC on that start and follows it onto the relay.
 *
 * Both parties trust the relay's loopback certificate: the CLI through
 * `NODE_EXTRA_CA_CERTS` in its own process, this one through Node's default CA
 * list for the file's duration.
 */

const CLI_CSV =
  "ssn,first_name,last_name,date_of_birth\n" +
  "111223333,bob,smith,1990-01-02\n" +
  "222334444,carol,jones,1985-11-30\n" +
  "333445555,dave,lee,1979-04-02\n";

const WEB_CSV =
  "ssn,first_name,last_name,date_of_birth\n" +
  "444556666,erin,park,1970-07-07\n" +
  "111223333,bob,smith,1990-01-02\n" +
  "222334444,carol,jones,1985-11-30\n";

const CLI_IDENTITY = "Agency A, a@agency-a.example";
const WEB_IDENTITY = "Agency B, b@agency-b.example";

const CLI_DEADLINE_MS = 150_000;

/** The CLI party's wait for its partner, short of the deadline above. */
const PEER_TIMEOUT_MS = 60_000;

/** A STUN address nothing answers on, so the CLI gathers host candidates only
 * and contacts no server off this machine. */
const UNREACHABLE_STUN = "stun:127.0.0.1:9";

/** The broker, the relay and the directory the test runs in. */
interface Harness {
  root: string;
  certificatePath: string;
  broker: StandaloneBroker;
  relayServer: Server;
  relay: WebSocketRelay;
  relayUrl: string;
}

let harness: Harness | undefined;
const enrolled = new Map<string, string>();
const forwardedFrom = new Set<string>();
const defaultCertificates = tls.getCACertificates("default");

beforeAll(async () => {
  if (loopbackTlsCert === null) return;
  const root = mkdtempSync(path.join(tmpdir(), "alcove-cli-web-relay-"));
  const certificatePath = path.join(root, "relay-cert.pem");
  writeFileSync(certificatePath, loopbackTlsCert.cert);
  tls.setDefaultCACertificates([...defaultCertificates, loopbackTlsCert.cert]);
  const broker = await startStandaloneBroker("relay fallback interop:");
  const relayServer = createServer(loopbackTlsCert);
  const relay = attachWebSocketRelay(relayServer, {
    keyTable: { lookup: (exchangeId) => enrolled.get(exchangeId) },
    reportFault: (message) => console.error(`[websocket-relay] ${message}`),
    testing: {
      observer: { forwarded: (_key, from) => forwardedFrom.add(from) },
    },
  });
  relayServer.listen(0, "127.0.0.1");
  await once(relayServer, "listening");
  const { port } = relayServer.address() as AddressInfo;
  harness = {
    root,
    certificatePath,
    broker,
    relayServer,
    relay,
    relayUrl: `wss://127.0.0.1:${port}${RELAY_PATH}`,
  };
}, 60_000);

afterAll(async () => {
  tls.setDefaultCACertificates(defaultCertificates);
  if (harness === undefined) return;
  const { relay, relayServer, broker, root } = harness;
  relay.close();
  relayServer.closeAllConnections();
  await new Promise((resolve) => relayServer.close(resolve));
  await broker.stop();
  rmSync(root, { recursive: true, force: true });
});

function started(): Harness {
  if (harness === undefined) throw new Error("the harness did not start");
  return harness;
}

/** The CLI party's connection block: a webrtc inviter at the broker, with the
 * relay as its own WebSocket relay. */
function webrtcConnectionBlock({ broker, relayUrl }: Harness): string {
  return [
    "connection:",
    "  channel: webrtc",
    "  role: inviter",
    "  server:",
    "    host: 127.0.0.1",
    `    port: ${broker.port}`,
    `    path: ${broker.path}`,
    "    secure: false",
    "  stun:",
    `    - ${UNREACHABLE_STUN}`,
    `  websocket_relay: ${relayUrl}`,
    "  options:",
    `    peer_timeout_ms: ${PEER_TIMEOUT_MS}`,
    "",
  ].join("\n");
}

describe.skipIf(loopbackTlsCert === null)(
  "a CLI party and a web party with WebRTC blocked",
  () => {
    test("complete one exchange over the WebSocket relay", async () => {
      const running = started();
      const { root, certificatePath, relayUrl } = running;
      const cliDir = path.join(root, "cli");
      const webDir = path.join(root, "web");
      for (const dir of [cliDir, webDir]) mkdirSync(dir);
      const cliInput = path.join(cliDir, "input.csv");
      const webInput = path.join(webDir, "input.csv");
      const cliOutput = path.join(cliDir, "out");
      writeFileSync(cliInput, CLI_CSV);
      writeFileSync(webInput, WEB_CSV);

      const invite = await startCli({
        args: ["invite", "--identity", CLI_IDENTITY, cliInput],
        cwd: cliDir,
        timeoutMs: CLI_DEADLINE_MS,
      });
      expectCliSucceeded(invite, "invite");
      fillInConnection(
        path.join(cliDir, "alcove.yaml"),
        webrtcConnectionBlock(running),
      );
      const setup = await acceptAsWebParty({
        token: invitationFrom(invite),
        identity: WEB_IDENTITY,
        inputCsvPath: webInput,
      });
      enrolled.set(
        await deriveRelayExchangeId(setup.sharedSecret),
        await deriveRelayKey(setup.sharedSecret),
      );

      const { websocketRelays } = await relayPlanForRun(
        setup.sharedSecret,
        undefined,
        undefined,
        {
          readOwn: () => ({
            kind: "set",
            relay: { turn: [], stun: [], websocket: relayUrl },
          }),
          build: () => ({ kind: "none" }),
        },
      );
      const notices: Array<string> = [];
      const cli = startCli({
        args: ["exchange", cliInput, cliOutput, "--log-level", "info"],
        cwd: cliDir,
        timeoutMs: CLI_DEADLINE_MS,
        env: { NODE_EXTRA_CA_CERTS: certificatePath },
      });
      const web = (async () => {
        const run = await openRunConnectionWithRelayFallback({
          role: "acceptor",
          sharedSecret: setup.sharedSecret,
          relays: websocketRelays,
          signal: new AbortController().signal,
          onCloseOutcome: () => {},
          onRunNotice: (notice) => notices.push(notice),
          openWebRtc: ({ onPathFailed }) => {
            onPathFailed?.("connection-failed");
            return Promise.reject(
              new ConnectionError("no WebRTC path in Node", "transport"),
            );
          },
        });
        try {
          return await exchangeOver(run.connection, "initiator", setup);
        } finally {
          await run.connection.close().catch(() => {});
          run.release();
        }
      })();
      const [cliRun, webRun] = await Promise.allSettled([cli, web]);

      if (webRun.status === "rejected") throw webRun.reason;
      if (cliRun.status === "rejected") throw cliRun.reason;
      expectCliSucceeded(cliRun.value, "exchange");
      expect(webRun.value.partnerIdentity).toBe(CLI_IDENTITY);
      expect(webRun.value.pairs).toEqual([
        [1, 0],
        [2, 1],
      ]);
      expect(pairsFromResultCsv(resultFileIn(cliOutput))).toEqual([
        [0, 1],
        [1, 2],
      ]);
      expect(cliRun.value.output).toContain(
        "the exchange partner started the exchange on the WebSocket relay, " +
          "so this side starts it there and stops trying WebRTC",
      );
      expect(cliRun.value.output).toContain(
        `the exchange runs over the WebSocket relay at ${relayUrl}`,
      );
      expect(notices).toContain(
        "This exchange runs over the WebSocket relay at " +
          `${new URL(relayUrl).origin}.`,
      );
      expect([...forwardedFrom].sort()).toEqual(["acceptor", "inviter"]);
    });
  },
);
