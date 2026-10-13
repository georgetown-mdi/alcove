/// <reference types="@vitest/browser-playwright/context" />

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { commands } from "vitest/browser";

import { decodeInvitation, snakeizeKeys } from "@alcove/core";

import {
  acceptorColumnsEditorState,
  acceptorInitialColumnsState,
  acceptorLaunchPayload,
} from "@exchange/acceptorColumnsModel";
import {
  acceptorServerJobConfig,
  acceptorWebrtcTransport,
} from "@exchange/useAcceptorExchange";
import {
  inviterServerJobConfig,
  inviterServerJobTransport,
} from "@exchange/useInviterExchange";
import { acceptedSignalingServer } from "@console/signalingServerModel";
import { generateInvitation } from "@psi/invitation";
import { intentFor } from "@psi/jobClient/serverJobExchangeDriver";
import { jobExchangeIntentSchema } from "@jobContract/intentSchemas";
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
import { CLI_IDENTITY, CLI_PARTY_CSV } from "./legTypes";

import type {
  ConsoleAnswer,
  ConsoleJobOutcome,
  ConsoleLegStart,
  ConsoleWorkingFolderFiles,
} from "./legTypes";
import type {
  JobConfigurationHandBack,
  JobWebrtcExchangeIntent,
} from "@jobContract/intentSchemas";
import type { BrowserOutcome } from "./browserPeer";
import type { InvitationLocation } from "@psi/invitation";
import type { ServerJobExchangeDriverConfig } from "@psi/jobClient/serverJobExchangeDriver";
import type { SignalingAddress } from "@psi/transport/signalingAddress";

/**
 * The console conducting a WebRTC exchange: the built console server runs the
 * real `alcove` program as a webrtc job against the coordination server it
 * holds, and a real browser peer meets it there, in each seat.
 *
 * The Node side -- the standalone broker and the console server -- runs behind
 * the vitest browser commands in `legCommands.ts`, and its failures have the
 * leg's environment prefix, as the CLI leg's do (`liveExchange.test.ts`). The
 * console is reached as its browser reaches it: `PUT /api/jobs/webrtc`, then
 * `POST /api/jobs`. The intent is composed by the app's own server-job
 * config and transport helpers and checked against the console's intent
 * schema; the accept sets the console's server through the app's own
 * {@link acceptorWebrtcTransport}, its request forwarded to the console by a
 * command, since the page cannot reach the console's origin.
 */

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    startConsoleWebrtcLeg: () => Promise<ConsoleLegStart>;
    putConsoleSignalingServer: (body: string) => Promise<ConsoleAnswer>;
    createConsoleWebrtcJob: (
      intent: JobWebrtcExchangeIntent,
    ) => Promise<string>;
    consoleWorkingFolderFiles: () => Promise<ConsoleWorkingFolderFiles>;
    openConsoleConfiguration: (files: {
      config: string;
      key: string;
    }) => Promise<ConsoleAnswer>;
    saveConsoleConfiguration: (body: string) => Promise<ConsoleAnswer>;
    consoleWebrtcJobOutcome: () => Promise<ConsoleJobOutcome>;
    stopConsoleWebrtcLeg: () => Promise<void>;
  }
}

/** The identity the console party declares, which the browser peer reads back
 * off the agreed terms. */
const CONSOLE_IDENTITY = CLI_IDENTITY;

/** The console party's input, inline as the console sends a file its browser
 * read. */
const CONSOLE_INPUT = { kind: "inline", csv: CLI_PARTY_CSV } as const;

/** The webrtc intent the app posts for a server-job config, parsed by the
 * console's own intent schema, so a schema change fails this test where it is
 * made. */
function webrtcIntent(
  config: ServerJobExchangeDriverConfig,
): JobWebrtcExchangeIntent {
  const intent = jobExchangeIntentSchema.parse(intentFor(config));
  if (intent.channel !== "webrtc")
    throw new Error("the schema returned a non-webrtc intent");
  return intent;
}

/** A fetch that forwards the app's `PUT /api/jobs/webrtc` to the console. */
const consoleFetch: typeof fetch = async (_input, init) => {
  const answer = await commands.putConsoleSignalingServer(String(init?.body));
  return new Response(answer.body, {
    status: answer.status,
    headers: { "content-type": "application/json" },
  });
};

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

/** The connection the working folder's `alcove.yaml` states once the run has
 * ended, beside the key file the run rotated in place. */
async function workingFolderConnection(): Promise<Record<string, unknown>> {
  const files = await commands.consoleWorkingFolderFiles();
  expect(files.keyPresent).toBe(true);
  if (files.config === null)
    throw new Error("the working folder holds no alcove.yaml");
  return (parseYaml(files.config) as { connection: Record<string, unknown> })
    .connection;
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
          transport: inviterServerJobTransport("webrtc", minted),
        }),
      ),
    );
    const browser = await runBrowserAcceptor(minted.encoded);
    expectSameIntersection(browser, await commands.consoleWebrtcJobOutcome());
    expect(await workingFolderConnection()).toMatchObject({
      channel: "webrtc",
      role: "inviter",
    });
  }, 420_000);
});

describe("a browser peer invites and a console webrtc job accepts", () => {
  const leg = withConsoleLeg();

  test("the console job and the browser peer resolve the same intersection", async () => {
    const started = leg();
    // The browser inviter's deployment and the console share the one broker.
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
      if (accepted.endpoint.channel !== "webrtc")
        throw new Error("the invitation names no coordination server");
      // The console already holds the broker over ws://, so the accept dials
      // it that way rather than over wss://, which the broker does not serve.
      const server = acceptedSignalingServer(
        accepted.endpoint,
        started.signaling,
      );
      if (server === undefined)
        throw new Error("the console cannot hold the invitation's server");
      expect(server.address).toBe(
        `ws://127.0.0.1:${started.signaling.port}${started.signaling.path}`,
      );
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
            transport: await acceptorWebrtcTransport(server, consoleFetch),
            deduplicate: false,
          }),
        ),
      );
      const browser = await inviter.run();
      expectSameIntersection(browser, await commands.consoleWebrtcJobOutcome());
      // The run wrote its configuration and key file into the working folder,
      // as `alcove accept` does, and ran over them there.
      expect(await workingFolderConnection()).toMatchObject({
        channel: "webrtc",
        role: "acceptor",
        server: {
          host: "127.0.0.1",
          port: started.signaling.port,
          path: started.signaling.path,
          secure: false,
        },
      });
    } finally {
      inviter.destroy();
    }
  }, 420_000);
});

describe("a webrtc alcove.yaml opened in the console runs in place", () => {
  const leg = withConsoleLeg();

  test("the console job and the browser peer resolve the same intersection", async () => {
    const started = leg();
    const { columns } = await readBrowserCsv(CLI_PARTY_CSV);
    const minted = await generateInvitation({
      inviterName: CONSOLE_IDENTITY,
      profiledColumns: columns,
      location: locationFor(started),
    });
    // The pair an inviter's `alcove invite` leaves in the working folder,
    // naming the leg's broker, while the console holds another coordination
    // server: the run dials the one the file names.
    const { host, port, path } = authoredAddress(started);
    const elsewhere = await commands.putConsoleSignalingServer(
      JSON.stringify({ address: "wss://coordination.invalid/" }),
    );
    expect(elsewhere.status, elsewhere.body).toBe(200);
    const opened = await commands.openConsoleConfiguration({
      config: stringifyYaml(
        snakeizeKeys({
          connection: {
            channel: "webrtc",
            role: "inviter",
            server: { host, port, path, secure: false },
          },
          linkageTerms: minted.linkageTerms,
          ...(minted.metadata !== undefined
            ? { metadata: minted.metadata }
            : {}),
        }),
      ),
      key: JSON.stringify({ sharedSecret: minted.sharedSecret }),
    });
    expect(opened.status, opened.body).toBe(200);
    const answer = JSON.parse(opened.body) as {
      document: { signalingServer?: string; relayTurnUrls?: Array<string> };
      keyFileFault?: string;
    };
    expect(answer.document.relayTurnUrls).toBeUndefined();
    expect(answer.keyFileFault).toBeUndefined();
    // The review step shows the server the file names, and the screen saves
    // its steps into the file before the run.
    expect(answer.document.signalingServer).toBe(`ws://${host}:${port}${path}`);
    const handBack: JobConfigurationHandBack = {
      linkageTerms: minted.linkageTerms,
      ...(minted.metadata !== undefined ? { metadata: minted.metadata } : {}),
      signing: { mode: "none" },
    };
    const saved = await commands.saveConsoleConfiguration(
      JSON.stringify(handBack),
    );
    expect(saved.status, saved.body).toBe(200);

    const intent = webrtcIntent(
      inviterServerJobConfig({
        minted,
        inputSource: CONSOLE_INPUT,
        transport: inviterServerJobTransport("webrtc", minted, true),
        mountedConfigurationOpened: true,
      }),
    );
    expect(intent.signalingServer).toBeUndefined();
    await commands.createConsoleWebrtcJob(intent);
    const browser = await runBrowserAcceptor(minted.encoded);
    expectSameIntersection(browser, await commands.consoleWebrtcJobOutcome());
    expect(await workingFolderConnection()).toMatchObject({
      channel: "webrtc",
      role: "inviter",
      server: { host, port, path, secure: false },
    });
  }, 420_000);
});
