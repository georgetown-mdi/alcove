import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  InternalConsistencyError,
  markStatesItsOwnNextStep,
} from "@alcove/core";

import {
  RelayedSelfExplainingError,
  RelayedTerminalError,
  createFetchJobApiClient,
  createServerJobReattachDriver,
} from "@psi/jobClient/serverJobExchangeDriver";
import { failureFor } from "@exchange/useInviterExchange";
import { renderSseFrame } from "@jobs/sse";
import { spawnExchangeJob } from "@jobs/cliDriver";

import {
  STUB_CLI_PATH,
  awaitJobTerminalState,
  trackScratchDirs,
} from "../../utils/jobFixtures";

import type { ExchangeErrorCategory } from "@psi/exchangeLifecycle";
import type { RelayEvent } from "@jobContract/relayEvent";
import type { RunFailure } from "@exchange/useInviterExchange";

// A relayed internal fault and a transport stall both reach the seat as an
// `exchange` terminal whose message states its own next step, so neither the
// category nor the marker tells them apart. The CLI's `internalFault` field
// does, and these legs drive it through the real child process, line reader,
// relay validation, SSE framing, browser job client, and the seat's own
// failure composition.

const INTERNAL_FAULT_MESSAGE =
  "runKex: psk must be 32 bytes\nThis is a fault in Alcove itself: report " +
  "it with this message; retrying will not help.";

const TAGGED_STALL_MESSAGE =
  "the partner did not answer within 10m; confirm they started their half " +
  "and run the exchange again";

const { scratchDir, cleanup: removeScratchDirs } = trackScratchDirs();

afterEach(() => {
  removeScratchDirs();
});

/** The events the relay delivered for a child that wrote `terminal` as its
 * last fd-3 line and exited with `exitCode`. */
async function relayFromChild(
  terminal: Record<string, unknown>,
  exitCode: number,
): Promise<Array<RelayEvent>> {
  const workdir = scratchDir("internal-fault-relay");
  const relayed: Array<RelayEvent> = [];
  await awaitJobTerminalState((onTerminal) =>
    spawnExchangeJob({
      binaryPath: STUB_CLI_PATH,
      configPath: path.join(workdir, "alcove.yaml"),
      keyPath: path.join(workdir, ".alcove.key"),
      inputPath: path.join(workdir, "input.csv"),
      workdir,
      eventStream: true,
      runControls: { sweepExchangeFiles: false, logFilePath: undefined },
      extraEnv: {
        STUB_FD3_EVENTS: JSON.stringify([terminal]),
        STUB_EXIT_CODE: String(exitCode),
      },
      handlers: {
        onEvent: (event) => relayed.push(event),
        onDegraded: () => undefined,
        onTerminal,
      },
    }),
  );
  return relayed;
}

/** The raised failure and the seat's composition of it for a relayed event
 * sequence. */
async function failureAtSeat(
  events: Array<RelayEvent>,
): Promise<{ error: unknown; failure: RunFailure }> {
  const body = events
    .map((event, index) => renderSseFrame(index + 1, event))
    .join("");
  const fetchImpl: typeof fetch = (input) =>
    Promise.resolve(
      String(input).endsWith("/events")
        ? new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          })
        : new Response(null, { status: 404 }),
    );
  const raised: Array<{ category: ExchangeErrorCategory; error: unknown }> = [];
  await createServerJobReattachDriver(
    "job-1",
    createFetchJobApiClient(fetchImpl),
  ).run({
    signal: new AbortController().signal,
    onStages: () => undefined,
    onStage: () => undefined,
    onResult: () => undefined,
    onError: (failure) => raised.push(failure),
  });
  expect(raised).toHaveLength(1);
  return {
    error: raised[0].error,
    failure: failureFor(raised[0].category, raised[0].error),
  };
}

describe("a relayed internal fault withholds the retry", () => {
  test("an exit-70 terminal reaches the seat with its retry withheld", async () => {
    const relayed = await relayFromChild(
      {
        v: 1,
        type: "error",
        category: "exchange",
        message: INTERNAL_FAULT_MESSAGE,
        recoveryHint: true,
        internalFault: true,
      },
      70,
    );
    const errors = relayed.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].internalFault).toBe(true);

    const { error, failure } = await failureAtSeat(relayed);
    expect(error).toBeInstanceOf(RelayedSelfExplainingError);
    expect((error as RelayedTerminalError).internalFault).toBe(true);
    expect(failure.category).toBe("exchange");
    expect(failure.retry).toBe("withheld");
  });

  test("a marked transport stall keeps its retry", async () => {
    const relayed = await relayFromChild(
      {
        v: 1,
        type: "error",
        category: "exchange",
        message: TAGGED_STALL_MESSAGE,
        recoveryHint: true,
      },
      69,
    );
    const { error, failure } = await failureAtSeat(relayed);
    expect(error).toBeInstanceOf(RelayedSelfExplainingError);
    expect((error as RelayedTerminalError).internalFault).toBe(false);
    expect(failure.category).toBe("exchange");
    expect(failure.retry).toBe("offered");
  });

  test("only the literal marker withholds the retry", async () => {
    for (const forged of ["true", 1, {}, null]) {
      const relayed = await relayFromChild(
        {
          v: 1,
          type: "error",
          category: "exchange",
          message: TAGGED_STALL_MESSAGE,
          internalFault: forged,
        },
        69,
      );
      const { failure } = await failureAtSeat(relayed);
      expect(failure.retry).toBe("offered");
    }
  });
});

describe("failureFor's retry disposition", () => {
  test.each<[string, ExchangeErrorCategory, unknown]>([
    ["a security failure", "security", new RelayedTerminalError("kex failed")],
    ["an output failure", "output", new RelayedTerminalError("disk full")],
    ["a config failure", "config", new RelayedTerminalError("bad column")],
    [
      "an internal fault without the marker's step",
      "exchange",
      new RelayedTerminalError("an internal check failed", true),
    ],
    [
      "an internal fault with its step",
      "exchange",
      new RelayedSelfExplainingError(INTERNAL_FAULT_MESSAGE, true),
    ],
  ])("withholds the retry on %s", (_label, category, error) => {
    expect(failureFor(category, error).retry).toBe("withheld");
  });

  test.each<[string, unknown]>([
    ["an unmarked relayed failure", new RelayedTerminalError("peer went away")],
    [
      "a marked transport stall",
      new RelayedSelfExplainingError(TAGGED_STALL_MESSAGE),
    ],
    ["a failure raised in this browser", new Error("socket closed")],
  ])("offers the retry on %s", (_label, error) => {
    expect(failureFor("exchange", error).retry).toBe("offered");
  });
});

describe("an internal fault raised in this browser withholds the retry", () => {
  test.each<[string, Error]>([
    [
      "an unmarked fault",
      new InternalConsistencyError("partner indices disagree"),
    ],
    [
      "the reply-cap fault, which states its own step",
      markStatesItsOwnNextStep(
        new InternalConsistencyError(
          "reply exceeds the cap; report it with this message",
        ),
      ),
    ],
  ])("withholds the retry on %s", (_label, error) => {
    expect(failureFor("exchange", error, undefined, "browser").retry).toBe(
      "withheld",
    );
  });

  test("offers the retry on a plain failure on the same channel", () => {
    expect(
      failureFor("exchange", new Error("socket closed"), undefined, "browser")
        .retry,
    ).toBe("offered");
  });
});
