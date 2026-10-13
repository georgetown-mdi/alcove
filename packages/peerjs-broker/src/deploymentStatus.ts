import { constants, open } from "node:fs/promises";

import type { FileHandle } from "node:fs/promises";

/**
 * What the readiness endpoint publishes about the host's deployment: the
 * commit the host pull last installed and the outcome and time of its last
 * run, read from the files `infra/host-pull/pull.sh` writes.
 *
 * Each value is checked against the shape that script writes and replaced by
 * {@link UNKNOWN} when its file is missing, unreadable, larger than its cap or
 * not in that shape, so the endpoint answers on any host and never repeats
 * file text it has not matched. Nothing else in the files is published.
 */

/** Environment variable naming the deployed-commit marker. */
export const DEPLOYED_MARKER_ENV = "ALCOVE_BROKER_DEPLOYED_MARKER";

/** Environment variable naming the pull's status record. */
export const PULL_STATUS_ENV = "ALCOVE_BROKER_PULL_STATUS";

/** Where `infra/host-pull/pull.sh` writes the deployed-commit marker. */
export const DEFAULT_DEPLOYED_MARKER_PATH =
  "/var/lib/alcove-host-pull/deployed";

/** Where `infra/host-pull/pull.sh` writes its status record. */
export const DEFAULT_PULL_STATUS_PATH = "/var/lib/alcove-host-pull/status";

/** The value published for a field that could not be read. */
export const UNKNOWN = "unknown";

/** Response header holding the deployed commit. */
export const DEPLOYED_COMMIT_HEADER = "alcove-deployed-commit";

/** Response header holding the last pull run's outcome. */
export const LAST_PULL_OUTCOME_HEADER = "alcove-last-pull-outcome";

/** Response header holding the last pull run's end time. */
export const LAST_PULL_TIME_HEADER = "alcove-last-pull-time";

/** Every outcome `pull.sh` records (infra/host-pull/README.md, Outcomes). */
export const PULL_OUTCOMES = [
  "unchanged",
  "skipped",
  "refused",
  "failed",
  "rolled-back",
  "rollback-failed",
  "updated",
] as const;

/** How long a read of the two files is served before the next request reads
 * them again, so the request rate does not set the file-read rate. */
export const DEPLOYMENT_STATUS_MAX_AGE_MS = 60_000;

/** Largest marker read; `pull.sh` writes a commit and a newline. */
const MARKER_MAX_BYTES = 1024;

/** Largest status record read; a larger one is published as unknown. */
const STATUS_MAX_BYTES = 16 * 1024;

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/** `date -u +%FT%TZ`, the format `pull.sh` writes its time in. */
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Where the two files are read from. */
export interface DeploymentStatusPaths {
  deployedMarkerPath: string;
  pullStatusPath: string;
}

/** The published values, each matched to its shape or {@link UNKNOWN}. */
export interface DeploymentStatus {
  deployedCommit: string;
  lastPullOutcome: string;
  lastPullTime: string;
}

/** Returns the current {@link DeploymentStatus}; never rejects. */
export type DeploymentStatusReader = () => Promise<DeploymentStatus>;

/** The status published when neither file was read. */
export const UNKNOWN_DEPLOYMENT_STATUS: DeploymentStatus = {
  deployedCommit: UNKNOWN,
  lastPullOutcome: UNKNOWN,
  lastPullTime: UNKNOWN,
};

/**
 * The file's text, or undefined when it is not a regular file, cannot be read,
 * or holds more than `maxBytes`. Opened non-blocking so a FIFO at the path
 * cannot hold the read open.
 */
async function readCappedFile(
  path: string,
  maxBytes: number,
): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        filled,
        buffer.length - filled,
        filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > maxBytes) return undefined;
    return buffer.toString("utf8", 0, filled);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The deployed commit from the marker's text. */
export function parseDeployedMarker(text: string | undefined): string {
  if (text === undefined) return UNKNOWN;
  const commit = text.endsWith("\n") ? text.slice(0, -1) : text;
  return COMMIT_PATTERN.test(commit) ? commit : UNKNOWN;
}

/** The value of each `key=value` line naming `key`, in order. */
function valuesOf(lines: ReadonlyArray<string>, key: string): Array<string> {
  const prefix = `${key}=`;
  return lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

/** The one value of `key` when it matches `accept`, and unknown otherwise,
 * including when the record names the key more than once. */
function singleValue(
  lines: ReadonlyArray<string>,
  key: string,
  accept: (value: string) => boolean,
): string {
  const values = valuesOf(lines, key);
  return values.length === 1 && accept(values[0]) ? values[0] : UNKNOWN;
}

function isPullOutcome(value: string): boolean {
  return (PULL_OUTCOMES as ReadonlyArray<string>).includes(value);
}

function isPullTime(value: string): boolean {
  return TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/** The last run's outcome and time from the status record's text. */
export function parsePullStatus(
  text: string | undefined,
): Pick<DeploymentStatus, "lastPullOutcome" | "lastPullTime"> {
  if (text === undefined)
    return { lastPullOutcome: UNKNOWN, lastPullTime: UNKNOWN };
  const lines = text.split("\n");
  return {
    lastPullOutcome: singleValue(lines, "outcome", isPullOutcome),
    lastPullTime: singleValue(lines, "time", isPullTime),
  };
}

/** Read both files once. Never rejects: a failure is an unknown field. */
export async function readDeploymentStatus(
  paths: DeploymentStatusPaths,
): Promise<DeploymentStatus> {
  const [marker, status] = await Promise.all([
    readCappedFile(paths.deployedMarkerPath, MARKER_MAX_BYTES),
    readCappedFile(paths.pullStatusPath, STATUS_MAX_BYTES),
  ]);
  return {
    deployedCommit: parseDeployedMarker(marker),
    ...parsePullStatus(status),
  };
}

/**
 * A reader that reads both files at most once per `maxAgeMs` and serves that
 * read to every request in between, including requests that arrive while it
 * is in progress.
 */
export function createDeploymentStatusReader(
  paths: DeploymentStatusPaths,
  maxAgeMs: number = DEPLOYMENT_STATUS_MAX_AGE_MS,
  now: () => number = Date.now,
): DeploymentStatusReader {
  let cached: { readAt: number; status: Promise<DeploymentStatus> } | undefined;
  return () => {
    const time = now();
    if (cached === undefined || time - cached.readAt >= maxAgeMs) {
      cached = {
        readAt: time,
        status: readDeploymentStatus(paths).catch(
          () => UNKNOWN_DEPLOYMENT_STATUS,
        ),
      };
    }
    return cached.status;
  };
}

/** The status as the readiness endpoint's response headers. */
export function deploymentStatusHeaders(
  status: DeploymentStatus,
): Record<string, string> {
  return {
    [DEPLOYED_COMMIT_HEADER]: status.deployedCommit,
    [LAST_PULL_OUTCOME_HEADER]: status.lastPullOutcome,
    [LAST_PULL_TIME_HEADER]: status.lastPullTime,
  };
}
