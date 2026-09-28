import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Driven against a stub engine on PATH. A stub container named
// `<label>-exit<status>-after<seconds>` exits with that status after that many
// seconds unless `docker kill` reaches it first, when it exits 137.

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "wait-container-pair.mjs",
);

const STUB_ENGINE = `#!/bin/sh
set -eu
case "$1" in
  wait)
    id="$2"
    status="\${id##*-exit}"; status="\${status%%-*}"
    after="\${id##*-after}"
    ticks=0
    while [ ! -e "$STUB_DIR/$id.killed" ]; do
      if [ "$ticks" -ge "$((after * 10))" ]; then echo "$status"; exit 0; fi
      sleep 0.1
      ticks=$((ticks + 1))
    done
    echo 137 ;;
  kill)
    echo "$2" >> "$STUB_DIR/kills"
    touch "$STUB_DIR/$2.killed" ;;
  *)
    echo "no stub answer for: $*" >&2; exit 99 ;;
esac
`;

let stubDirectory;

beforeEach(() => {
  stubDirectory = mkdtempSync(join(tmpdir(), "alcove-wait-pair-"));
  const engine = join(stubDirectory, "docker");
  writeFileSync(engine, STUB_ENGINE);
  chmodSync(engine, 0o755);
});

afterEach(() => {
  rmSync(stubDirectory, { recursive: true, force: true });
});

function runPair(timeoutSeconds, inviter, acceptor) {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      String(timeoutSeconds),
      `inviter=${inviter}`,
      `acceptor=${acceptor}`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${stubDirectory}:${process.env.PATH}`,
        STUB_DIR: stubDirectory,
      },
      timeout: 60_000,
    },
  );
  const killsFile = join(stubDirectory, "kills");
  return {
    status: result.status,
    stderr: result.stderr,
    seconds: (Date.now() - started) / 1000,
    kills: existsSync(killsFile)
      ? readFileSync(killsFile, "utf8").trim().split("\n")
      : [],
  };
}

describe("wait-container-pair", () => {
  it("succeeds after both halves exit 0, stopping neither", () => {
    const run = runPair(30, "i-exit0-after1", "a-exit0-after2");
    expect(run.status).toBe(0);
    expect(run.seconds).toBeGreaterThanOrEqual(2);
    expect(run.kills).toEqual([]);
    expect(run.stderr).toContain("inviter: exited, status 0");
    expect(run.stderr).toContain("acceptor: exited, status 0");
  });

  it("stops the acceptor as soon as the inviter fails", () => {
    const run = runPair(30, "i-exit3-after1", "a-exit0-after40");
    expect(run.status).toBe(1);
    expect(run.seconds).toBeLessThan(10);
    expect(run.kills).toEqual(["a-exit0-after40"]);
    expect(run.stderr).toContain("inviter: exited, status 3");
    expect(run.stderr).toContain(
      "acceptor: stopped because inviter failed, status 137",
    );
  });

  it("stops the inviter as soon as the acceptor fails", () => {
    const run = runPair(30, "i-exit0-after40", "a-exit1-after1");
    expect(run.status).toBe(1);
    expect(run.seconds).toBeLessThan(10);
    expect(run.kills).toEqual(["i-exit0-after40"]);
    expect(run.stderr).toContain("acceptor: exited, status 1");
    expect(run.stderr).toContain(
      "inviter: stopped because acceptor failed, status 137",
    );
  });

  it("fails without stopping anything when the later half fails", () => {
    const run = runPair(30, "i-exit0-after1", "a-exit2-after2");
    expect(run.status).toBe(1);
    expect(run.kills).toEqual([]);
    expect(run.stderr).toContain("acceptor: exited, status 2");
  });

  it("stops both halves when the timeout passes", () => {
    const run = runPair(1, "i-exit0-after40", "a-exit0-after40");
    expect(run.status).toBe(1);
    expect(run.seconds).toBeLessThan(10);
    expect(run.kills.sort()).toEqual(["a-exit0-after40", "i-exit0-after40"]);
    expect(run.stderr).toContain("inviter: stopped after the 1s timeout");
  });

  it("refuses a malformed argument list", () => {
    const run = runPair(30, "i-exit0-after1", "");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("usage:");
  });
});
