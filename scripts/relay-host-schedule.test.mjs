import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Holds the relay host's daily jobs to infra/relay/README.md, The daily
// schedule: every daily timer under infra/relay, infra/broker and
// infra/host-pull starts inside 08:00-11:00 UTC, no two overlap given their
// maximums, the verification runs last, each job's unit takes the maintenance
// lock in its own ExecStart, and the README's table is what the units say.

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(repo, path), "utf8");

const COMPONENTS = ["infra/relay", "infra/broker", "infra/host-pull"];
const WINDOW = [8 * 60, 11 * 60];
const VERIFY_TIMER = "alcove-relay-verify.timer";
const RENEWAL_TIMERS = ["alcove-relay-cert.timer", "alcove-broker-cert.timer"];
const LOCK_DIR = "/run/alcove-maintenance";
const LOCK = `${LOCK_DIR}/lock`;
const TMPFILES = "infra/tmpfiles.d/alcove-maintenance.conf";
const KILL_AFTER = 30;
// /usr/bin/flock -o -w <wait> <lock> /usr/bin/timeout -k 30 <maximum - 30> <command>
const LOCKED_EXEC_START =
  /^\/usr\/bin\/flock -o -w ([1-9]\d*) (\S+) \/usr\/bin\/timeout -k (\d+) ([1-9]\d*) (\/\S+(?: \S+)*)$/;

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

const dailyJobs = COMPONENTS.flatMap(timerFiles)
  .filter((path) => ONCE_A_DAY.test(setting(read(path), "OnCalendar")))
  .map((path) => {
    const timer = read(path);
    const service = read(path.replace(/\.timer$/, ".service"));
    const fixed = setting(timer, "OnCalendar").match(FIXED_UTC);
    const start = fixed ? Number(fixed[1]) * 60 + Number(fixed[2]) : null;
    const delay = minutes(setting(timer, "RandomizedDelaySec"));
    const execStart = setting(service, "ExecStart");
    const locked = execStart.match(LOCKED_EXEC_START);
    const maximum = locked
      ? (Number(locked[4]) + Number(locked[3])) / 60
      : Number.NaN;
    return {
      name: basename(path),
      timer,
      service,
      start,
      delay,
      execStart,
      locked,
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
    "%s's ExecStart takes the shared lock with flock, with a wait, then runs its command under timeout",
    (_, job) => {
      expect(job.locked, job.execStart).not.toBeNull();
      const [, wait, lock, killAfter, beforeKill] = job.locked;
      expect(lock).toBe(LOCK);
      expect(Number(wait)).toBeGreaterThan(0);
      expect(Number(killAfter)).toBe(KILL_AFTER);
      // TERM 30 seconds before a whole-minute maximum, KILL at it.
      expect((Number(beforeKill) + KILL_AFTER) % 60).toBe(0);
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

  it("wait the same time for the lock, longer than any job holds it", () => {
    const waits = new Set(dailyJobs.map((job) => Number(job.locked?.[1])));
    expect([...waits]).toEqual([2 * 3600]);
    for (const job of dailyJobs) {
      expect(2 * 3600, job.name).toBeGreaterThan(job.maximum * 60);
    }
  });
});

describe("the maintenance lock's directory", () => {
  const SOURCE = '"$HERE/../tmpfiles.d/alcove-maintenance.conf"';
  const INSTALLED = "/etc/tmpfiles.d/alcove-maintenance.conf";

  it("is made by one tmpfiles line: mode 0700, owned by root", () => {
    const entries = read(TMPFILES)
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(entries).toEqual([`d ${LOCK_DIR} 0700 root root -`]);
  });

  it.each(dailyJobs.map((job) => [job.name, job]))(
    "%s's unit takes a lock file directly inside it",
    (_, job) => {
      const lock = job.locked?.[2] ?? "";
      expect(dirname(lock)).toBe(LOCK_DIR);
    },
  );

  it.each([
    [
      "infra/relay/install.sh",
      [
        `install -m 644 ${SOURCE} ${INSTALLED}`,
        `systemd-tmpfiles --create ${INSTALLED} \\`,
      ],
    ],
    [
      "infra/broker/install.sh",
      [
        `TMPFILES="$ROOT${INSTALLED}"`,
        `install -m 644 ${SOURCE} "$TMPFILES"`,
        'systemd-tmpfiles --create "$TMPFILES" \\',
      ],
    ],
    [
      "infra/host-pull/install.sh",
      [
        `TMPFILES="$ROOT${INSTALLED}"`,
        `install -m 644 ${SOURCE} "$TMPFILES"`,
        'systemd-tmpfiles --create "$TMPFILES" \\',
      ],
    ],
  ])(
    "%s installs the tmpfiles file and creates the directory",
    (script, lines) => {
      const present = read(script).split("\n");
      for (const line of lines) expect(present, line).toContain(line);
    },
  );
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

  it("states the units' lock path, wait and ExecStart shape", () => {
    const prose = readme.replace(/\s+/g, " ");
    expect(prose).toContain(`takes \`${LOCK}\` in its own \`ExecStart\``);
    expect(prose).toContain("A job waits up to two hours for the lock.");
    expect(readme).toContain(
      `    /usr/bin/flock -o -w 7200 ${LOCK} /usr/bin/timeout -k ${KILL_AFTER} <maximum - ${KILL_AFTER}> <command>`,
    );
    expect(readme).toContain(`\`flock ${LOCK} <command>\``);
  });
});
