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
// seconds unless `docker kill` reaches it first, when it exits 137. A name
// containing `-waitfail` makes `docker wait` itself fail (exit 1, no output).
// A name containing `-neverdies` makes the container ignore `docker kill` and
// run for a bounded 60s, standing in for a half that never reports an exit.
// A `-lead` half exits once its `-follow` half runs; the follower waits for the
// lead pid to go away, so the case orders the exits without timing.
// A bounded wait that runs out reports status 98 or 99.

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
    case "$id" in
      *-lead*)
        echo $$ > "$STUB_DIR/lead.pid"
        n=0
        while [ ! -e "$STUB_DIR/follow.ready" ]; do
          if [ "$n" -ge 300 ]; then echo 98; exit 0; fi
          sleep 0.01; n=$((n + 1))
        done
        echo "$status"
        exit 0 ;;
      *-follow*)
        n=0
        while [ ! -s "$STUB_DIR/lead.pid" ]; do
          if [ "$n" -ge 300 ]; then echo 98; exit 0; fi
          sleep 0.01; n=$((n + 1))
        done
        lead=$(cat "$STUB_DIR/lead.pid")
        touch "$STUB_DIR/follow.ready"
        n=0
        while kill -0 "$lead" 2>/dev/null; do
          if [ "$n" -ge 1000000 ]; then echo 99; exit 0; fi
          n=$((n + 1))
        done
        echo "$status"
        exit 0 ;;
      *-neverdies*)
        n=0
        while [ "$n" -lt 300 ]; do sleep 0.2; n=$((n + 1)); done
        echo 137
        exit 0 ;;
      *-waitfail*) exit 1 ;;
    esac
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

function runPair(timeoutSeconds, inviter, acceptor, extraEnv = {}) {
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
        ...extraEnv,
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

  it("stops the acceptor once the settle window passes after the inviter fails", () => {
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

  it("fails and stops the other half when docker wait itself fails", () => {
    const run = runPair(30, "i-waitfail", "a-exit0-after40");
    expect(run.status).toBe(1);
    expect(run.kills).toEqual(["a-exit0-after40"]);
    expect(run.stderr).toContain("inviter: exited, status wait-failed");
    expect(run.stderr).toContain(
      "acceptor: stopped because inviter failed, status 137",
    );
  });

  it("does not kill a half that exits just after its failing partner", () => {
    const run = runPair(30, "i-exit1-lead", "a-exit0-follow");
    expect(run.status).toBe(1);
    expect(run.kills).toEqual([]);
    expect(run.stderr).toContain("inviter: exited, status 1");
    expect(run.stderr).toContain("acceptor: exited, status 0");
  });

  it("waits for both stopped halves concurrently, not sequentially", () => {
    // Both halves ignore `docker kill` and only resolve through the
    // STOPPED_HALF_GRACE_MS fallback, shortened to 2s via the env override
    // (the stub's neverdies loop runs up to 60s, well past that). Sequential
    // grace waits would take close to 4s; concurrent waits take close to
    // 2-3s -- the total wall time is the only thing this stub can use to
    // tell them apart.
    const run = runPair(1, "i-neverdies", "a-neverdies", {
      WAIT_CONTAINER_PAIR_GRACE_MS: "2000",
    });
    expect(run.status).toBe(1);
    expect(run.seconds).toBeLessThan(3.5);
    expect(run.kills.sort()).toEqual(["a-neverdies", "i-neverdies"]);
    expect(run.stderr).toContain(
      "inviter: stopped after the 1s timeout, status still-running",
    );
    expect(run.stderr).toContain(
      "acceptor: stopped after the 1s timeout, status still-running",
    );
  });
});
