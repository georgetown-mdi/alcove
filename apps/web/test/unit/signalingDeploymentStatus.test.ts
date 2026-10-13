import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  DEPLOYED_COMMIT_HEADER,
  LAST_PULL_OUTCOME_HEADER,
  LAST_PULL_TIME_HEADER,
  PULL_OUTCOMES,
  UNKNOWN,
  UNKNOWN_DEPLOYMENT_STATUS,
  createDeploymentStatusReader,
  deploymentStatusHeaders,
  readDeploymentStatus,
} from "@alcove/peerjs-broker/deploymentStatus";
import {
  READINESS_BODY,
  createStandaloneRequestHandler,
} from "@alcove/peerjs-broker/standaloneOptions";

import type {
  DeploymentStatusPaths,
  DeploymentStatusReader,
} from "@alcove/peerjs-broker/deploymentStatus";
import type { AddressInfo } from "node:net";

// What the standalone broker's readiness endpoint publishes about the host
// pull, read from fixture copies of the files infra/host-pull/pull.sh writes.

const DEPLOYED = "0123456789abcdef0123456789abcdef01234567";
const TIP = "fedcba9876543210fedcba9876543210fedcba98";

/** A status record in the shape pull.sh's `finish` writes. */
function statusRecord(outcome: string, time: string): string {
  return (
    `deployed_commit=${DEPLOYED}\n` +
    `linked_commit=${DEPLOYED}\n` +
    `main_commit=${TIP}\n` +
    `outcome=${outcome}\n` +
    `reason=installs failed at ${TIP}; see /opt/alcove-broker/trees/${TIP}\n` +
    `time=${time}\n`
  );
}

let directory: string;
let paths: DeploymentStatusPaths;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "broker-deployment-status-"));
  paths = {
    deployedMarkerPath: join(directory, "deployed"),
    pullStatusPath: join(directory, "status"),
  };
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("readDeploymentStatus", () => {
  test("reads the deployed commit and the last run's outcome and time", async () => {
    writeFileSync(paths.deployedMarkerPath, `${DEPLOYED}\n`);
    writeFileSync(
      paths.pullStatusPath,
      statusRecord("rolled-back", "2026-10-13T06:04:17Z"),
    );
    expect(await readDeploymentStatus(paths)).toEqual({
      deployedCommit: DEPLOYED,
      lastPullOutcome: "rolled-back",
      lastPullTime: "2026-10-13T06:04:17Z",
    });
  });

  test("reports every field unknown when neither file exists", async () => {
    expect(await readDeploymentStatus(paths)).toEqual(
      UNKNOWN_DEPLOYMENT_STATUS,
    );
  });

  test("reports each file's fields unknown independently", async () => {
    writeFileSync(paths.deployedMarkerPath, `${DEPLOYED}\n`);
    expect(await readDeploymentStatus(paths)).toEqual({
      deployedCommit: DEPLOYED,
      lastPullOutcome: UNKNOWN,
      lastPullTime: UNKNOWN,
    });
  });

  test.each([
    ["an abbreviated commit", "0123456\n"],
    ["an uppercase commit", `${DEPLOYED.toUpperCase()}\n`],
    ["a second line", `${DEPLOYED}\n${TIP}\n`],
    ["trailing space", `${DEPLOYED} \n`],
    ["an empty file", ""],
    ["text", "not a commit\n"],
  ])("reports a marker holding %s as unknown", async (_name, text) => {
    writeFileSync(paths.deployedMarkerPath, text);
    expect((await readDeploymentStatus(paths)).deployedCommit).toBe(UNKNOWN);
  });

  test("reads a marker with no trailing newline", async () => {
    writeFileSync(paths.deployedMarkerPath, DEPLOYED);
    expect((await readDeploymentStatus(paths)).deployedCommit).toBe(DEPLOYED);
  });

  test.each([
    [
      "an outcome pull.sh does not write",
      statusRecord("ok", "2026-10-13T06:04:17Z"),
    ],
    [
      "an outcome with trailing text",
      statusRecord("updated now", "2026-10-13T06:04:17Z"),
    ],
    ["an empty outcome", statusRecord("", "2026-10-13T06:04:17Z")],
    [
      "the outcome twice",
      `outcome=updated\n${statusRecord("updated", "2026-10-13T06:04:17Z")}`,
    ],
    ["no outcome line", "time=2026-10-13T06:04:17Z\n"],
  ])("reports a record with %s as an unknown outcome", async (_name, text) => {
    writeFileSync(paths.pullStatusPath, text);
    expect((await readDeploymentStatus(paths)).lastPullOutcome).toBe(UNKNOWN);
  });

  test.each([
    [
      "a time with an offset",
      statusRecord("updated", "2026-10-13T06:04:17+00:00"),
    ],
    ["a time that is no date", statusRecord("updated", "2026-13-45T06:04:17Z")],
    [
      "a time with trailing text",
      statusRecord("updated", "2026-10-13T06:04:17Z x"),
    ],
    [
      "the time twice",
      `time=2026-10-12T06:04:17Z\n${statusRecord("updated", "2026-10-13T06:04:17Z")}`,
    ],
    ["no time line", "outcome=updated\n"],
  ])("reports a record with %s as an unknown time", async (_name, text) => {
    writeFileSync(paths.pullStatusPath, text);
    expect((await readDeploymentStatus(paths)).lastPullTime).toBe(UNKNOWN);
  });

  test("reports a record past its read cap as unknown", async () => {
    writeFileSync(
      paths.pullStatusPath,
      `${statusRecord("updated", "2026-10-13T06:04:17Z")}reason=${"x".repeat(16 * 1024)}\n`,
    );
    expect(await readDeploymentStatus(paths)).toEqual(
      UNKNOWN_DEPLOYMENT_STATUS,
    );
  });

  test("reports a directory at either path as unknown", async () => {
    mkdirSync(paths.deployedMarkerPath);
    mkdirSync(paths.pullStatusPath);
    expect(await readDeploymentStatus(paths)).toEqual(
      UNKNOWN_DEPLOYMENT_STATUS,
    );
  });

  test.skipIf(process.platform === "win32")(
    "reports a FIFO at the path as unknown rather than waiting on a writer",
    async () => {
      expect(spawnSync("mkfifo", [paths.pullStatusPath]).status).toBe(0);
      expect((await readDeploymentStatus(paths)).lastPullOutcome).toBe(UNKNOWN);
    },
  );

  // A new outcome in pull.sh would otherwise be published as unknown and turn
  // the nightly deployment check red for a reason it cannot name.
  test("accepts exactly the outcomes pull.sh records", () => {
    const pullScript = readFileSync(
      new URL("../../../../infra/host-pull/pull.sh", import.meta.url),
      "utf8",
    );
    const recorded = new Set(
      [...pullScript.matchAll(/\bfinish ([a-z][a-z-]*) [01] /g)].map(
        (match) => match[1],
      ),
    );
    expect([...recorded].sort()).toEqual([...PULL_OUTCOMES].sort());
  });
});

describe("deploymentStatusHeaders", () => {
  test("publishes the three fields and nothing else from the record", async () => {
    writeFileSync(paths.deployedMarkerPath, `${DEPLOYED}\n`);
    writeFileSync(
      paths.pullStatusPath,
      statusRecord("failed", "2026-10-13T06:04:17Z"),
    );
    expect(deploymentStatusHeaders(await readDeploymentStatus(paths))).toEqual({
      [DEPLOYED_COMMIT_HEADER]: DEPLOYED,
      [LAST_PULL_OUTCOME_HEADER]: "failed",
      [LAST_PULL_TIME_HEADER]: "2026-10-13T06:04:17Z",
    });
  });
});

describe("createDeploymentStatusReader", () => {
  test("serves one read until it is older than the maximum age", async () => {
    let time = 1_000;
    const read = createDeploymentStatusReader(paths, 60_000, () => time);
    writeFileSync(paths.deployedMarkerPath, `${DEPLOYED}\n`);
    expect((await read()).deployedCommit).toBe(DEPLOYED);

    writeFileSync(paths.deployedMarkerPath, `${TIP}\n`);
    time += 59_999;
    expect((await read()).deployedCommit).toBe(DEPLOYED);

    time += 1;
    expect((await read()).deployedCommit).toBe(TIP);
  });

  test("hands concurrent requests the same read", () => {
    const read = createDeploymentStatusReader(paths, 60_000, () => 0);
    expect(read()).toBe(read());
  });
});

describe("the readiness probe's deployment headers", () => {
  const servers: Array<http.Server> = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function servedWith(read: DeploymentStatusReader): Promise<string> {
    const server = http.createServer(
      createStandaloneRequestHandler("/api/health", read),
    );
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  test("answers GET and HEAD with the fields beside the fixed body", async () => {
    writeFileSync(paths.deployedMarkerPath, `${DEPLOYED}\n`);
    writeFileSync(
      paths.pullStatusPath,
      statusRecord("updated", "2026-10-13T06:04:17Z"),
    );
    const base = await servedWith(createDeploymentStatusReader(paths));
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${base}/api/health`, { method });
      expect(response.status).toBe(200);
      expect(response.headers.get(DEPLOYED_COMMIT_HEADER)).toBe(DEPLOYED);
      expect(response.headers.get(LAST_PULL_OUTCOME_HEADER)).toBe("updated");
      expect(response.headers.get(LAST_PULL_TIME_HEADER)).toBe(
        "2026-10-13T06:04:17Z",
      );
      expect(await response.text()).toBe(
        method === "HEAD" ? "" : READINESS_BODY,
      );
    }
  });

  test("answers 200 with unknown fields when the files are absent", async () => {
    const base = await servedWith(createDeploymentStatusReader(paths));
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get(DEPLOYED_COMMIT_HEADER)).toBe(UNKNOWN);
    expect(response.headers.get(LAST_PULL_OUTCOME_HEADER)).toBe(UNKNOWN);
    expect(response.headers.get(LAST_PULL_TIME_HEADER)).toBe(UNKNOWN);
    expect(await response.text()).toBe(READINESS_BODY);
  });

  test("answers 200 with unknown fields when the reader rejects", async () => {
    const base = await servedWith(() => Promise.reject(new Error("unread")));
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get(DEPLOYED_COMMIT_HEADER)).toBe(UNKNOWN);
    expect(await response.text()).toBe(READINESS_BODY);
  });

  test("adds no deployment header to a refused request", async () => {
    const base = await servedWith(createDeploymentStatusReader(paths));
    const response = await fetch(`${base}/api/healthz`);
    expect(response.status).toBe(404);
    expect(response.headers.get(DEPLOYED_COMMIT_HEADER)).toBeNull();
  });
});
