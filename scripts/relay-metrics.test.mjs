import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The relay's counts publisher (infra/relay/README.md, Monitoring), driven
// against a fixture host: a counters file in the registrar's format, a
// relay.env, and `aws` as a stub on PATH that records its arguments. What
// CloudWatch does with the call, and whether the instance role admits it, is
// the host run's to measure. The timer's schedule is held to the other
// timers on the host, read from their unit files.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const PUBLISH = resolve(repoRoot, "infra/relay/aws/publish-metrics.sh");

const COUNTS = [
  "tokenless_enrollments",
  "rate_limit_refusals",
  "client_cap_refusals",
  "tokenless_ceiling_refusals",
];

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

const counters = (started, values) =>
  [
    `started=${started}`,
    "updated=2026-10-15T12:34:50Z",
    ...COUNTS.map((name) => `${name}=${values[name] ?? 0}`),
    "",
  ].join("\n");

const fixtureHost = ({ region = "us-west-2" } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "relay-metrics-"));
  tmpDirs.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "aws-calls.log");
  const failFlag = join(root, "aws-fails");
  writeFileSync(
    join(bin, "aws"),
    [
      "#!/bin/bash",
      `printf '%s\\n' "$*" >> '${calls}'`,
      `if [ -f '${failFlag}' ]; then echo 'AccessDenied' >&2; exit 254; fi`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "aws"), 0o755);
  const envFile = join(root, "relay.env");
  writeFileSync(
    envFile,
    `ALCOVE_RELAY_REALM=relay.example.org\nALCOVE_RELAY_METRICS_REGION=${region}\n`,
  );
  const countersFile = join(root, "registrar-counters");
  const stateFile = join(root, "state", "published");
  return {
    stateFile,
    write: (text) => writeFileSync(countersFile, text),
    awsFails: (fails) =>
      fails ? writeFileSync(failFlag, "") : rmSync(failFlag, { force: true }),
    run: () => {
      rmSync(calls, { force: true });
      const result = spawnSync(BASH, [PUBLISH], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ALCOVE_RELAY_ENV_FILE: envFile,
          ALCOVE_RELAY_COUNTERS_FILE: countersFile,
          ALCOVE_RELAY_METRICS_STATE_FILE: stateFile,
        },
      });
      const awsCalls = existsSync(calls)
        ? readFileSync(calls, "utf8").trim().split("\n")
        : [];
      return { status: result.status, stderr: result.stderr, awsCalls };
    },
  };
};

const START = "2026-10-15T12:00:00Z";

describe("publish-metrics.sh", () => {
  it("publishes nothing and succeeds where the registrar wrote no counts", () => {
    const host = fixtureHost();
    const run = host.run();
    expect(run.status).toBe(0);
    expect(run.awsCalls).toEqual([]);
    expect(run.stderr).toContain("nothing to publish");
  });

  it("records the first counts it reads and publishes none of them", () => {
    const host = fixtureHost();
    host.write(counters(START, { tokenless_enrollments: 500 }));
    const run = host.run();
    expect(run.status).toBe(0);
    expect(run.awsCalls).toEqual([]);
    expect(readFileSync(host.stateFile, "utf8")).toContain(
      "tokenless_enrollments=500",
    );
  });

  it("publishes each count's rise since the last publish, and only the counts that rose", () => {
    const host = fixtureHost();
    host.write(counters(START, { tokenless_enrollments: 5 }));
    host.run();
    host.write(
      counters(START, { tokenless_enrollments: 12, rate_limit_refusals: 3 }),
    );
    const run = host.run();
    expect(run.status, run.stderr).toBe(0);
    expect(run.awsCalls).toEqual([
      "cloudwatch put-metric-data --region us-west-2 --namespace Alcove/Relay --metric-data " +
        "MetricName=tokenless_enrollments,Value=7,Unit=Count " +
        "MetricName=rate_limit_refusals,Value=3,Unit=Count",
    ]);
    expect(run.stderr).toContain(
      "published tokenless_enrollments=7 rate_limit_refusals=3",
    );
  });

  it("starts no aws process on a run where no count rose", () => {
    const host = fixtureHost();
    host.write(counters(START, { tokenless_enrollments: 5 }));
    host.run();
    host.write(counters(START, { tokenless_enrollments: 9 }));
    host.run();
    const run = host.run();
    expect(run.status).toBe(0);
    expect(run.awsCalls).toEqual([]);
    expect(run.stderr).toBe("");
  });

  it("counts from 0 after the registrar restarted", () => {
    const host = fixtureHost();
    host.write(counters(START, { tokenless_enrollments: 40 }));
    host.run();
    host.write(
      counters("2026-10-15T13:00:00Z", {
        tokenless_enrollments: 2,
        tokenless_ceiling_refusals: 1,
      }),
    );
    const run = host.run();
    expect(run.status, run.stderr).toBe(0);
    expect(run.awsCalls).toHaveLength(1);
    expect(run.awsCalls[0]).toContain(
      "MetricName=tokenless_enrollments,Value=2,Unit=Count",
    );
    expect(run.awsCalls[0]).toContain(
      "MetricName=tokenless_ceiling_refusals,Value=1,Unit=Count",
    );
  });

  it("records a restart with no counts yet, so the next rise is measured from it", () => {
    const host = fixtureHost();
    host.write(counters(START, { tokenless_enrollments: 40 }));
    host.run();
    const restarted = "2026-10-15T13:00:00Z";
    host.write(counters(restarted, {}));
    expect(host.run().awsCalls).toEqual([]);
    host.write(counters(restarted, { tokenless_enrollments: 3 }));
    const run = host.run();
    expect(run.awsCalls).toHaveLength(1);
    expect(run.awsCalls[0]).toContain(
      "MetricName=tokenless_enrollments,Value=3,Unit=Count",
    );
  });

  it("publishes the same rise again after a failed publish", () => {
    const host = fixtureHost();
    host.write(counters(START, {}));
    host.run();
    host.write(counters(START, { client_cap_refusals: 4 }));
    host.awsFails(true);
    const failed = host.run();
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("the next run publishes it again");
    host.awsFails(false);
    const retried = host.run();
    expect(retried.status).toBe(0);
    expect(retried.awsCalls).toHaveLength(1);
    expect(retried.awsCalls[0]).toContain(
      "MetricName=client_cap_refusals,Value=4,Unit=Count",
    );
  });

  it.each([
    ["a count that is not a number", (text) => text.replace("=0\n", "=x\n")],
    [
      "a missing count",
      (text) => text.replace(/^client_cap_refusals=.*\n/m, ""),
    ],
    ["a repeated count", (text) => `${text}tokenless_enrollments=1\n`],
    ["a malformed start", (text) => text.replace(START, "yesterday")],
  ])("refuses %s, naming the file and publishing nothing", (_, spoil) => {
    const host = fixtureHost();
    host.write(counters(START, {}));
    host.run();
    host.write(spoil(counters(START, { tokenless_enrollments: 3 })));
    const run = host.run();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("registrar-counters has");
    expect(run.awsCalls).toEqual([]);
  });

  it("refuses to run without a region, naming the setting", () => {
    const host = fixtureHost({ region: "" });
    host.write(counters(START, {}));
    const run = host.run();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("ALCOVE_RELAY_METRICS_REGION is unset");
  });

  it("publishes the counts the registrar writes and the README names", () => {
    const readme = read("infra/relay/README.md");
    for (const name of COUNTS) {
      expect(read("infra/relay/aws/publish-metrics.sh")).toContain(name);
      expect(readme).toContain(`\`${name}\``);
    }
  });
});

describe("the instance role's permission", () => {
  it("names the namespace the publisher writes", () => {
    const namespace = read("infra/relay/aws/publish-metrics.sh").match(
      /^NAMESPACE=(.+)$/m,
    )[1];
    const provision = read("infra/relay/aws/provision.md");
    expect(provision).toContain(`"cloudwatch:namespace": "${namespace}"`);
    expect(provision).toContain('"Action": "cloudwatch:PutMetricData"');
  });
});

// --- the schedule ------------------------------------------------------------

const setting = (text, name) => {
  const matches = [...text.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))];
  expect(matches, name).toHaveLength(1);
  return matches[0][1].trim();
};

const minutes = (span) => {
  const match = span.match(/^(\d+)(min|m|h)$/);
  expect(match, `${span} is a whole number of minutes or hours`).not.toBeNull();
  return Number(match[1]) * (match[2] === "h" ? 60 : 1);
};

// [start, end) in minutes past midnight UTC: when a daily timer may fire.
const fireWindow = (path) => {
  const text = read(path);
  const calendar = setting(text, "OnCalendar");
  const match =
    calendar === "daily"
      ? ["", "00", "00"]
      : calendar.match(/^\*-\*-\* (\d\d):(\d\d):00 UTC$/);
  expect(match, `${path} fires daily at a fixed UTC time`).not.toBeNull();
  const start = Number(match[1]) * 60 + Number(match[2]);
  return [start, start + minutes(setting(text, "RandomizedDelaySec"))];
};

const TIMER = read("infra/relay/aws/alcove-relay-metrics.timer");
const SERVICE = read("infra/relay/aws/alcove-relay-metrics.service");

// Every minute past midnight UTC the publisher's timer fires at.
const publishTimes = () => {
  const match = setting(TIMER, "OnCalendar").match(
    /^\*-\*-\* ([\d,]+):(\d\d)\/(\d+):00 UTC$/,
  );
  expect(
    match,
    "OnCalendar is an hour list and a minute repetition",
  ).not.toBeNull();
  const hours = match[1].split(",").map(Number);
  const times = [];
  for (const hour of hours) {
    for (
      let minute = Number(match[2]);
      minute < 60;
      minute += Number(match[3])
    ) {
      times.push(hour * 60 + minute);
    }
  }
  return { hours, times };
};

const QUIET_HOURS = [0, 3, 4, 5, 6, 7];

describe("alcove-relay-metrics.timer", () => {
  it("fires in no hour the README keeps it out of", () => {
    const { hours } = publishTimes();
    for (const hour of QUIET_HOURS) expect(hours).not.toContain(hour);
    expect(hours).toHaveLength(24 - QUIET_HOURS.length);
    expect(read("infra/relay/README.md")).toContain(
      "except in hour 00 and hours 03 to 07 UTC",
    );
  });

  it("ends every run before a quiet hour begins", () => {
    const slack =
      minutes(setting(TIMER, "AccuracySec")) +
      minutes(setting(SERVICE, "TimeoutStartSec"));
    for (const time of publishTimes().times) {
      const lastMinute = time + slack;
      const hour = Math.floor(lastMinute / 60) % 24;
      expect(QUIET_HOURS, `a run fired at minute ${time}`).not.toContain(hour);
    }
  });

  it.each([
    ["the daily verification", "infra/relay/alcove-relay-verify.timer"],
    [
      "the relay's certificate renewal",
      "infra/relay/certs/alcove-relay-cert.timer",
    ],
    [
      "the broker's certificate renewal",
      "infra/broker/alcove-broker-cert.timer",
    ],
    ["the OS update", "infra/relay/alcove-relay-os-update.timer"],
    ["the host pull", "infra/host-pull/alcove-host-pull.timer"],
  ])("keeps out of every hour %s may fire in", (_, path) => {
    const [start, end] = fireWindow(path);
    for (let minute = start; minute < end; minute += 1) {
      expect(QUIET_HOURS).toContain(Math.floor(minute / 60) % 24);
    }
  });

  it("does not catch up at boot", () => {
    expect(setting(TIMER, "Persistent")).toBe("false");
  });
});

describe("alcove-relay-metrics.service", () => {
  it("runs the script where install.sh installs it", () => {
    expect(setting(SERVICE, "ExecStart")).toBe(
      "/opt/alcove-relay/aws/publish-metrics.sh",
    );
    const install = read("infra/relay/install.sh");
    expect(install).toMatch(
      /install -m 755 [^\n]*"\$HERE\/aws\/publish-metrics\.sh" "\$LIBEXEC\/aws\/"/,
    );
    expect(install).toContain(
      "systemctl enable --now alcove-relay-metrics.timer",
    );
  });

  it("keeps the state where the script writes it", () => {
    const state = setting(SERVICE, "StateDirectory");
    expect(read("infra/relay/aws/publish-metrics.sh")).toContain(
      `/var/lib/${state}/published`,
    );
  });
});
