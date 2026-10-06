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

const TASK_SCHEDULER_DAYS = [
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
] as const;

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

/** The schtasks options stating `schedule`, or daily at 2am without one. */
function taskSchedulerTrigger(schedule: RunSchedule | undefined): string {
  if (schedule === undefined) return "/SC DAILY /ST 02:00";
  const time = timeOfDay(schedule);
  if (schedule.intervalDays === 1) return `/SC DAILY /ST ${time}`;
  if (schedule.intervalDays === WEEK_DAYS)
    return `/SC WEEKLY /D ${TASK_SCHEDULER_DAYS[schedule.weekday]} /ST ${time}`;
  const [year, month, day] = schedule.anchorDate.split("-");
  return (
    `/SC DAILY /MO ${schedule.intervalDays} /SD ${month}/${day}/${year} ` +
    `/ST ${time}`
  );
}

/**
 * The Windows Task Scheduler command that registers `command` on `schedule`
 * (daily at 2am without one) from the folder holding the exchange's files.
 * `command` is already quoted for `cmd`.
 *
 * The command is interpolated into the `/TR "..."` argument, so a double quote
 * inside it would end that argument early: schtasks needs each one escaped as
 * `\"` for its argv parse to preserve it for the scheduled `cmd` to re-read.
 * That escape happens here, not at each call site, so every caller gets the
 * same treatment.
 */
export function taskSchedulerLine(
  command: string,
  schedule?: RunSchedule,
): string {
  return (
    `schtasks /Create /TN "alcove exchange" ${taskSchedulerTrigger(schedule)} ` +
    `/TR "cmd /c cd /d ${WINDOWS_FOLDER_PLACEHOLDER} && ` +
    `${command.replaceAll('"', '\\"')}"`
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
 * counts days and how the Task Scheduler start date is written. Undefined
 * without a schedule.
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
    "the days counted from the first window. The Task Scheduler start date " +
    "is written month/day/year: on a machine set to another date format, " +
    "write it in that format."
  );
}
