/// <reference types="@vitest/browser-playwright/context" />

import { afterAll, beforeAll, expect, test } from "vitest";
import { commands } from "vitest/browser";

import { BROWSER_PAIRS, CLI_PAIRS, runBrowserAcceptor } from "./browserPeer";

import type { LiveLegCliOutcome, LiveLegStart } from "./legTypes";
import type { BrowserOutcome } from "./browserPeer";

/**
 * A real `alcove` process and a real browser peer completing one WebRTC PSI
 * exchange through the standalone signaling broker, with each side's
 * association table asserted and each side's clean-close wait measured.
 *
 * The known-answer interop vectors
 * (packages/core/test/vectors/webrtc-interop-vectors.json) pin that the two
 * implementations CONSTRUCT the same rendezvous ids, handshake roles and
 * endpoints; they cannot see a divergence that only appears on the wire --
 * framing, close sequencing, delivery on teardown. This is the leg where the
 * two meet.
 *
 * The CLI holds the inviter seat, which is what puts the broker on an origin
 * of its own: the invitation it mints from a `ws://` coordination-server URL
 * names that broker, and the browser peer dials what the invitation names. A
 * browser inviter would name its own page's origin instead.
 *
 * The Node side -- the broker and the `alcove` process -- runs behind the
 * vitest browser commands in `legCommands.ts`. Its failures are prefixed
 * `LEG_ENVIRONMENT_FAILURE` (legTypes.ts), so an environment that could not
 * stand the leg up is never read as an interop divergence.
 */

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    startLiveWebrtcLeg: () => Promise<LiveLegStart>;
    liveWebrtcCliOutcome: () => Promise<LiveLegCliOutcome>;
    stopLiveWebrtcLeg: () => Promise<void>;
  }
}

let started: LiveLegStart;
let browserOutcome: BrowserOutcome | undefined;
let cliOutcome: LiveLegCliOutcome | undefined;

/** Every URL `fetch` was called with while the leg ran, for the peer-id check
 * below. */
const fetched: Array<string> = [];
let realFetch: typeof globalThis.fetch;

beforeAll(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(input instanceof Request ? input.url : String(input));
    return realFetch.call(globalThis, input, init);
  };
  started = await commands.startLiveWebrtcLeg();
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await commands.stopLiveWebrtcLeg();
}, 60_000);

test("the standalone broker answers on an origin of its own (environment precondition)", () => {
  // Separate from, and ahead of, the exchange below: a broker that is not the
  // vendored one, or that sits on the page's own origin, fails here rather than
  // being blamed on the interop path.
  expect(
    started.readinessBody,
    "the port answered, but not with the standalone broker's own readiness " +
      "body; something other than that broker is behind it",
  ).toBe(started.expectedReadinessBody);
  expect(started.brokerOrigin).not.toBe(window.location.origin);
  expect(started.invitation).toMatch(/^[A-Za-z0-9_-]+$/);
});

test("a CLI peer and a browser peer resolve the same intersection", async () => {
  browserOutcome = await runBrowserAcceptor(started.invitation);
  cliOutcome = await commands.liveWebrtcCliOutcome();

  expect(
    cliOutcome.killedOnDeadline,
    `the CLI party was killed on its deadline\n${cliOutcome.output}`,
  ).toBe(false);
  expect(cliOutcome.exitCode, cliOutcome.output).toBe(0);

  // Each side resolved the intersection at the offsets its OWN file holds,
  // which differ between the two, and the browser peer read the CLI party's
  // declared identity off the agreed terms.
  expect(browserOutcome.partnerIdentity).toBe(started.cliIdentity);
  expect(browserOutcome.pairs).toEqual(BROWSER_PAIRS);
  expect(cliOutcome.pairs).toEqual(CLI_PAIRS);
}, 420_000);

/**
 * The ceiling this leg holds the browser party's wait under. Sized between the
 * two outcomes it separates rather than around the measurement: a wait that
 * ends on the CLI party's close costs milliseconds, while a wait left to end on
 * ICE giving up on that party costs 15 s or more. Anything under this is the
 * former, and a regression to the latter cannot pass.
 */
const BROWSER_CLOSE_WAIT_CEILING_MS = 5_000;

test("each side's clean-close wait is measured and recorded", () => {
  if (browserOutcome === undefined || cliOutcome === undefined)
    throw new Error("the exchange did not run, so there is nothing to measure");

  // The numbers themselves stay a tracked limit recorded in
  // docs/spec/WEBRTC_TRANSPORT.md ("The clean close"), read across nightly runs;
  // what is asserted below is the exit each wait takes, not a duration drawn
  // from one measurement.
  console.log(
    `[live-webrtc] close wait: browser ${browserOutcome.closeWaitMs}ms ` +
      `(${String(browserOutcome.closeOutcome)}, ended before its own close: ` +
      `${browserOutcome.endBeforeOwnClose}), CLI ` +
      `${String(cliOutcome.closeWaitMs)}ms`,
  );
  // The exit is read against the ordering the run took, because the two
  // orderings have different right answers and an absent outcome on its own is
  // also what a link that died before this party's close leaves behind.
  if (browserOutcome.endBeforeOwnClose === "none") {
    // This party closed first, so the CLI party's close has to end the wait --
    // the one exit that is a delivery signal. Every other one raises the
    // operator's doubt notice on a run whose result is correct.
    expect(browserOutcome.closeOutcome).toBe("peer-closed");
  } else {
    expect(
      browserOutcome.endBeforeOwnClose,
      "the connection ended before this party's close, and on something other " +
        "than the CLI party's close sentinel",
    ).toBe("peer-close");
    // PeerJS ends the connection on reading that sentinel, so the flushing
    // close finds it already ended, takes no wait, and reports no outcome.
    expect(browserOutcome.closeOutcome).toBeUndefined();
  }
  expect(browserOutcome.closeWaitMs).toBeLessThan(
    BROWSER_CLOSE_WAIT_CEILING_MS,
  );
  // A null CLI number means that party never reached a close at all.
  expect(cliOutcome.closeWaitMs).not.toBeNull();
});

test("the browser peer reaches the broker over the signaling socket alone", () => {
  // PeerJS asks the broker for an id over HTTP only when constructed without
  // one, and Alcove always supplies the id derived from the invitation secret.
  // So a broker on an origin of its own needs no CORS header for this app: the
  // only thing that crosses is the WebSocket, which CORS does not govern. This
  // is that claim as a check rather than a note.
  //
  // The recorder is asserted to still be in place, so an empty list is the
  // absence of a request rather than the absence of a recorder.
  expect(globalThis.fetch).not.toBe(realFetch);
  expect(fetched.filter((url) => url.startsWith(started.brokerOrigin))).toEqual(
    [],
  );
});
