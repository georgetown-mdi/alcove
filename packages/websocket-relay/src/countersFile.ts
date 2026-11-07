import { renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// The relay's counters file, which the relay host's publisher reads
// (infra/relay/aws/publish-metrics.sh): one name=value line each, in the
// registrar's counters format (infra/relay/README.md, What it counts).

/**
 * The counts the relay writes, each under the metric name the publisher gives
 * it: hellos refused at the pairing cap (4008), and upgrades refused at the
 * cap on sockets awaiting a hello (503).
 */
export const RELAY_COUNTER_NAMES = [
  "websocket_pairing_cap_refusals",
  "websocket_upgrade_cap_refusals",
] as const;

/** One of {@link RELAY_COUNTER_NAMES}. */
export type RelayCounterName = (typeof RELAY_COUNTER_NAMES)[number];

/** Each count since the relay started. */
export type RelayCounts = Record<RelayCounterName, number>;

/** How often (ms) the file is written at most, and only when a count changed:
 * the registrar's `COUNTERS_WRITE_SECONDS`. */
export const RELAY_COUNTERS_WRITE_INTERVAL_MS = 10_000;

function utcSecond(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The file's text: `started`, `updated`, then each count. */
export function formatRelayCounters(
  started: Date,
  updated: Date,
  counts: RelayCounts,
): string {
  return [
    `started=${utcSecond(started)}`,
    `updated=${utcSecond(updated)}`,
    ...RELAY_COUNTER_NAMES.map((name) => `${name}=${counts[name]}`),
    "",
  ].join("\n");
}

/** What {@link startRelayCountersFile} needs. */
export interface RelayCountersFileOptions {
  /** Where the file is written, replaced whole. */
  path: string;
  /** The relay's counts at the time of a write. */
  counts: () => RelayCounts;
  /** Where a write that failed is reported, once until one succeeds. */
  reportFailure: (message: string) => void;
  /** @internal */
  intervalMs?: number;
}

/** A counters file being kept. */
export interface RelayCountersFile {
  /** Stop writing it. */
  stop(): void;
}

/**
 * Write the relay's counters file now, then again each interval in which a
 * count changed. Each write replaces the file whole, through a file beside it
 * renamed over it, so a reader never sees half a file.
 */
export function startRelayCountersFile({
  path,
  counts,
  reportFailure,
  intervalMs = RELAY_COUNTERS_WRITE_INTERVAL_MS,
}: RelayCountersFileOptions): RelayCountersFile {
  const started = new Date();
  const partPath = join(dirname(path), `.${basename(path)}.part`);
  let written: string | undefined;
  let failing = false;

  function write(): void {
    const current = counts();
    const key = RELAY_COUNTER_NAMES.map((name) => current[name]).join(",");
    if (key === written) return;
    try {
      writeFileSync(
        partPath,
        formatRelayCounters(started, new Date(), current),
      );
      renameSync(partPath, path);
      written = key;
      failing = false;
    } catch (error) {
      if (failing) return;
      failing = true;
      reportFailure(
        `could not write the counters file ${path}: ` +
          `${error instanceof Error ? error.message : String(error)}; ` +
          "the relay tries again each interval",
      );
    }
  }

  write();
  const timer = setInterval(write, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
