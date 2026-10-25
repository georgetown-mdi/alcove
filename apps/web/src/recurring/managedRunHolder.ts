/**
 * Which run holds a saved exchange's run+rotate lock, as the page reads it, and
 * what a re-invite or a relay registration change says while one does. Both
 * operations take that lock and are refused while a run holds it
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, Single-owner invariant). No React and
 * no I/O: {@link ./useManagedRunInFlight.ts} reads the lock and this window's
 * runs ({@link ../psi/managed/managedWindowRuns.ts}) and passes them here.
 */

import type { ManagedWindowRunStage } from "@psi/managed/managedWindowRuns";

/**
 * Where the run holding the lock is. `"here-waiting"`: a run in this app
 * window, still waiting for the partner, which this window can stop.
 * `"here-exchanging"`: a run in this app window past that point, which no
 * stop reaches. `"elsewhere"`: a run another window or tab of this app, or
 * the installed app, holds.
 */
export type ManagedRunHolder = "here-waiting" | "here-exchanging" | "elsewhere";

/**
 * The holder of the lock from one reading: whether it reads as held, the
 * stage this window's run of the exchange stands at, and whether this page
 * started a run that has not settled. A page run not listed in this window
 * is between its click and the lock, or past the lock's release, and reads as
 * exchanging until the next reading.
 */
export function managedRunHolder(
  lockHeld: boolean,
  windowStage: ManagedWindowRunStage | undefined,
  runningHere: boolean,
): ManagedRunHolder | undefined {
  if (windowStage === "waiting") return "here-waiting";
  if (windowStage === "exchanging" || runningHere) return "here-exchanging";
  return lockHeld ? "elsewhere" : undefined;
}

/** How a run in another window ends sooner, said after each operation's own
 * wait. A scheduled run's attempt waits up to 10 minutes for the partner, and
 * a schedule turned off ends its window at the attempt after it. */
const ELSEWHERE_ENDS_SOONER =
  "To end it sooner, close that window or tab. If it is a scheduled run, " +
  'turn off "Run this exchange on an agreed schedule" under Local settings ' +
  "and save: the scheduled run then ends after its current attempt, within " +
  "about 10 minutes.";

/** What the re-invite controls say while a run holds the exchange. */
export const REINVITE_HELD_BY_RUN_TEXT: Readonly<
  Record<ManagedRunHolder, string>
> = {
  "here-waiting":
    "A run of this exchange in this window is waiting for your partner. " +
    "Stop it to create a fresh invitation now, or create one once the run " +
    "ends.",
  "here-exchanging":
    "A run of this exchange in this window is exchanging data with your " +
    "partner. Create a fresh invitation once it ends.",
  elsewhere:
    "A run of this exchange is in progress in another window or tab of " +
    "this app, or in the installed app. Create a fresh invitation once it " +
    `ends. ${ELSEWHERE_ENDS_SOONER}`,
};

/** The control that stops this window's waiting run and re-invites. */
export const STOP_RUN_AND_REINVITE_LABEL = "Stop the waiting run and re-invite";

/** What the relay registration form says while a run holds the exchange. */
export const RELAY_REGISTRATION_HELD_BY_RUN_TEXT: Readonly<
  Record<ManagedRunHolder, string>
> = {
  "here-waiting":
    "A run of this exchange in this window is waiting for your partner. " +
    "Stop it to enroll now, or change the relay registration once the run " +
    "ends.",
  "here-exchanging":
    "A run of this exchange in this window is exchanging data with your " +
    "partner. Change the relay registration once it ends.",
  elsewhere:
    "A run of this exchange is in progress in another window or tab of " +
    "this app, or in the installed app. Change the relay registration once " +
    `it ends. ${ELSEWHERE_ENDS_SOONER}`,
};

/** The control that stops this window's waiting run and enrolls. */
export const STOP_RUN_AND_ENROLL_LABEL = "Stop the waiting run and enroll";
