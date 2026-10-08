import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, expect, test } from "vitest";

import { spawnExchangeJob } from "@jobs/cliDriver";

import { cliEntry } from "./cliParty";

import type { JobTerminalState } from "@jobs/cliDriver";
import type { RelayEvent } from "@jobContract/relayEvent";

/**
 * A configuration the real `alcove` refuses at load, driven as the console's
 * job driver drives it: the refusal arrives on the event stream as a `config`
 * terminal event, so the console reports it from that event rather than
 * synthesizing one from the run's stderr.
 */

const CSV = "ssn,last_name\n123456789,SMITH\n";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "alcove-config-refusal-"));
  writeFileSync(path.join(workdir, "input.csv"), CSV);
  writeFileSync(path.join(workdir, "alcove.key"), "{}\n");
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

interface DrivenRun {
  events: Array<RelayEvent>;
  terminal: JobTerminalState;
  /** How many events had arrived when the terminal state was delivered. */
  eventsBeforeTerminal: number;
}

function driveExchange(config: string): Promise<DrivenRun> {
  const configPath = path.join(workdir, "alcove.yaml");
  writeFileSync(configPath, config);
  const events: Array<RelayEvent> = [];
  return new Promise((resolve) => {
    spawnExchangeJob({
      binaryPath: cliEntry,
      configPath,
      keyPath: path.join(workdir, "alcove.key"),
      inputPath: path.join(workdir, "input.csv"),
      workdir,
      eventStream: true,
      runControls: { sweepExchangeFiles: false, logFilePath: undefined },
      handlers: {
        onEvent: (event) => events.push(event),
        onDegraded: () => {},
        onTerminal: (terminal) =>
          resolve({ events, terminal, eventsBeforeTerminal: events.length }),
      },
    });
  });
}

function expectConfigTerminal(run: DrivenRun): RelayEvent {
  expect(run.terminal).toMatchObject({ outcome: "failed", exitCode: 64 });
  expect(run.eventsBeforeTerminal).toBe(run.events.length);
  const terminal = run.events.at(-1);
  expect(terminal).toMatchObject({
    type: "error",
    category: "config",
    exitCode: 64,
  });
  return terminal as RelayEvent;
}

test("a configuration that is not YAML reaches the console as a config event", async () => {
  const run = await driveExchange("connection: [unclosed\n");
  const terminal = expectConfigTerminal(run);
  expect(String(terminal.message)).toContain("could not be parsed as YAML");
});

test("a configuration the schema refuses reaches the console as a config event", async () => {
  const run = await driveExchange("connection:\n  channel: carrier-pigeon\n");
  const terminal = expectConfigTerminal(run);
  expect(String(terminal.message)).toContain("is not a valid exchange spec");
});
