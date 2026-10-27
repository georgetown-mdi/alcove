/**
 * The schedule half of the lines a hand-off surface shows an operator: the
 * cron fields and the Windows Task Scheduler registration that run an Alcove
 * invocation unattended from the folder holding its files.
 *
 * One copy, shared by both hand-off surfaces -- the managed exchange's
 * command-line export panel and the console's recurring hand-off -- so the two
 * cannot diverge. A surface with an agreed schedule passes it
 * ({@link runScheduleFor}); one without shows a daily 2am example the operator
 * edits.
 */

/** The Windows folder placeholder the Task Scheduler line changes into. */
const WINDOWS_FOLDER_PLACEHOLDER = "C:\\path\\to\\your\\exchange-folder";

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_MINUTE = 60;

/** The interval a weekly cron line or Task Scheduler trigger states. */
const WEEK_DAYS = 7;

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** The agreed recurrence a scheduled line runs on, in UTC. */
export interface RunSchedule {
  /** The UTC hour (0-23) each window opens at. */
  hour: number;
  /** The UTC minute (0-59) each window opens at. */
  minute: number;
  /** Whole days between windows. */
  intervalDays: number;
  /** The first window's UTC date, as days since 1970-01-01. */
  anchorDay: number;
  /** The first window's UTC weekday, 0 for Sunday. */
  weekday: number;
  /** The first window's UTC date, `YYYY-MM-DD`. */
  anchorDate: string;
}

/**
 * The run schedule for an agreed `anchor` (an ISO 8601 instant, the first
 * window's open) and `intervalDays`. Cron and Task Scheduler start a job on a
 * whole minute, so the anchor's seconds are dropped.
 */
export function runScheduleFor({
  anchor,
  intervalDays,
}: {
  anchor: string;
  intervalDays: number;
}): RunSchedule {
  const opens = new Date(anchor);
  return {
    hour: opens.getUTCHours(),
    minute: opens.getUTCMinutes(),
    intervalDays,
    anchorDay: Math.floor(opens.getTime() / 1000 / SECONDS_PER_DAY),
    weekday: opens.getUTCDay(),
    anchorDate: opens.toISOString().slice(0, 10),
  };
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** `HH:MM`, the time of day a schedule opens at. */
function timeOfDay({ hour, minute }: RunSchedule): string {
  return `${twoDigits(hour)}:${twoDigits(minute)}`;
}

/** Whether cron's own fields state `schedule`'s interval, with no day count. */
function cronStatesInterval({ intervalDays }: RunSchedule): boolean {
  return intervalDays === 1 || intervalDays === WEEK_DAYS;
}

/**
 * The five cron fields: daily at 2am with no schedule, else the schedule's
 * UTC time daily, or weekly on its weekday.
 */
export function cronScheduleFields(schedule: RunSchedule | undefined): string {
  if (schedule === undefined) return "0 2 * * *";
  const { minute, hour, intervalDays, weekday } = schedule;
  return intervalDays === WEEK_DAYS
    ? `${minute} ${hour} * * ${weekday}`
    : `${minute} ${hour} * * *`;
}

/**
 * The test a daily cron line runs before its command on an interval cron
 * cannot state, so the command runs only on the days a whole number of
 * intervals from the first window. Each day is counted from half a day before
 * the schedule's time of day, so a run that the machine's time zone or a
 * daylight saving change moves by less than twelve hours still counts on its
 * window's own day. Unescaped: the caller escapes `%` for cron.
 */
export function cronIntervalGuard(schedule: RunSchedule | undefined): string {
  if (schedule === undefined || cronStatesInterval(schedule)) return "";
  const shift =
    schedule.hour * SECONDS_PER_HOUR +
    schedule.minute * SECONDS_PER_MINUTE -
    SECONDS_PER_DAY / 2;
  const clock =
    shift === 0
      ? "$(date +%s)"
      : `($(date +%s) ${shift > 0 ? "-" : "+"} ${Math.abs(shift)})`;
  return (
    `[ $(( (${clock} / ${SECONDS_PER_DAY} - ${schedule.anchorDay}) ` +
    `% ${schedule.intervalDays} )) -eq 0 ] && `
  );
}

/** `text` as a PowerShell double-quoted string: each double quote doubled,
 * and a backtick before each character that would end or expand it, the
 * typographic double quotes PowerShell also reads as quotes included. */
function powerShellString(text: string): string {
  const escaped = text.replace(/["\u201C\u201D\u201E`$]/g, (character) =>
    character === '"' ? '""' : `\`${character}`,
  );
  return `"${escaped}"`;
}

/** Today at `hour`:`minute`, as a PowerShell expression. A daily or weekly
 * trigger fires on the same days whatever its start date. */
function powerShellToday(hour: number, minute: number): string {
  const hours = hour === 0 ? "" : `.AddHours(${hour})`;
  const minutes = minute === 0 ? "" : `.AddMinutes(${minute})`;
  return `([datetime]::Today${hours}${minutes})`;
}

/** The New-ScheduledTaskTrigger options for `schedule`, or daily at 2am
 * without one. No date is written out as text, so no date format is read. */
function powerShellTrigger(schedule: RunSchedule | undefined): string {
  if (schedule === undefined) return `-Daily -At ${powerShellToday(2, 0)}`;
  const { hour, minute, intervalDays } = schedule;
  if (intervalDays === WEEK_DAYS)
    return (
      `-Weekly -DaysOfWeek ${WEEKDAY_NAMES[schedule.weekday]} ` +
      `-At ${powerShellToday(hour, minute)}`
    );
  if (intervalDays === 1) return `-Daily -At ${powerShellToday(hour, minute)}`;
  // The interval counts from the start date, so it is the first window's.
  const [year, month, day] = schedule.anchorDate.split("-").map(Number);
  return (
    `-Daily -DaysInterval ${intervalDays} -At ` +
    `([datetime]::new(${year}, ${month}, ${day}, ${hour}, ${minute}, 0))`
  );
}

/**
 * The PowerShell command that registers a Windows Task Scheduler task running
 * `command` under cmd on `schedule` (daily at 2am without one), from the
 * folder holding the exchange's files. `command` is already quoted for cmd.
 * Not a schtasks line, for the reasons docs/spec/MANAGED_EXCHANGE_RECORD.md
 * gives under "The Task Scheduler line".
 */
export function taskSchedulerLine(
  command: string,
  schedule?: RunSchedule,
): string {
  const action = `/c cd /d "${WINDOWS_FOLDER_PLACEHOLDER}" && ${command}`;
  return (
    "Register-ScheduledTask -TaskName 'alcove exchange' -Trigger " +
    `(New-ScheduledTaskTrigger ${powerShellTrigger(schedule)}) ` +
    "-Action (New-ScheduledTaskAction -Execute 'cmd.exe' " +
    `-Argument ${powerShellString(action)})`
  );
}

/** When the lines run, as a phrase: "daily at 2am" without a schedule. */
export function scheduleDescription(schedule: RunSchedule | undefined): string {
  if (schedule === undefined) return "daily at 2am";
  const time = `${timeOfDay(schedule)} UTC`;
  if (schedule.intervalDays === 1) return `daily at ${time}`;
  if (schedule.intervalDays === WEEK_DAYS)
    return `every ${WEEKDAY_NAMES[schedule.weekday]} at ${time}`;
  return (
    `every ${schedule.intervalDays} days at ${time}, counted from ` +
    schedule.anchorDate
  );
}

/**
 * What the operator checks before using lines composed from `schedule`: the
 * times are UTC, and, on an interval cron cannot state, how the cron line
 * counts days and the Task Scheduler start date. Undefined without a
 * schedule.
 */
export function scheduleNote(
  schedule: RunSchedule | undefined,
): string | undefined {
  if (schedule === undefined) return undefined;
  const utc =
    "These lines start at the time your exchange is agreed to open, in UTC. " +
    "cron and Task Scheduler read the time in the machine's own time zone, " +
    "so on a machine not set to UTC change the hour to that zone's time";
  if (cronStatesInterval(schedule))
    return (
      utc +
      (schedule.intervalDays === WEEK_DAYS
        ? ", and the weekday where that change crosses midnight."
        : ".")
    );
  return (
    utc +
    ", and the Task Scheduler start date where that change crosses " +
    "midnight. The cron line runs daily and starts the exchange only on " +
    "the days counted from the first window."
  );
}
