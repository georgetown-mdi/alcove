/**
 * The pure display derivation for a managed exchange's agreed run schedule: where
 * the recurrence stands at an instant, the cadence in words, and the coordination
 * state a run of missed windows earns. Shared by the saved-exchanges list
 * ({@link ./savedExchangesModel.ts}) and the per-exchange detail view
 * ({@link ./managedDetailModel.ts}) so both name the same window and escalate on
 * the same count, in one voice.
 *
 * Every window instant is read through the schedule arithmetic in
 * {@link ../psi/managedSchedule.ts} and phrased for display exactly once, here.
 * The recurrence is UTC-millisecond arithmetic off the record's stored anchor; the
 * host zone enters only at that display boundary, where `Intl` renders the fixed
 * instant on the operator's own clock. Nothing here re-derives a window instant,
 * and no local-calendar date add appears anywhere: across a daylight-saving
 * transition a calendar add moves the agreed instant by the offset change, which
 * is the drift the shared anchor exists to prevent -- so a window straddling a
 * transition renders an hour later on the wall clock and at the same agreed
 * instant.
 *
 * These surfaces DISPLAY the schedule; they never advance it. The bookkeeping
 * fields are read verbatim -- `consecutiveMisses` as the record holds it -- so
 * nothing shown here anticipates a write the runner has not made.
 *
 * `now` is injected rather than read, matching the clock discipline of the managed
 * modules, so every derivation is a pure function of its inputs.
 *
 * The coordination state repeated misses earn is defined in
 * {@link ../psi/managed/managedFailureCopy.ts} and passed through here: the
 * unattended runner's between-visit notification escalates on the same count and
 * says the same thing, and it sits below the product directories where it cannot
 * import a screen's model.
 */

import {
  MAX_SCHEDULE_INTERVAL_DAYS,
  MAX_SCHEDULE_WINDOW_SECONDS,
  parseStoredInstant,
} from "@psi/managed/managedExchangeRecord";
import {
  MAX_TIME_VALUE,
  managedScheduleWindow,
  managedScheduleWindowStateAt,
  nextManagedScheduleWindowAfter,
} from "@psi/managed/managedSchedule";

import { dateTimeLabel, lifetimeNoun } from "@psi/formatting";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeSchedule,
} from "@psi/managed/managedExchangeRecord";

export {
  REPEATED_MISS_ESCALATION,
  REPEATED_MISS_TITLE,
  repeatedMissCoordination,
} from "@psi/managed/managedFailureCopy";
export type { RepeatedMissCoordination } from "@psi/managed/managedFailureCopy";

/** Where the recurrence stands at an instant: a window open right now, or the
 * next one ahead. Both hold their instants phrased in the operator's local
 * display format. */
export type ScheduleDueness =
  | {
      state: "open";
      /** The open window's own open instant. */
      opensAt: string;
      /** The instant the open window closes. */
      closesAt: string;
    }
  | {
      state: "upcoming";
      /** The instant the next window opens. */
      opensAt: string;
    };

/**
 * The widest span a window instant can sit past `now`: one full period plus one
 * full width, both at the record schema's ceiling. Every instant
 * {@link scheduleDueness} phrases lies inside it, since the window it names is
 * either the one containing `now` or the first one after it, so a `now` this far
 * inside the representable range guarantees a renderable window.
 */
const MAX_WINDOW_REACH_MS =
  MAX_SCHEDULE_INTERVAL_DAYS * 86_400_000 + MAX_SCHEDULE_WINDOW_SECONDS * 1000;

/**
 * Where `schedule` stands at `now`, read off the recurrence lattice rather
 * than the record's planned `nextWindow` (bookkeeping the runner advances,
 * which a browser that has not run the schedule holds stale). Every instant
 * returned is renderable: the record schema's `intervalDays` and
 * `windowSeconds` bound how far a window can fall past `now`, and the guard
 * below bounds `now` itself; scheduleSurfacingModel.test.ts sweeps both at
 * the schema's own ceilings.
 *
 * @throws {RangeError} if the schedule's lattice is unusable (an anchor not a
 *   UTC instant, or a period/width outside the record schema's bounds; see
 *   {@link managedScheduleWindow}), or if `now` sits too near the end of the
 *   representable instant range for the window it names to fall inside it.
 */
export function scheduleDueness(
  schedule: ManagedExchangeSchedule,
  now: number,
): ScheduleDueness {
  if (
    !Number.isFinite(now) ||
    Math.abs(now) > MAX_TIME_VALUE - MAX_WINDOW_REACH_MS
  )
    throw new RangeError(
      "managed schedule cannot be read at an instant this near the end of the representable range",
    );
  const upcoming = nextManagedScheduleWindowAfter(schedule, now);
  // The next window opens strictly after `now`, so the one before it is the only
  // window `now` can sit inside -- and before window 0 there is none to sit in.
  const current =
    upcoming.index > 0
      ? managedScheduleWindow(schedule, upcoming.index - 1)
      : undefined;
  return current !== undefined &&
    managedScheduleWindowStateAt(current, now) === "open"
    ? {
        state: "open",
        opensAt: dateTimeLabel(new Date(current.opensAtMs)),
        closesAt: dateTimeLabel(new Date(current.closesAtMs)),
      }
    : {
        state: "upcoming",
        opensAt: dateTimeLabel(new Date(upcoming.opensAtMs)),
      };
}

/** The one-line phrasing of {@link scheduleDueness} both surfaces hold. It
 * states where the window is and promises no run: whether anything runs is the
 * operator's own visit or this runtime's own attendance, and the notes beside
 * this line say which. */
export function scheduleDueLine(dueness: ScheduleDueness): string {
  return dueness.state === "open"
    ? `Run window open now, until ${dueness.closesAt}`
    : `Next run window: ${dueness.opensAt}`;
}

/** The agreed cadence in words: how often a window opens and how long it stays
 * open, both read straight off the record's own integers. */
export function scheduleCadenceLine(schedule: ManagedExchangeSchedule): string {
  const every =
    schedule.intervalDays === 1
      ? "every day"
      : `every ${schedule.intervalDays} days`;
  return `A run window opens ${every} and stays open ${lifetimeNoun(schedule.windowSeconds)}.`;
}

/** An instant as the partner's copy of the schedule states it: UTC, to the
 * minute, with seconds only where the instant has them. */
function utcInstantLabel(ms: number): string {
  const iso = new Date(ms).toISOString();
  const clock = iso.endsWith(":00.000Z")
    ? iso.slice(11, 16)
    : iso.slice(11, 19);
  return `${iso.slice(0, 10)} ${clock} UTC`;
}

/**
 * The agreed schedule as plain text for the operator to send their partner:
 * the next window in UTC, so each side converts it to their own clock rather
 * than reading the other's, the repeat and the window length, and what the
 * partner must have running while each window is open. It names no secret, no
 * invitation, and nothing about the exchange's terms.
 *
 * @throws {RangeError} if the schedule's lattice is unusable (see
 *   {@link scheduleDueness}).
 */
export function partnerScheduleText(
  schedule: ManagedExchangeSchedule,
  now: number,
): string {
  const next = nextManagedScheduleWindowAfter(schedule, now);
  const every =
    schedule.intervalDays === 1
      ? "every day"
      : `every ${String(schedule.intervalDays)} days`;
  return [
    "Schedule for our recurring Alcove exchange",
    "",
    `Next run window opens: ${utcInstantLabel(next.opensAtMs)}`,
    `Repeats: ${every}`,
    `Each window stays open: ${lifetimeNoun(schedule.windowSeconds)}`,
    "",
    "On your side, enter that window as the first one, converted to your own " +
      "clock, with the same repeat and length. Then have your side running " +
      "while each window is open: in a browser, the installed Alcove app left " +
      "running with this exchange saved and its working folder chosen; on the " +
      "command line, a scheduled alcove exchange run that starts inside the " +
      "window.",
  ].join("\n");
}

/**
 * What an INSTALLED app runtime does with an agreed schedule. The unattended
 * runner starts only there, so this is the one reading on which "runs on its own"
 * is a true statement -- and it stays bounded by what the runtime can promise: an
 * app that is not running when a window opens meets nothing, and a partner who
 * does not arrive leaves the window a benign miss.
 */
const SCHEDULE_ATTENDANCE_NOTE_INSTALLED =
  "This app is installed, so it runs this exchange itself at each agreed window while it is open, with nobody present. A window that opens while the app is closed passes without a run, so leave it running (or launch it at sign-in) if you want the schedule met unattended.";

/**
 * What an ORDINARY browser tab does with an agreed schedule: nothing on its
 * own. States the limit and the operator's move -- a window that arrives
 * while nothing is open here simply passes, and the copy must not read as an
 * assurance that something attended to it -- and names the installed app as
 * the way out: stating a limit, not withholding a capability.
 */
const SCHEDULE_ATTENDANCE_NOTE_TAB =
  "This is an ordinary browser tab, which never runs this exchange on its own: a window that opens passes without a run unless you run it here. Come back during a window and run this exchange, or install this app and leave it running to have it meet the windows for you.";

/**
 * The attendance note for the runtime the operator is actually looking at. The
 * two readings are different facts rather than different wordings of one -- the
 * unattended runner starts in the installed app and in nothing else -- so the
 * surfaces branch on the runtime rather than holding one hedged line for both
 * (docs/notes/managed-exchange-design.md, "The automation goal and its platform
 * envelope").
 */
export function scheduleAttendanceNote(installedRuntime: boolean): string {
  return installedRuntime
    ? SCHEDULE_ATTENDANCE_NOTE_INSTALLED
    : SCHEDULE_ATTENDANCE_NOTE_TAB;
}

/**
 * The standing consequence of holding no working folder: a run cannot read the
 * input without the operator, so no window can be met with nobody present. It
 * points at the remedy -- choosing the folder while the operator is here -- which
 * the run surface and the local settings both offer.
 */
export const SCHEDULE_INPUT_RESELECTION_NOTE =
  "This browser holds no folder for this exchange, so no run of it can happen with nobody present: reading the input needs you here. Choose the folder on this page where your browser offers it, or run this exchange yourself while a window is open.";

/** The title over the unchanged-input note. It states the file's condition, not a
 * verdict on the data: whether last period's extract is the right one to link
 * again is the operator's call, and this device cannot make it. */
export const UNCHANGED_INPUT_TITLE =
  "The input file has not changed since the last run";

/**
 * The note for an input file whose last-modified instant predates this exchange's
 * last successful run: the file the next run would read is the one that run
 * already read, so the window ahead would link the same period's data again.
 * `undefined` for every other reading -- a refreshed file, an exchange with no
 * successful run recorded, a file whose modification instant this browser could
 * not read at all (no pointer, no standing grant, a missing or unreadable
 * entry), and a run stamp {@link parseStoredInstant} does not read as an
 * instant, each of which keeps whatever state it already has.
 *
 * It warns and guides: it names what is true and the one move that clears it,
 * bars nothing, and pauses nothing. The run control and the agreed cadence stand
 * either way (docs/MANAGED_EXCHANGE.md, "An input that has not changed since the
 * last run").
 */
export function unchangedInputNote(
  lastRun: ManagedExchangeLastRun | undefined,
  inputModifiedAtMs: number | undefined,
): string | undefined {
  if (lastRun === undefined || lastRun.outcome !== "succeeded")
    return undefined;
  if (inputModifiedAtMs === undefined || !Number.isFinite(inputModifiedAtMs))
    return undefined;
  const ranAtMs = parseStoredInstant(lastRun.at);
  if (Number.isNaN(ranAtMs) || inputModifiedAtMs >= ranAtMs) return undefined;
  const changed = dateTimeLabel(new Date(inputModifiedAtMs));
  const ran = dateTimeLabel(new Date(ranAtMs));
  return `Your input file was last changed ${changed}, before this exchange's last successful run on ${ran}, so the next run would link the same data again. Put this period's extract at that file's name before the next window opens.`;
}
