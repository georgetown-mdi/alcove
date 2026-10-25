/// <reference types="@vitest/browser-playwright/context" />

import { afterAll, beforeAll, expect, test } from "vitest";
import { commands } from "vitest/browser";

import { BROWSER_PAIRS, CLI_PAIRS, openRelayCaseAcceptor } from "./browserPeer";

import type {
  LiveRelayLegOutcome,
  LiveRelayLegStart,
  LiveRelayObservations,
} from "./legTypes";

/**
 * A CLI party and a browser party whose run names a WebSocket relay, with
 * WebRTC open: the exchange completes over WebRTC and both sides' relay
 * sockets close unused.
 *
 * The CLI party is an `alcove exchange` inviter whose configuration names the
 * broker and a `wss` relay the leg's Node side runs on loopback, so its
 * invitation names both; the browser party lists the relay from that
 * invitation and races it against the app's WebRTC dial through the app's own
 * relay fallback. The interop suite covers the same pair with WebRTC blocked
 * (test/interop/cliWebRelayFallback.test.ts); this case needs a browser peer
 * connection, which a Node host cannot stand up.
 *
 * The relay forwards a message only once both parties have sent their start,
 * so a pairing that forwarded nothing carried none of the exchange. The relay
 * also closes a party's socket when its partner's closes, so the browser
 * party's closes are held back until the CLI party's socket has closed at the
 * relay, which only the CLI party can then have closed.
 */

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    startLiveRelayLeg: () => Promise<LiveRelayLegStart>;
    liveRelayLegObservations: () => Promise<LiveRelayObservations>;
    liveRelayLegOutcome: () => Promise<LiveRelayLegOutcome>;
    stopLiveRelayLeg: () => Promise<void>;
  }
}

/** How long a party's relay sockets may take to close once its run
 * connection has opened: a close handshake on loopback, well under this. */
const RELAY_SOCKET_CLOSE_TIMEOUT_MS = 5_000;

let started: LiveRelayLegStart;

beforeAll(async () => {
  started = await commands.startLiveRelayLeg();
}, 120_000);

afterAll(async () => {
  await commands.stopLiveRelayLeg();
}, 60_000);

test("with WebRTC open the exchange runs over WebRTC and the relay sockets close unused", async () => {
  const acceptor = await openRelayCaseAcceptor(started.invitation);

  expect(acceptor.listedRelays).toEqual([started.relayUrl]);
  expect(acceptor.notices).toEqual([
    "This exchange runs over the WebRTC connection.",
  ]);
  const { sockets } = acceptor;
  expect(sockets.opened.length).toBeGreaterThan(0);
  expect(sockets.sentTypes).toEqual(["hello"]);
  // The browser party's race closed with 1000 every socket the relay had not
  // already closed when its run connection opened.
  for (const { closeCodes, readyStateAtRunOpen } of sockets.opened) {
    if (closeCodes.length > 0)
      expect(new Set(closeCodes)).toEqual(new Set([1000]));
    else expect(readyStateAtRunOpen).toBe(WebSocket.CLOSED);
  }

  // Before the key exchange: each race closes its relay sockets as WebRTC
  // opens, not at the run's end.
  await expect
    .poll(
      async () =>
        (await commands.liveRelayLegObservations()).sockets.every(
          (socket) => socket.fromBrowser || socket.closedAt !== null,
        ),
      { timeout: RELAY_SOCKET_CLOSE_TIMEOUT_MS },
    )
    .toBe(true);
  sockets.releaseCloses();
  await expect
    .poll(
      () =>
        sockets.opened.every(
          ({ socket }) => socket.readyState === WebSocket.CLOSED,
        ),
      { timeout: RELAY_SOCKET_CLOSE_TIMEOUT_MS },
    )
    .toBe(true);

  const browser = await acceptor.exchange();
  const { cli, relay } = await commands.liveRelayLegOutcome();

  expect(
    cli.killedOnDeadline,
    `the CLI party was killed on its deadline\n${cli.output}`,
  ).toBe(false);
  expect(cli.exitCode, cli.output).toBe(0);
  expect(browser.partnerIdentity).toBe(started.cliIdentity);
  expect(browser.pairs).toEqual(BROWSER_PAIRS);
  expect(cli.pairs).toEqual(CLI_PAIRS);

  expect(cli.output).toContain("the exchange runs over the WebRTC connection");
  expect(cli.output).not.toContain("this side also offers the exchange");
  expect(cli.output).not.toContain("this side starts it there");

  // The relay checked the CLI party's hello, which the leg's start waited
  // for, and the browser party's, and forwarded nothing on their pairing.
  expect(relay.hellos).toBeGreaterThanOrEqual(2);
  expect(relay.forwarded).toBe(0);
  const closingAt = cli.closingConnectionAt;
  expect(closingAt, cli.output).not.toBeNull();
  for (const socket of relay.sockets) {
    expect(socket.closedAt).not.toBeNull();
    expect(socket.closedAt).toBeLessThanOrEqual(closingAt ?? 0);
  }
  // With the browser party's closes held back, the CLI party's sockets closed
  // first, so its own race closed them, before it began closing its WebRTC
  // connection.
  const closeOrders = (fromBrowser: boolean): Array<number> =>
    relay.sockets
      .filter((socket) => socket.fromBrowser === fromBrowser)
      .map((socket) => socket.closeOrder ?? Number.NaN);
  const cliCloses = closeOrders(false);
  const browserCloses = closeOrders(true);
  expect(cliCloses.length).toBeGreaterThan(0);
  expect(browserCloses.length).toBeGreaterThan(0);
  expect(Math.max(...cliCloses)).toBeLessThan(Math.min(...browserCloses));
});
