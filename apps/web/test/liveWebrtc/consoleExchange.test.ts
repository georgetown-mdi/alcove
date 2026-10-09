/// <reference types="@vitest/browser-playwright/context" />

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { commands } from "vitest/browser";

import { decodeInvitation } from "@alcove/core";

import {
  acceptorColumnsEditorState,
  acceptorInitialColumnsState,
  acceptorLaunchPayload,
} from "@exchange/acceptorColumnsModel";
import { acceptorServerJobConfig } from "@exchange/useAcceptorExchange";
import { generateInvitation } from "@psi/invitation";
import { intentFor } from "@psi/jobClient/serverJobExchangeDriver";
import { inviterServerJobConfig } from "@exchange/useInviterExchange";
import { prepareAcceptedInvitation } from "@psi/acceptInvitation";

import {
  BROWSER_CSV,
  BROWSER_IDENTITY,
  BROWSER_PAIRS,
  CLI_PAIRS,
  listenAsBrowserInviter,
  readBrowserCsv,
  runBrowserAcceptor,
} from "./browserPeer";
import { CLI_PARTY_CSV } from "./legTypes";

import type { ConsoleJobOutcome, ConsoleLegStart } from "./legTypes";
import type { BrowserOutcome } from "./browserPeer";
import type { InvitationLocation } from "@psi/invitation";
import type { JobWebrtcExchangeIntent } from "@jobContract/intentSchemas";
import type { ServerJobExchangeDriverConfig } from "@psi/jobClient/serverJobExchangeDriver";
import type { SignalingAddress } from "@psi/transport/signalingAddress";

/**
 * The console conducting a WebRTC exchange: the built console server runs the
 * real `alcove` program as a webrtc job against the coordination server the
 * operator authored, and a real browser peer meets it there, in each seat.
 *
 * The Node side -- the standalone broker and the console server -- runs behind
 * the vitest browser commands in `legCommands.ts`, and its failures carry the
 * leg's environment prefix, as the CLI leg's do (`liveExchange.test.ts`). The
 * console is reached as its browser reaches it: `PUT /api/jobs/webrtc` with a
 * `ws://` address, then `POST /api/jobs`. The intent is the app's own
 * server-job config passed through its own `intentFor`, carried on the webrtc
 * arm.
 */

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    startConsoleWebrtcLeg: () => Promise<ConsoleLegStart>;
    createConsoleWebrtcJob: (
      intent: JobWebrtcExchangeIntent,
    ) => Promise<string>;
    consoleWebrtcJobOutcome: () => Promise<ConsoleJobOutcome>;
    stopConsoleWebrtcLeg: () => Promise<void>;
  }
}

/** The identity the console party declares, which the browser peer reads back
 * off the agreed terms. */
const CONSOLE_IDENTITY = "Agency A, a@agency-a.example";

/** The console party's input, inline as the console sends a file its browser
 * read. */
const CONSOLE_INPUT = { kind: "inline", csv: CLI_PARTY_CSV } as const;

/** The webrtc intent for a server-job config: `intentFor` builds every field
 * but the channel, which it takes from the transport. */
function webrtcIntent(
  config: ServerJobExchangeDriverConfig,
): JobWebrtcExchangeIntent {
  return {
    ...intentFor(config),
    channel: "webrtc",
    side: config.side,
    mountedConfigurationOpened: false,
  };
}

/** The authored coordination server as an address an invitation names. */
function authoredAddress(started: ConsoleLegStart): SignalingAddress {
  const { host, port, path, secure } = started.signaling;
  return { host, path, secure, ...(port !== undefined ? { port } : {}) };
}

/** Where a mint from the authored server points: the deep link is not read
 * here, so it stays on this page's origin. */
function locationFor(started: ConsoleLegStart): InvitationLocation {
  return {
    origin: window.location.origin,
    signaling: authoredAddress(started),
  };
}

/** Stand the leg up for one describe block and take it down after. */
function withConsoleLeg(): () => ConsoleLegStart {
  let started: ConsoleLegStart | undefined;
  beforeAll(async () => {
    started = await commands.startConsoleWebrtcLeg();
  }, 120_000);
  afterAll(async () => {
    await commands.stopConsoleWebrtcLeg();
  }, 60_000);
  return () => {
    if (started === undefined) throw new Error("the leg did not start");
    return started;
  };
}

/** Assert both parties' tables, quoting the console job's events on a
 * failure. */
function expectSameIntersection(
  browser: BrowserOutcome,
  consoleJob: ConsoleJobOutcome,
): void {
  expect(consoleJob.status, consoleJob.events).toBe("succeeded");
  expect(consoleJob.exitCode, consoleJob.events).toBe(0);
  // Each side resolved the intersection at the offsets its OWN file holds,
  // which differ between the two, and the browser peer read the console
  // party's declared identity off the agreed terms.
  expect(browser.partnerIdentity).toBe(CONSOLE_IDENTITY);
  expect(browser.pairs).toEqual(BROWSER_PAIRS);
  expect(consoleJob.pairs, consoleJob.events).toEqual(CLI_PAIRS);
}

describe("a console webrtc job invites and a browser peer accepts", () => {
  const leg = withConsoleLeg();

  test("the console holds the broker as its coordination server (environment precondition)", () => {
    const started = leg();
    expect(
      started.readinessBody,
      "the port answered, but not with the standalone broker's own " +
        "readiness body; something other than that broker is behind it",
    ).toBe(started.expectedReadinessBody);
    expect(started.signaling).toMatchObject({
      host: "127.0.0.1",
      secure: false,
    });
    // A `ws:` server is admitted with a warning, not refused.
    expect(started.signaling.warnings).not.toEqual([]);
  });

  test("the console job and the browser peer resolve the same intersection", async () => {
    const started = leg();
    const { columns } = await readBrowserCsv(CLI_PARTY_CSV);
    const minted = await generateInvitation({
      inviterName: CONSOLE_IDENTITY,
      profiledColumns: columns,
      location: locationFor(started),
    });
    // The invitation names the authored server and no relay: the run
    // connects directly or not at all.
    const { host, port, path } = authoredAddress(started);
    expect((await decodeInvitation(minted.encoded)).connectionEndpoint).toEqual(
      { channel: "webrtc", host, port, path },
    );

    await commands.createConsoleWebrtcJob(
      webrtcIntent(
        inviterServerJobConfig({
          minted,
          inputSource: CONSOLE_INPUT,
          transport: { channel: "filedrop" },
        }),
      ),
    );
    const browser = await runBrowserAcceptor(minted.encoded);
    expectSameIntersection(browser, await commands.consoleWebrtcJobOutcome());
  }, 420_000);
});

describe("a browser peer invites and a console webrtc job accepts", () => {
  const leg = withConsoleLeg();

  test("the console job and the browser peer resolve the same intersection", async () => {
    const started = leg();
    // The browser inviter's deployment and the console share the one broker,
    // so the invitation names the server the console already holds.
    const minted = await generateInvitation({
      inviterName: BROWSER_IDENTITY,
      file: new File([BROWSER_CSV], "input.csv", { type: "text/csv" }),
      location: locationFor(started),
    });
    const inviter = await listenAsBrowserInviter(
      minted,
      authoredAddress(started),
    );
    try {
      // The console seat's own accept-path validation and column edits.
      const accepted = await prepareAcceptedInvitation(minted.encoded, {
        profile: "console",
      });
      const { rawRows, columns } = await readBrowserCsv(CLI_PARTY_CSV);
      const { edits } = acceptorLaunchPayload(
        acceptorColumnsEditorState(
          acceptorInitialColumnsState(columns),
          accepted.token.linkageTerms,
          rawRows,
        ),
      );
      await commands.createConsoleWebrtcJob(
        webrtcIntent(
          acceptorServerJobConfig({
            token: accepted.token,
            acceptorName: CONSOLE_IDENTITY,
            edits,
            inputSource: CONSOLE_INPUT,
            transport: { channel: "filedrop" },
            deduplicate: false,
          }),
        ),
      );
      const browser = await inviter.run();
      expectSameIntersection(browser, await commands.consoleWebrtcJobOutcome());
    } finally {
      inviter.destroy();
    }
  }, 420_000);
});
