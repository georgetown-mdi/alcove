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

const sortedNames = (names) => [...names].sort();

// The names the registrar writes, from its own COUNTER_NAMES.
const COUNTS = (() => {
  const match = read("infra/relay/registrar.py").match(
    /^COUNTER_NAMES = \(([^)]*)\)/m,
  );
  expect(match, "registrar.py defines COUNTER_NAMES").not.toBeNull();
  return [...match[1].matchAll(/"([a-z_]+)"/g)].map((name) => name[1]);
})();

// The backticked metric names in the Alcove/Relay rows of a markdown table
// whose first cell is an alarm name, other than the heartbeat.
const alarmedCounts = (path) => {
  const names = [];
  for (const row of read(path).split("\n")) {
    if (!/^\| `alcove-relay-/.test(row) || !row.includes("`Alcove/Relay`")) {
      continue;
    }
    for (const token of row.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
      if (token[1] !== "publisher_heartbeat") names.push(token[1]);
    }
  }
  return names;
};

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
  const emptyBin = join(root, "empty-bin");
  mkdirSync(emptyBin);
  return {
    stateFile,
    write: (text) => writeFileSync(countersFile, text),
    awsFails: (fails) =>
      fails ? writeFileSync(failFlag, "") : rmSync(failFlag, { force: true }),
    // The last heartbeat as published on an earlier UTC day.
    heartbeatYesterday: () =>
      writeFileSync(
        stateFile,
        readFileSync(stateFile, "utf8").replace(
          /^heartbeat=.*$/m,
          "heartbeat=2000-01-01",
        ),
      ),
    // withoutAws runs on a PATH holding nothing, which the --heartbeat
    // path alone can run on.
    run: ({ args = [], withoutAws = false } = {}) => {
      rmSync(calls, { force: true });
      const result = spawnSync(BASH, [PUBLISH, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: withoutAws ? emptyBin : `${bin}:${process.env.PATH}`,
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

  it("records the first counts it reads and publishes none of them, only the day's heartbeat", () => {
    const host = fixtureHost();
    host.write(counters(START, { tokenless_enrollments: 500 }));
    const run = host.run();
    expect(run.status).toBe(0);
    expect(run.awsCalls).toEqual([
      "cloudwatch put-metric-data --region us-west-2 --namespace Alcove/Relay --metric-data " +
        "MetricName=publisher_heartbeat,Value=1,Unit=Count",
    ]);
    expect(readFileSync(host.stateFile, "utf8")).toContain(
      "tokenless_enrollments=500",
    );
  });

  it("publishes the heartbeat on the first run of a UTC day and not on later runs", () => {
    const host = fixtureHost();
    host.write(counters(START, {}));
    expect(host.run().awsCalls).toHaveLength(1);
    expect(host.run().awsCalls).toEqual([]);
    host.heartbeatYesterday();
    const nextDay = host.run();
    expect(nextDay.status, nextDay.stderr).toBe(0);
    expect(nextDay.awsCalls).toEqual([
      "cloudwatch put-metric-data --region us-west-2 --namespace Alcove/Relay --metric-data " +
        "MetricName=publisher_heartbeat,Value=1,Unit=Count",
    ]);
    expect(nextDay.stderr).toContain("published heartbeat");
    expect(host.run().awsCalls).toEqual([]);
  });

  it("sends the day's heartbeat in the same aws call as a rise", () => {
    const host = fixtureHost();
    host.write(counters(START, {}));
    host.run();
    host.heartbeatYesterday();
    host.write(counters(START, { rate_limit_refusals: 2 }));
    const run = host.run();
    expect(run.awsCalls).toEqual([
      "cloudwatch put-metric-data --region us-west-2 --namespace Alcove/Relay --metric-data " +
        "MetricName=rate_limit_refusals,Value=2,Unit=Count " +
        "MetricName=publisher_heartbeat,Value=1,Unit=Count",
    ]);
  });

  it("sends the heartbeat again on the next run after a failed one", () => {
    const host = fixtureHost();
    host.write(counters(START, {}));
    host.awsFails(true);
    const failed = host.run();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("the publish of heartbeat");
    host.awsFails(false);
    const retried = host.run();
    expect(retried.status, retried.stderr).toBe(0);
    expect(retried.awsCalls).toEqual([
      "cloudwatch put-metric-data --region us-west-2 --namespace Alcove/Relay --metric-data " +
        "MetricName=publisher_heartbeat,Value=1,Unit=Count",
    ]);
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

  describe("--heartbeat, install.sh's test publish", () => {
    it("publishes one heartbeat and records nothing", () => {
      const host = fixtureHost();
      host.write(counters(START, { tokenless_enrollments: 5 }));
      const run = host.run({ args: ["--heartbeat"] });
      expect(run.status, run.stderr).toBe(0);
      expect(run.awsCalls).toEqual([
        "cloudwatch put-metric-data --region us-west-2 --namespace Alcove/Relay --metric-data " +
          "MetricName=publisher_heartbeat,Value=1,Unit=Count",
      ]);
      expect(existsSync(host.stateFile)).toBe(false);
    });

    it("fails naming the missing aws command", () => {
      const host = fixtureHost();
      const run = host.run({ args: ["--heartbeat"], withoutAws: true });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("no aws command on PATH");
    });

    it("fails where CloudWatch refuses the publish", () => {
      const host = fixtureHost();
      host.awsFails(true);
      const run = host.run({ args: ["--heartbeat"] });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("refused or did not answer a test publish");
    });

    it("is run by install.sh, which stops on its failure before enabling the timer", () => {
      const install = read("infra/relay/install.sh");
      const testPublish = install.indexOf(
        '"$LIBEXEC/aws/publish-metrics.sh" --heartbeat \\\n    || die ',
      );
      expect(testPublish).toBeGreaterThan(-1);
      expect(testPublish).toBeLessThan(
        install.indexOf("systemctl enable --now alcove-relay-metrics.timer"),
      );
    });
  });

  it("publishes exactly the counts the registrar writes", () => {
    expect(COUNTS).toContain("client_cap_refusals");
    expect(COUNTS).toContain("tokenless_ceiling_refusals");
    const declared = read("infra/relay/aws/publish-metrics.sh").match(
      /^COUNTS=\(([^)]*)\)/m,
    );
    expect(declared, "publish-metrics.sh declares COUNTS").not.toBeNull();
    expect(sortedNames(declared[1].trim().split(/\s+/))).toEqual(
      sortedNames(COUNTS),
    );
  });

  it("is alarmed on exactly the counts the registrar writes, in the README and provision.md", () => {
    expect(sortedNames(alarmedCounts("infra/relay/README.md"))).toEqual(
      sortedNames(COUNTS),
    );
    expect(sortedNames(alarmedCounts("infra/relay/aws/provision.md"))).toEqual(
      sortedNames(COUNTS),
    );
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
  if (span === "0") return 0;
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

// The hours the daily jobs run in (README.md, The daily schedule).
const QUIET_HOURS = [8, 9, 10];

describe("alcove-relay-metrics.timer", () => {
  it("fires in no hour the README keeps it out of", () => {
    const { hours } = publishTimes();
    for (const hour of QUIET_HOURS) expect(hours).not.toContain(hour);
    expect(hours).toHaveLength(24 - QUIET_HOURS.length);
    const readme = read("infra/relay/README.md");
    expect(readme).toContain("except in hours 08 to 10 UTC");
    expect(readme).toContain(
      "Every daily job on the relay host runs between 08:00 and 11:00 UTC",
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

// The longest wait, in minutes, from one run to the next, across midnight.
const longestGap = () => {
  const { times } = publishTimes();
  const sorted = [...times].sort((a, b) => a - b);
  return Math.max(
    ...sorted.map((time, i) =>
      i + 1 < sorted.length ? sorted[i + 1] - time : sorted[0] + 1440 - time,
    ),
  );
};

const alarmPeriodMinutes = (alarm) => {
  const row = read("infra/relay/aws/provision.md").match(
    new RegExp(`^\\| \`${alarm}\` \\|.*\`Sum\`, (\\d+) \\|$`, "m"),
  );
  expect(row, `provision.md has a Sum row for ${alarm}`).not.toBeNull();
  return Number(row[1]) / 60;
};

describe("the alarms on the publisher's datapoints", () => {
  it("sizes the enrollment threshold to a period plus the longest gap between runs", () => {
    const multiple = read("infra/relay/README.md").match(
      /`alcove-relay-tokenless-enrollments` \|[^\n]*\| (\d+) times `ALCOVE_RELAY_TOTAL_QUOTA` \|/,
    );
    expect(multiple).not.toBeNull();
    // 3 exchanges an hour per unit of quota at full use.
    const hoursCovered = Number(multiple[1]) / 3;
    const period = alarmPeriodMinutes("alcove-relay-tokenless-enrollments");
    expect(period).toBeGreaterThanOrEqual(longestGap());
    expect(period + longestGap()).toBeLessThanOrEqual(hoursCovered * 60);
  });

  it("gives the heartbeat a one-day period, longer than any gap between runs", () => {
    const period = alarmPeriodMinutes("alcove-relay-publisher-heartbeat");
    expect(period).toBe(1440);
    expect(longestGap()).toBeLessThan(period);
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
