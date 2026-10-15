import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Holds the relay host's daily jobs to infra/relay/README.md, The daily
// schedule: every daily timer under infra/relay, infra/broker and
// infra/host-pull starts inside 08:00-11:00 UTC, no two overlap given their
// maximums, the verification runs last, each job's unit runs its command
// under maintenance-lock.sh, and the README's table is what the units say.
// Then drives maintenance-lock.sh against a held lock.

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(repo, path), "utf8");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const LOCK_SCRIPT = join(repo, "infra/relay/maintenance-lock.sh");

const WINDOW = [8 * 60, 11 * 60];
const VERIFY_TIMER = "alcove-relay-verify.timer";
const RENEWAL_TIMERS = ["alcove-relay-cert.timer", "alcove-broker-cert.timer"];
// Where each component's install script puts its copy of maintenance-lock.sh.
const LOCK_COPIES = {
  "infra/relay": "/opt/alcove-relay/maintenance-lock.sh",
  "infra/broker": "/etc/alcove-broker/maintenance-lock.sh",
  "infra/host-pull": "/opt/alcove-host-pull/maintenance-lock.sh",
};

const settings = (text, name) =>
  [...text.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].map((m) =>
    m[1].trim(),
  );
const setting = (text, name) => {
  const values = settings(text, name);
  expect(values, name).toHaveLength(1);
  return values[0];
};

const timerFiles = (dir) =>
  readdirSync(join(repo, dir), { recursive: true })
    .filter((entry) => entry.endsWith(".timer"))
    .map((entry) => join(dir, entry));

// A timer that fires once a day: `daily`, or one fixed time on every day.
const ONCE_A_DAY = /^(daily|\*-\*-\* \d{1,2}:\d{1,2}(:\d{1,2})?( \S+)?)$/;
const FIXED_UTC = /^\*-\*-\* (\d\d):(\d\d):00 UTC$/;

const minutes = (span) => {
  if (span === "0") return 0;
  const match = span.match(/^(\d+)m$/);
  expect(match, `${span} is 0 or a whole number of minutes`).not.toBeNull();
  return Number(match[1]);
};

const dailyJobs = Object.keys(LOCK_COPIES)
  .flatMap(timerFiles)
  .filter((path) => ONCE_A_DAY.test(setting(read(path), "OnCalendar")))
  .map((path) => {
    const timer = read(path);
    const servicePath = path.replace(/\.timer$/, ".service");
    const service = read(servicePath);
    const fixed = setting(timer, "OnCalendar").match(FIXED_UTC);
    const start = fixed ? Number(fixed[1]) * 60 + Number(fixed[2]) : null;
    const delay = minutes(setting(timer, "RandomizedDelaySec"));
    const execStart = setting(service, "ExecStart").split(/\s+/);
    const maximum = Number(execStart[1]) / 60;
    const component = Object.keys(LOCK_COPIES).find((dir) =>
      path.startsWith(`${dir}/`),
    );
    return {
      name: basename(path),
      path,
      timer,
      service,
      component,
      start,
      delay,
      execStart,
      maximum,
      slot: [start, start + delay + maximum],
    };
  });

describe("the relay host's daily timers", () => {
  it("are the five jobs the README lists", () => {
    expect(dailyJobs.map((job) => job.name).sort()).toEqual(
      [
        "alcove-broker-cert.timer",
        "alcove-host-pull.timer",
        "alcove-relay-cert.timer",
        "alcove-relay-os-update.timer",
        "alcove-relay-verify.timer",
      ].sort(),
    );
  });

  it.each(dailyJobs.map((job) => [job.name, job]))(
    "%s fires at a fixed UTC time inside 08:00-11:00",
    (_, job) => {
      expect(setting(job.timer, "OnCalendar")).toMatch(FIXED_UTC);
      expect(job.slot[0]).toBeGreaterThanOrEqual(WINDOW[0]);
      expect(job.slot[1]).toBeLessThanOrEqual(WINDOW[1]);
    },
  );

  it.each(dailyJobs.map((job) => [job.name, job]))(
    "%s randomizes its start only where it renews a certificate",
    (_, job) => {
      if (RENEWAL_TIMERS.includes(job.name)) {
        expect(job.delay).toBeGreaterThan(0);
        expect(job.delay).toBeLessThanOrEqual(5);
      } else {
        expect(job.delay).toBe(0);
      }
    },
  );

  it("do not overlap, given each job's maximum", () => {
    const slots = dailyJobs
      .map((job) => ({ name: job.name, slot: job.slot }))
      .sort((a, b) => a.slot[0] - b.slot[0]);
    for (let i = 1; i < slots.length; i++) {
      expect(
        slots[i].slot[0],
        `${slots[i].name} starts before ${slots[i - 1].name} has ended`,
      ).toBeGreaterThanOrEqual(slots[i - 1].slot[1]);
    }
  });

  it("run the verification last, and the OS update before the pull", () => {
    const byName = Object.fromEntries(dailyJobs.map((job) => [job.name, job]));
    for (const job of dailyJobs) {
      if (job.name === VERIFY_TIMER) continue;
      expect(byName[VERIFY_TIMER].slot[0], job.name).toBeGreaterThanOrEqual(
        job.slot[1],
      );
    }
    expect(byName["alcove-host-pull.timer"].slot[0]).toBeGreaterThanOrEqual(
      byName["alcove-relay-os-update.timer"].slot[1],
    );
  });
});

describe("the relay host's daily units", () => {
  it.each(dailyJobs.map((job) => [job.name, job]))(
    "%s's service runs its one command under the maintenance lock, with a maximum",
    (_, job) => {
      expect(job.execStart[0]).toBe(LOCK_COPIES[job.component]);
      expect(job.execStart[1]).toMatch(/^[1-9]\d*$/);
      expect(Number(job.execStart[1]) % 60).toBe(0);
      expect(job.execStart.length).toBeGreaterThan(2);
      // An ExecStartPre= or ExecStartPost= would run outside the lock.
      expect([...job.service.matchAll(/^Exec\w*=/gm)].map((m) => m[0])).toEqual(
        ["ExecStart="],
      );
    },
  );

  it.each(dailyJobs.map((job) => [job.name, job]))(
    "%s's service sets no start timeout that would cut the wait for the lock short",
    (_, job) => {
      expect(settings(job.service, "TimeoutStartSec")).toEqual(["infinity"]);
    },
  );

  // The source each install script copies to the path in LOCK_COPIES.
  it.each([
    ["infra/relay", '"$HERE/maintenance-lock.sh"'],
    [
      "infra/broker",
      'put_file "$HERE/../relay/maintenance-lock.sh" "$ETC/maintenance-lock.sh"',
    ],
    ["infra/host-pull", '"$HERE/../relay/maintenance-lock.sh"'],
  ])("%s/install.sh installs maintenance-lock.sh", (component, line) => {
    expect(read(`${component}/install.sh`)).toContain(line);
  });
});

describe("infra/relay/README.md, The daily schedule", () => {
  const readme = read("infra/relay/README.md");
  const rows = [
    ...readme.matchAll(
      /^\| [^|]+ \| `([\w.-]+\.timer)` \| (\d\d):(\d\d)(?:, plus up to (\d+) min)? \| (\d+) min \| (\d\d):(\d\d) to (\d\d):(\d\d) \| [^|]+ \|$/gm,
    ),
  ].map((m) => ({
    name: m[1],
    start: Number(m[2]) * 60 + Number(m[3]),
    delay: Number(m[4] ?? 0),
    maximum: Number(m[5]),
    busy: [Number(m[6]) * 60 + Number(m[7]), Number(m[8]) * 60 + Number(m[9])],
  }));

  it("lists every daily job as its timer and unit have it", () => {
    expect(rows.map((row) => row.name).sort()).toEqual(
      dailyJobs.map((job) => job.name).sort(),
    );
    for (const job of dailyJobs) {
      const row = rows.find((entry) => entry.name === job.name);
      expect(row, job.name).toEqual({
        name: job.name,
        start: job.start,
        delay: job.delay,
        maximum: job.maximum,
        busy: job.slot,
      });
    }
  });

  it("states the lock path and the wait maintenance-lock.sh uses", () => {
    const script = readFileSync(LOCK_SCRIPT, "utf8");
    const lock = script.match(
      /^LOCK="\$\{ALCOVE_MAINTENANCE_LOCK:-([^}]+)\}"$/m,
    );
    expect(lock).not.toBeNull();
    expect(readme).toContain(`takes \`${lock[1]}\``);
    const wait = script.match(/^WAIT_DEFAULT=(\d+)$/m);
    expect(Number(wait?.[1])).toBe(2 * 3600);
    expect(readme).toContain("A job waits up to two hours for the lock.");
    // Longer than the longest job holds the lock, so a job never skips a day
    // for another job that ran long.
    for (const job of dailyJobs) {
      expect(Number(wait[1]), job.name).toBeGreaterThan(job.maximum * 60);
    }
  });
});

const describeOnScriptHost = describe.skipIf(process.platform !== "linux");

describeOnScriptHost("maintenance-lock.sh", { timeout: 30_000 }, () => {
  const created = [];
  const holders = [];
  afterEach(() => {
    while (holders.length > 0) holders.pop().kill("SIGKILL");
    while (created.length > 0) {
      rmSync(created.pop(), { recursive: true, force: true });
    }
  });
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), "maintenance-lock-"));
    created.push(dir);
    return { dir, lock: join(dir, "maintenance.lock") };
  };
  const run = (lock, args, extra = {}) => {
    const started = Date.now();
    const result = spawnSync(BASH, [LOCK_SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, ALCOVE_MAINTENANCE_LOCK: lock, ...extra },
    });
    return { ...result, elapsed: Date.now() - started };
  };
  // Holds the lock in one process until the test ends, as a hand-off does.
  const hold = async (lock) => {
    const holder = spawn(
      BASH,
      ["-c", 'exec 9>> "$1"; flock 9; echo held; exec sleep 60', "_", lock],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    holders.push(holder);
    await new Promise((done, fail) => {
      holder.stdout.on("data", (chunk) => {
        if (String(chunk).includes("held")) done();
      });
      holder.on("exit", () => fail(new Error("the holder exited")));
    });
  };

  it("exits 0 with its log line, without running the job, once the held lock outlasts its wait", async () => {
    const { dir, lock } = fixture();
    await hold(lock);
    const marker = join(dir, "ran");
    const result = run(lock, ["60", "/usr/bin/touch", marker], {
      ALCOVE_MAINTENANCE_LOCK_WAIT: "1",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      `touch did not run: ${lock} was held for 1 seconds, by a host hand-off or another daily job. The next scheduled run goes ahead.`,
    );
    expect(result.elapsed).toBeGreaterThanOrEqual(1000);
    expect(existsSync(marker)).toBe(false);
  });

  it("runs the job holding the lock, and exits with the job's status", () => {
    const { lock } = fixture();
    const result = run(lock, [
      "60",
      BASH,
      "-c",
      'flock -n "$0" true && echo free || echo held; exit 3',
      lock,
    ]);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stdout.trim()).toBe("held");
    expect(spawnSync("flock", ["-n", lock, "true"]).status).toBe(0);
  });

  it("stops the job at its maximum and says so", () => {
    const { lock } = fixture();
    const result = run(lock, ["2", "sleep", "30"], {
      ALCOVE_MAINTENANCE_KILL_AFTER: "1",
    });
    expect(result.status).toBe(124);
    expect(result.stderr).toContain(
      "sleep was stopped at its maximum run time of 2 seconds",
    );
    expect(result.elapsed).toBeLessThan(10_000);
  });

  it("refuses a maximum no longer than the wait before KILL", () => {
    const { lock } = fixture();
    const result = run(lock, ["30", "true"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: maintenance-lock.sh");
  });
});
