import { execFileSync } from "node:child_process";

import { describe, expect, test } from "vitest";

import {
  cronIntervalGuard,
  cronScheduleFields,
  runScheduleFor,
  scheduleDescription,
  scheduleNote,
  taskSchedulerLine,
} from "@recurring/scheduleTemplates";

// The schedule half of the lines both hand-off surfaces show. An operator copies
// these verbatim into cron or schtasks, so what is checked here is the text they
// paste: the agreed anchor and interval in the fields, the command run from the
// folder the placeholder names, and the Windows registration surviving a
// command that holds quotes of its own.

const COMMAND = "alcove exchange input.csv results.csv";

/** A Tuesday, 14:30:45 UTC. */
const ANCHOR = "2026-10-06T14:30:45.000Z";

describe("with no agreed schedule", () => {
  test("cron runs daily at 2am", () => {
    expect(cronScheduleFields(undefined)).toBe("0 2 * * *");
    expect(cronIntervalGuard(undefined)).toBe("");
    expect(scheduleDescription(undefined)).toBe("daily at 2am");
    expect(scheduleNote(undefined)).toBeUndefined();
  });

  test("the Task Scheduler line registers the same run for Windows", () => {
    const line = taskSchedulerLine(COMMAND);
    expect(line).toContain('schtasks /Create /TN "alcove exchange"');
    expect(line).toContain("/SC DAILY /ST 02:00");
    expect(line).toContain(
      `/TR "cmd /c cd /d C:\\path\\to\\your\\exchange-folder && ${COMMAND}"`,
    );
  });
});

describe("the agreed schedule", () => {
  test("is read in UTC, to the minute", () => {
    expect(runScheduleFor({ anchor: ANCHOR, intervalDays: 3 })).toEqual({
      hour: 14,
      minute: 30,
      intervalDays: 3,
      anchorDay: Math.floor(Date.parse(ANCHOR) / 86_400_000),
      weekday: 2,
      anchorDate: "2026-10-06",
    });
  });

  test("a daily schedule runs at its time every day", () => {
    const schedule = runScheduleFor({ anchor: ANCHOR, intervalDays: 1 });
    expect(cronScheduleFields(schedule)).toBe("30 14 * * *");
    expect(cronIntervalGuard(schedule)).toBe("");
    expect(taskSchedulerLine(COMMAND, schedule)).toContain(
      "/SC DAILY /ST 14:30 /TR",
    );
    expect(scheduleDescription(schedule)).toBe("daily at 14:30 UTC");
    expect(scheduleNote(schedule)).toMatch(/in UTC/);
  });

  test("a weekly schedule runs on the first window's weekday", () => {
    const schedule = runScheduleFor({ anchor: ANCHOR, intervalDays: 7 });
    expect(cronScheduleFields(schedule)).toBe("30 14 * * 2");
    expect(cronIntervalGuard(schedule)).toBe("");
    expect(taskSchedulerLine(COMMAND, schedule)).toContain(
      "/SC WEEKLY /D TUE /ST 14:30 /TR",
    );
    expect(scheduleDescription(schedule)).toBe("every Tuesday at 14:30 UTC");
    expect(scheduleNote(schedule)).toMatch(/weekday/);
  });

  test("another interval runs daily and counts days from the first window", () => {
    const schedule = runScheduleFor({ anchor: ANCHOR, intervalDays: 3 });
    expect(cronScheduleFields(schedule)).toBe("30 14 * * *");
    expect(taskSchedulerLine(COMMAND, schedule)).toContain(
      "/SC DAILY /MO 3 /SD 10/06/2026 /ST 14:30 /TR",
    );
    expect(scheduleDescription(schedule)).toBe(
      "every 3 days at 14:30 UTC, counted from 2026-10-06",
    );
    expect(scheduleNote(schedule)).toMatch(/month\/day\/year/);
  });

  test.each([
    [0, true],
    [1, false],
    [2, false],
    [3, true],
    [6, true],
    [-3, true],
  ])(
    "the day count lets a run %i days after the first window through: %s",
    (daysAfter, runs) => {
      // The guard as a shell runs it at that window's open, with the clock read
      // replaced by that instant.
      const schedule = runScheduleFor({ anchor: ANCHOR, intervalDays: 3 });
      const now = Math.floor(Date.parse(ANCHOR) / 1000) + daysAfter * 86_400;
      const guard = cronIntervalGuard(schedule).replace(
        "$(date +%s)",
        String(now),
      );
      expect(
        execFileSync("/bin/sh", ["-c", `${guard}echo ran; true`], {
          encoding: "utf8",
        }).trim(),
      ).toBe(runs ? "ran" : "");
    },
  );
});

test.each([
  ["at its time", 0],
  ["an hour early, across midnight UTC", -3_600],
  ["an hour late", 3_600],
])(
  "the day count runs a window opening just after midnight UTC started %s",
  (_when, offsetSeconds) => {
    // A window at 00:30 UTC, started where the machine's clock change has moved
    // the run, on the window's day and on the day after it.
    const anchor = "2026-10-06T00:30:00.000Z";
    const schedule = runScheduleFor({ anchor, intervalDays: 3 });
    const ranAt = (daysAfter: number): string => {
      const now =
        Math.floor(Date.parse(anchor) / 1000) +
        daysAfter * 86_400 +
        offsetSeconds;
      const guard = cronIntervalGuard(schedule).replace(
        "$(date +%s)",
        String(now),
      );
      return execFileSync("/bin/sh", ["-c", `${guard}echo ran; true`], {
        encoding: "utf8",
      }).trim();
    };
    expect(ranAt(3)).toBe("ran");
    expect(ranAt(4)).toBe("");
  },
);

test("a command holding quotes keeps them inside the /TR argument", () => {
  // Inside /TR "...", an unescaped double quote from the command would end that
  // argument early and register a task that runs a truncated command. schtasks
  // preserves a `\"` for the scheduled cmd to re-read, which is what a Direct
  // invocation with a spaced label needs.
  const quoted = 'alcove "--identity=Agency A" input.csv results.csv';
  const line = taskSchedulerLine(quoted);
  expect(line).toContain('\\"--identity=Agency A\\"');
  // Two delimiters around the task name, two around the /TR argument, and none
  // of the command's own: every quote in the line is accounted for.
  expect(line.match(/(?<!\\)"/g)).toHaveLength(4);
});
