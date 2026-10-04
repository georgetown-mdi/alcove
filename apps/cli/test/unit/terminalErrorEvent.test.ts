import fs from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import { getLogger } from "@alcove/core";
import type { ConnectionConfig } from "@alcove/core";

import {
  EVENT_STREAM_FD,
  PERSISTENCE_LOSS_EXIT_CODE,
  buildErrorEvent,
  openEventStream,
  type EventStreamEmitter,
} from "../../src/eventStream";
import { assertHostKeyTrustCanBeEstablished } from "../../src/hostKeyTrust";
import {
  INTERNAL_FAULT_EXIT_CODE,
  exitCodeForError,
  exitOnUncaughtError,
  exitWithError,
  installTerminalFailureReporter,
  runOrExit,
} from "../../src/util/exit";
import { captureFd3 } from "../eventStreamTestSupport";
import { ERROR_CLASS_EXIT_CODES } from "../exitCodeCases";
import { captureProcessExit } from "../exitCapture";

// The exit boundary is where the process exit code is decided, and where a
// failure no earlier site reported becomes the stream's terminal `error`
// event. Each case opens the stream as a command does, takes the boundary's
// exit, and reads what fd 3 received.

afterEach(() => {
  vi.restoreAllMocks();
});

const silentLog = { error: (): void => undefined };

getLogger("terminal-error-test").setLevel("silent");

/** Open the stream, run `before` on it, then exit through `exit`. */
async function linesAfterExit(
  exit: () => unknown,
  code: number,
  before: (emitter: EventStreamEmitter) => void = () => undefined,
): Promise<Array<Record<string, unknown>>> {
  const { lines } = await captureFd3(async () => {
    const emitter = openEventStream(true);
    if (emitter === undefined) throw new Error("no emitter for an open stream");
    before(emitter);
    captureProcessExit();
    await expect(async () => {
      await exit();
    }).rejects.toThrow(`exit:${code}`);
  });
  return lines;
}

function errorEventsOf(
  lines: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return lines.filter((line) => line.type === "error");
}

/** The unpinned-host refusal as a non-interactive run raises it. */
function unpinnedHostRefusal(): unknown {
  const connection = {
    channel: "sftp",
    server: { host: "sftp.example.org", port: 22, username: "alcove" },
  } as unknown as ConnectionConfig;
  const isTTY = process.stdin.isTTY;
  process.stdin.isTTY = false;
  try {
    assertHostKeyTrustCanBeEstablished(connection, { mode: "ephemeral" });
  } catch (err) {
    return err;
  } finally {
    process.stdin.isTTY = isTTY;
  }
  throw new Error("an unpinned host on a non-interactive run was not refused");
}

const BOUNDARY_CASES: ReadonlyArray<{
  readonly planted: string;
  readonly code: number;
  readonly plant: () => unknown;
}> = [
  ...ERROR_CLASS_EXIT_CODES,
  {
    planted: "the unpinned-host refusal",
    code: 64,
    plant: unpinnedHostRefusal,
  },
];

describe.each(BOUNDARY_CASES)(
  "the exit boundary, on $planted",
  ({ code, plant }) => {
    test(`exitWithError emits one terminal error event with exitCode ${code}`, async () => {
      const err = plant();
      expect(exitCodeForError(err)).toBe(code);
      const lines = await linesAfterExit(
        () => exitWithError(silentLog, err, exitCodeForError(err)),
        code,
      );
      const errors = errorEventsOf(lines);
      expect(errors).toHaveLength(1);
      expect(lines.at(-1)).toBe(errors[0]);
      expect(errors[0]).toEqual({
        ...buildErrorEvent(plant(), "prepare"),
        exitCode: code,
      });
      expect(errors[0]?.internalFault === true).toBe(
        code === INTERNAL_FAULT_EXIT_CODE,
      );
    });

    test(`runOrExit emits one terminal error event with exitCode ${code}`, async () => {
      const lines = await linesAfterExit(
        () =>
          runOrExit("terminal-error-test", async () => {
            throw plant();
          }),
        code,
      );
      const errors = errorEventsOf(lines);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.exitCode).toBe(code);
    });

    test("a failure the lifecycle already reported is not reported twice", async () => {
      const err = plant();
      const lines = await linesAfterExit(
        () => exitWithError(silentLog, err, exitCodeForError(err)),
        code,
        (emitter) => emitter.error(err, "run"),
      );
      const errors = errorEventsOf(lines);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(buildErrorEvent(err, "run"));
      expect(errors[0]?.exitCode).toBe(code);
    });
  },
);

test("the boundary's own code is the event's exitCode, and decides internalFault", async () => {
  const lines = await linesAfterExit(
    () => exitWithError(silentLog, new Error("an unclassified failure"), 64),
    64,
  );
  expect(errorEventsOf(lines)).toEqual([
    expect.objectContaining({ exitCode: 64 }),
  ]);
  expect("internalFault" in (errorEventsOf(lines)[0] ?? {})).toBe(false);
});

test("a result file that did not reach disk reports exitCode 73", async () => {
  const err = Object.assign(new Error("the result file did not reach disk"), {
    exitCode: PERSISTENCE_LOSS_EXIT_CODE,
  });
  const lines = await linesAfterExit(
    () => exitWithError(silentLog, err, exitCodeForError(err)),
    PERSISTENCE_LOSS_EXIT_CODE,
    (emitter) => emitter.error(err, "output"),
  );
  expect(errorEventsOf(lines)).toEqual([
    expect.objectContaining({
      category: "output",
      exitCode: PERSISTENCE_LOSS_EXIT_CODE,
    }),
  ]);
});

test("an error no command handler caught reports exitCode 1", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const lines = await linesAfterExit(
    () => exitOnUncaughtError(new Error("escaped every handler")),
    1,
  );
  expect(errorEventsOf(lines)).toEqual([
    expect.objectContaining({ exitCode: 1, category: "exchange" }),
  ]);
});

test("a run that reported its result gets no error event from a later exit", async () => {
  const lines = await linesAfterExit(
    () => exitWithError(silentLog, new Error("after the outcome"), 69),
    69,
    (emitter) =>
      emitter.result({
        localDeduplicate: false,
        partnerDeduplicate: false,
        cardinality: "one-to-one",
      }),
  );
  expect(lines.map((line) => line.type)).toEqual(["result"]);
});

test("a successful run emits no error event", async () => {
  const { lines } = await captureFd3(async () => {
    openEventStream(true)?.result({
      localDeduplicate: false,
      partnerDeduplicate: false,
      cardinality: "one-to-one",
    });
  });
  expect(errorEventsOf(lines)).toEqual([]);
});

test("with no stream open the boundary writes nothing to fd 3", async () => {
  const writeSync = vi.spyOn(fs, "writeSync");
  expect(openEventStream(false)).toBeUndefined();
  captureProcessExit();
  expect(() => exitWithError(silentLog, new Error("no stream"), 69)).toThrow(
    "exit:69",
  );
  expect(writeSync.mock.calls.filter(([fd]) => fd === EVENT_STREAM_FD)).toEqual(
    [],
  );
});

test("a failed fd-3 preflight leaves the boundary nothing to report on", () => {
  const realFstatSync = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementation(((
    fd: number,
    ...rest: unknown[]
  ) => {
    if (fd === EVENT_STREAM_FD) throw new Error("EBADF");
    return (realFstatSync as (...a: unknown[]) => fs.Stats)(fd, ...rest);
  }) as typeof fs.fstatSync);
  let preflightError: unknown;
  try {
    openEventStream(true);
  } catch (err) {
    preflightError = err;
  }
  expect(preflightError).toBeDefined();
  const writeSync = vi.spyOn(fs, "writeSync");
  captureProcessExit();
  expect(() => exitWithError(silentLog, preflightError, 64)).toThrow("exit:64");
  expect(writeSync.mock.calls.filter(([fd]) => fd === EVENT_STREAM_FD)).toEqual(
    [],
  );
});

test("a reporter that throws still exits with the boundary's code and one stderr line", () => {
  installTerminalFailureReporter(() => {
    throw new Error("EPIPE: the reader\nclosed fd 3");
  });
  const stderrWrite = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  captureProcessExit();
  expect(() =>
    exitWithError(silentLog, new Error("the run failed"), 76),
  ).toThrow("exit:76");
  expect(stderrWrite).toHaveBeenCalledTimes(1);
  const written = String(stderrWrite.mock.calls[0]?.[0]);
  expect(written).toMatch(/^[^\n]*EPIPE[^\n]*closed fd 3\n$/);
});
