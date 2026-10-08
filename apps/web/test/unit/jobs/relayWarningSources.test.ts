import { PassThrough } from "node:stream";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { WARNING_SOURCES } from "@alcove/cli-contract";

import {
  RELAY_WARNING_SOURCES,
  attachFd3Reader,
  spawnExchangeJob,
} from "@jobs/cliDriver";
import { JobManager } from "@jobs/jobManager";

import {
  STUB_CLI_PATH,
  awaitJobTerminalState,
  awaitTerminalEmitted,
  tempDataRoot,
  trackScratchDirs,
  validIntent,
} from "../../utils/jobFixtures";

import type { CliDriverHandlers, RelayWarningSource } from "@jobs/cliDriver";
import type { ChildProcess } from "node:child_process";
import type { JobRecord } from "@jobs/jobManager";
import type { RelayEvent } from "@jobContract/relayEvent";

// A supervisor reading one job stream switches on `source`, so each notice the
// relay composes itself reaches the stream under its own value. Every emission
// site is pinned below and the sites are compared against the declared set, so a
// new degradation cannot inherit another site's value by being added without one
// of its own.

const { scratchDir, cleanup: removeScratchDirs } = trackScratchDirs();
const managers: Array<JobManager> = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  removeScratchDirs();
});

/** The value and text of one degradation notice the driver raised. */
interface Degradation {
  source: RelayWarningSource;
  message: string;
}

/** Resolve once the fd-3 reader has had a turn to deliver what was written. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Drive the stub CLI through the real driver and return what it degraded on.
 * `workdir` defaults to a real scratch directory; the spawn-failure case passes
 * one that does not exist.
 */
async function degradationsFromChild(options: {
  env?: NodeJS.ProcessEnv;
  workdir?: string;
}): Promise<Array<Degradation>> {
  const workdir = options.workdir ?? scratchDir("relay-source");
  const degradations: Array<Degradation> = [];
  await awaitJobTerminalState((onTerminal) =>
    spawnExchangeJob({
      binaryPath: STUB_CLI_PATH,
      configPath: path.join(workdir, "alcove.yaml"),
      keyPath: path.join(workdir, ".alcove.key"),
      inputPath: path.join(workdir, "input.csv"),
      workdir,
      eventStream: true,
      runControls: { sweepExchangeFiles: false, logFilePath: undefined },
      extraEnv: { STUB_EXIT_CODE: "0", ...options.env },
      handlers: {
        onEvent: () => undefined,
        onDegraded: (source, message) => degradations.push({ source, message }),
        onTerminal,
      },
    }),
  );
  return degradations;
}

/** Handlers that collect degradations, with the other two slots inert. */
function collectingHandlers(into: Array<Degradation>): CliDriverHandlers {
  return {
    onEvent: () => undefined,
    onDegraded: (source, message) => into.push({ source, message }),
    onTerminal: () => undefined,
  };
}

/**
 * The degradations the fd-3 reader raises for a child whose fd 3 is `stream`,
 * after `write` has run against it. The stream-level faults (an fd 3 that was
 * never wired, a read error, a flood past the buffer cap) are staged here
 * because a spawned child cannot present them.
 */
async function degradationsFromStream(
  stream: PassThrough | null,
  write: (stream: PassThrough) => void = () => undefined,
): Promise<Array<Degradation>> {
  const degradations: Array<Degradation> = [];
  const child = {
    stdio: [null, null, null, stream],
  } as unknown as ChildProcess;
  attachFd3Reader(child, collectingHandlers(degradations));
  if (stream !== null) write(stream);
  await settle();
  return degradations;
}

/** The buffer cap the fd-3 reader discards an unterminated line past. */
const FD3_LINE_CAP = 1_048_576;

/** The value the filedrop rendezvous preflight's notices are stamped with. */
const PREFLIGHT_SOURCE: RelayWarningSource = "relayRendezvousPreflight";

/** The value a run of the opened configuration stamps on its notice that the
 * mounted file is not the one opened; driven in jobManager.unit.test.ts. */
const OPENED_CONFIGURATION_SOURCE: RelayWarningSource =
  "relayOpenedConfigurationChanged";

/** One degradation site, the fault that reaches it, and the value it claims. */
const DEGRADATION_SITES: Array<{
  site: string;
  source: RelayWarningSource;
  degrade: () => Promise<Array<Degradation>>;
}> = [
  {
    site: "an fd-3 line that is not JSON",
    source: "relayUnparsableEvent",
    degrade: () =>
      degradationsFromChild({ env: { STUB_FD3_RAW: "this is not json\n" } }),
  },
  {
    site: "an fd-3 event outside the v1 vocabulary",
    source: "relayUnknownEvent",
    degrade: () =>
      degradationsFromChild({
        env: { STUB_FD3_EVENTS: JSON.stringify([{ v: 1, type: "invented" }]) },
      }),
  },
  {
    site: "a child that could not be spawned",
    source: "relayProcessError",
    degrade: () =>
      degradationsFromChild({
        workdir: path.join(tempDataRoot("relay-source-absent"), "nowhere"),
      }),
  },
  {
    site: "an fd 3 that was never wired",
    source: "relayStreamUnavailable",
    degrade: () => degradationsFromStream(null),
  },
  {
    site: "a read error on fd 3",
    source: "relayStreamReadError",
    degrade: () =>
      degradationsFromStream(new PassThrough(), (stream) => {
        stream.emit("error", new Error("read failed"));
      }),
  },
  {
    site: "an fd-3 line past the reader's buffer cap",
    source: "relayStreamOversizedLine",
    degrade: () =>
      // No newline anywhere in it, so the reader holds the whole flood in its
      // buffer rather than parsing any of it as a line.
      degradationsFromStream(new PassThrough(), (stream) => {
        stream.write("x".repeat(FD3_LINE_CAP + 1));
      }),
  },
];

describe("the relay stamps its own source on each degradation", () => {
  test.each(DEGRADATION_SITES)(
    "$site is reported as $source",
    async ({ source, degrade }) => {
      const degradations = await degrade();
      expect(degradations.map((entry) => entry.source)).toEqual([source]);
    },
  );

  test("every declared source has a site pinned above", () => {
    const pinned = [...DEGRADATION_SITES.map((entry) => entry.source)];
    expect(
      [...pinned, PREFLIGHT_SOURCE, OPENED_CONFIGURATION_SOURCE].sort(),
    ).toEqual([...RELAY_WARNING_SOURCES].sort());
  });

  test("no relay source is also a CLI one, so the field names which process raised it", () => {
    const cliSources: ReadonlyArray<string> = WARNING_SOURCES;
    expect(
      RELAY_WARNING_SOURCES.filter((source) => cliSources.includes(source)),
    ).toEqual([]);
  });
});

describe("an fd-3 event outside the schema", () => {
  /** The notices the driver raised for a stub run writing `events` on fd 3. */
  async function noticesFor(events: Array<unknown>): Promise<Array<string>> {
    const degradations = await degradationsFromChild({
      env: { STUB_FD3_EVENTS: JSON.stringify(events) },
    });
    return degradations
      .filter((entry) => entry.source === "relayUnknownEvent")
      .map((entry) => entry.message);
  }

  const REMEDY =
    "which this console does not read, so it was skipped. Check that the " +
    "console and the alcove command-line tool it runs come from the same " +
    "release.";

  test.each([
    {
      arrived: "an unknown type",
      event: { v: 1, type: "invented" },
      named: 'an event of type "invented"',
    },
    {
      arrived: "another schema version",
      event: { v: 2, type: "stage", id: "a", label: "A" },
      named: "an event of schema version 2",
    },
  ])(
    "states what arrived and what to do for $arrived",
    async ({ event, named }) => {
      expect(await noticesFor([event])).toEqual([
        `The command-line tool sent ${named}, ${REMEDY}`,
      ]);
    },
  );

  test("is skipped while the events around it still relay", async () => {
    const workdir = scratchDir("relay-unknown-around");
    const relayed: Array<RelayEvent> = [];
    const degradations: Array<Degradation> = [];
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
          STUB_EXIT_CODE: "0",
          STUB_FD3_EVENTS: JSON.stringify([
            { v: 1, type: "stage", id: "a", label: "A" },
            { v: 1, type: "invented" },
            { v: 1, type: "warning", source: "invented", message: "m" },
            { v: 1, type: "result", resultWritten: false },
          ]),
        },
        handlers: {
          onEvent: (event) => relayed.push(event),
          onDegraded: (source, message) =>
            degradations.push({ source, message }),
          onTerminal,
        },
      }),
    );
    // A source this build does not know is an additive change, not a
    // malformed line, so that warning is relayed.
    expect(relayed.map((event) => event.type)).toEqual([
      "stage",
      "warning",
      "result",
    ]);
    expect(degradations.map((entry) => entry.source)).toEqual([
      "relayUnknownEvent",
    ]);
  });

  test("quotes a long or key-bearing type fitted and redacted", async () => {
    const [notice] = await noticesFor([
      {
        v: 1,
        type:
          "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----" +
          "x".repeat(200),
      },
    ]);
    expect(notice).not.toContain("MIIB");
    expect(notice).not.toContain("x".repeat(65));
  });
});

describe("the stamped source reaches the job's event stream", () => {
  /** A manager on a stub CLI that writes one malformed fd-3 line, then exits. */
  function makeManager(rendezvousDir: string): JobManager {
    const manager = new JobManager({
      dataRoot: scratchDir("relay-source-root"),
      binaryPath: STUB_CLI_PATH,
      jobRendezvousDir: rendezvousDir,
      childEnv: {
        STUB_EXIT_CODE: "0",
        STUB_FD3_RAW: "this is not json\n",
        STUB_FD3_EVENTS: JSON.stringify([
          { v: 1, type: "result", resultWritten: true },
        ]),
      },
    });
    managers.push(manager);
    return manager;
  }

  /** The warning events a finished job buffered, in order. */
  async function warningsOf(record: JobRecord): Promise<Array<RelayEvent>> {
    await awaitTerminalEmitted(record);
    return record.events
      .map((entry) => entry.event)
      .filter((event) => event.type === "warning");
  }

  test("a degradation rides the buffered warning beside its degraded mark", async () => {
    const manager = makeManager(scratchDir("relay-source-rvz"));
    const id = await manager.createJob(validIntent());
    const warnings = await warningsOf(manager.getJob(id)!);
    expect(warnings).toEqual([
      expect.objectContaining({
        type: "warning",
        source: "relayUnparsableEvent",
        degraded: true,
      }),
    ]);
  });

  test("a rendezvous preflight notice names the preflight and is not degraded", async () => {
    // A mount that does not exist raises the preflight's own notice; the job
    // still runs, so the degradation above follows it onto the same stream.
    const manager = makeManager(
      path.join(scratchDir("relay-source-rvz"), "no"),
    );
    const id = await manager.createJob(validIntent());
    const warnings = await warningsOf(manager.getJob(id)!);
    expect(warnings[0]).toEqual(
      expect.objectContaining({ type: "warning", source: PREFLIGHT_SOURCE }),
    );
    expect(warnings[0].degraded).toBeUndefined();
    expect(warnings.map((event) => event.source)).toContain(
      "relayUnparsableEvent",
    );
  });

  test("a CLI warning keeps the source the child put on fd 3", async () => {
    const manager = new JobManager({
      dataRoot: scratchDir("relay-source-root"),
      binaryPath: STUB_CLI_PATH,
      jobRendezvousDir: scratchDir("relay-source-rvz"),
      childEnv: {
        STUB_EXIT_CODE: "0",
        STUB_FD3_EVENTS: JSON.stringify([
          {
            v: 1,
            type: "warning",
            source: "hostKeyDivergence",
            message: "the partner reported a different host key",
          },
          { v: 1, type: "result", resultWritten: true },
        ]),
      },
    });
    managers.push(manager);
    const id = await manager.createJob(validIntent());
    const warnings = await warningsOf(manager.getJob(id)!);
    expect(warnings).toEqual([
      expect.objectContaining({
        type: "warning",
        source: "hostKeyDivergence",
      }),
    ]);
    expect(warnings[0].degraded).toBeUndefined();
  });
});

describe("the fd-3 size cap applies to each line", () => {
  const RESULT_LINE =
    JSON.stringify({ v: 1, type: "result", resultWritten: true }) + "\n";

  /** The events and degradations the reader delivers for `chunks`, in order. */
  async function readChunks(
    chunks: Array<string>,
  ): Promise<{ events: Array<RelayEvent>; degradations: Array<Degradation> }> {
    const events: Array<RelayEvent> = [];
    const degradations: Array<Degradation> = [];
    const stream = new PassThrough();
    const child = {
      stdio: [null, null, null, stream],
    } as unknown as ChildProcess;
    attachFd3Reader(child, {
      ...collectingHandlers(degradations),
      onEvent: (event) => events.push(event),
    });
    for (const chunk of chunks) {
      stream.write(chunk);
      await settle();
    }
    stream.end();
    await settle();
    return { events, degradations };
  }

  test("a line under the cap and the lines after it survive a chunk that crosses the cap", async () => {
    const warning = JSON.stringify({
      v: 1,
      type: "warning",
      message: "m".repeat(FD3_LINE_CAP - 100),
    });
    expect(warning.length).toBeLessThan(FD3_LINE_CAP);
    const split = warning.length - 10;
    const { events, degradations } = await readChunks([
      warning.slice(0, split),
      warning.slice(split) + "\n" + "p".repeat(200) + "\n" + RESULT_LINE,
    ]);
    expect(events.map((event) => event.type)).toEqual(["warning", "result"]);
    expect(degradations.map((entry) => entry.source)).toEqual([
      "relayUnparsableEvent",
    ]);
  });

  test("an oversized line is dropped whole and the line after it is read", async () => {
    const { events, degradations } = await readChunks([
      "x".repeat(FD3_LINE_CAP),
      "x".repeat(100),
      "x".repeat(100) + "\n" + RESULT_LINE,
    ]);
    expect(events.map((event) => event.type)).toEqual(["result"]);
    expect(degradations.map((entry) => entry.source)).toEqual([
      "relayStreamOversizedLine",
    ]);
  });

  test("an oversized line arriving whole in one chunk is dropped alone", async () => {
    const { events, degradations } = await readChunks([
      "x".repeat(FD3_LINE_CAP + 1) + "\n" + RESULT_LINE,
    ]);
    expect(events.map((event) => event.type)).toEqual(["result"]);
    expect(degradations.map((entry) => entry.source)).toEqual([
      "relayStreamOversizedLine",
    ]);
  });
});
