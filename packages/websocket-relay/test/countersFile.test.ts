import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RELAY_COUNTER_NAMES,
  formatRelayCounters,
  startRelayCountersFile,
} from "../src/countersFile.ts";

import { eventually } from "./harness.ts";

import type { RelayCounts, RelayCountersFile } from "../src/countersFile.ts";

const directories: string[] = [];
const files: RelayCountersFile[] = [];

afterEach(() => {
  for (const file of files.splice(0)) file.stop();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "relay-counters-"));
  directories.push(directory);
  return directory;
}

const zero = (): RelayCounts => ({
  websocket_pairing_cap_refusals: 0,
  websocket_upgrade_cap_refusals: 0,
});

describe("the counters file's text", () => {
  it("is the registrar's format: the start and the last write to the second, then each count", () => {
    expect(
      formatRelayCounters(
        new Date("2026-11-06T12:00:00.123Z"),
        new Date("2026-11-06T12:34:50.999Z"),
        {
          websocket_pairing_cap_refusals: 3,
          websocket_upgrade_cap_refusals: 1,
        },
      ),
    ).toBe(
      "started=2026-11-06T12:00:00Z\n" +
        "updated=2026-11-06T12:34:50Z\n" +
        "websocket_pairing_cap_refusals=3\n" +
        "websocket_upgrade_cap_refusals=1\n",
    );
  });

  it("names every count the relay keeps", () => {
    expect(Object.keys(zero()).sort()).toEqual([...RELAY_COUNTER_NAMES].sort());
  });
});

describe("the counters file", () => {
  it("is written at start, again once a count changes, and replaced whole with nothing left beside it", async () => {
    const directory = scratch();
    const path = join(directory, "counters");
    const counts = zero();
    files.push(
      startRelayCountersFile({
        path,
        counts: () => ({ ...counts }),
        reportFailure: () => {},
        intervalMs: 20,
      }),
    );
    expect(readFileSync(path, "utf8")).toContain(
      "websocket_pairing_cap_refusals=0\n",
    );
    counts.websocket_pairing_cap_refusals = 2;
    counts.websocket_upgrade_cap_refusals = 5;
    await eventually(() =>
      readFileSync(path, "utf8").includes("websocket_upgrade_cap_refusals=5\n"),
    );
    expect(readFileSync(path, "utf8")).toContain(
      "websocket_pairing_cap_refusals=2\n",
    );
    expect(readdirSync(directory)).toEqual(["counters"]);
  });

  it("keeps one start across its writes", async () => {
    const path = join(scratch(), "counters");
    const counts = zero();
    files.push(
      startRelayCountersFile({
        path,
        counts: () => ({ ...counts }),
        reportFailure: () => {},
        intervalMs: 20,
      }),
    );
    const startOf = (): string | undefined =>
      /^started=(.*)$/m.exec(readFileSync(path, "utf8"))?.[1];
    const started = startOf();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    counts.websocket_pairing_cap_refusals = 1;
    await eventually(() =>
      readFileSync(path, "utf8").includes("websocket_pairing_cap_refusals=1\n"),
    );
    expect(startOf()).toBe(started);
  });

  it("reports a failed write once until one succeeds, then a later failure again", async () => {
    const directory = scratch();
    const parent = join(directory, "state");
    const path = join(parent, "counters");
    const counts = zero();
    const failures: string[] = [];
    files.push(
      startRelayCountersFile({
        path,
        counts: () => ({ ...counts }),
        reportFailure: (message) => failures.push(message),
        intervalMs: 20,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`could not write the counters file ${path}`);

    mkdirSync(parent);
    await eventually(() => readdirSync(parent).includes("counters"));
    rmSync(parent, { recursive: true });
    counts.websocket_upgrade_cap_refusals = 1;
    await eventually(() => failures.length === 2);
  });
});
