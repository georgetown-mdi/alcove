/// <reference types="@vitest/browser-playwright/context" />

import { afterAll, beforeAll, expect, test } from "vitest";
import { commands } from "vitest/browser";

import { BROWSER_PAIRS, CLI_PAIRS, openRelayCaseAcceptor } from "./browserPeer";

import type { LiveRelayLegOutcome, LiveRelayLegStart } from "./legTypes";

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
 * so a pairing that forwarded nothing carried none of the exchange.
 */

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    startLiveRelayLeg: () => Promise<LiveRelayLegStart>;
    liveRelayLegOutcome: () => Promise<LiveRelayLegOutcome>;
    stopLiveRelayLeg: () => Promise<void>;
  }
}

/** How long the browser party's relay sockets may take to close once its run
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
  // Before the key exchange: the race closes the relay sockets as WebRTC
  // opens, not at the run's end.
  await expect
    .poll(
      () =>
        sockets.opened.every(
          (socket) => socket.readyState === WebSocket.CLOSED,
        ),
      { timeout: RELAY_SOCKET_CLOSE_TIMEOUT_MS },
    )
    .toBe(true);
  expect(sockets.sentTypes).toEqual(["hello"]);
  expect(sockets.closedWith.every((code) => code === 1000)).toBe(true);

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
  expect(relay.sockets.length).toBeGreaterThanOrEqual(2);
  const closingAt = cli.closingConnectionAt;
  expect(closingAt, cli.output).not.toBeNull();
  // Every relay socket, the CLI party's among them, closed before that party
  // began closing its WebRTC connection, so its race closed it rather than
  // the end of its run.
  for (const socket of relay.sockets) {
    expect(socket.closedAt).not.toBeNull();
    expect(socket.closedAt).toBeLessThanOrEqual(closingAt ?? 0);
  }
});
