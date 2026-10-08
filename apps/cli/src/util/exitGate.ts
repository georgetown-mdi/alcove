// Bounds how long the process stays alive after the command settles, and
// reports what held it:
// docs/CLI.md#logs-and-what-the-exit-code-tells-the-scheduler.

import fs from "node:fs";

/**
 * How long the process may stay alive after the command promise settles, which
 * is after the run's files, terminal event and log flush. The measurement
 * behind it: docs/spec/WEBRTC_TRANSPORT.md#budgets.
 */
export const PROCESS_RETURN_BUDGET_MS = 3_000;

/**
 * The distinct resource kinds keeping the event loop alive, sorted. These are
 * Node's own type names, never partner or server text, so they need no
 * escaping.
 */
export function heldResourceKinds(): string[] {
  return [...new Set(process.getActiveResourcesInfo())].sort();
}

/**
 * The line written when {@link PROCESS_RETURN_BUDGET_MS} passes with the loop
 * still held. `kinds` can be empty when Node does not name what holds it.
 */
export function processHeldNotice(
  elapsedMs: number,
  kinds: readonly string[],
): string {
  const held =
    kinds.length === 0 ? "something Node does not name" : kinds.join(", ");
  return (
    `Alcove finished this run and wrote its files, but the process was ` +
    `still held open ${Math.round(elapsedMs / 1000)}s later by: ${held}. ` +
    `Exiting with the run's own status; report this with those names.`
  );
}

/**
 * Write one line to stderr synchronously: the caller exits on the next
 * statement, and a pipe write through `process.stderr` can be asynchronous.
 */
export function writeStderrLine(line: string): void {
  const buf = Buffer.from(line + "\n", "utf8");
  let offset = 0;
  try {
    while (offset < buf.length)
      offset += fs.writeSync(2, buf, offset, buf.length - offset);
  } catch {
    // stderr is closed or wedged; a failed diagnostic must not hang the exit.
  }
}

/** Whether a signal handler has taken over ending this process. */
let signalOwnsExit = false;

/**
 * Record that a signal handler is ending this process, so
 * {@link armProcessReturnGate} does not end an interrupt's teardown early.
 */
export function noteSignalOwnsExit(): void {
  signalOwnsExit = true;
}

/** The status the run already resolved; anything but a number is 0. */
function resolvedExitCode(): number {
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

/**
 * Called once, after the command promise settles: if the loop is still held
 * after `budgetMs`, name the held resource kinds on stderr and exit with the
 * run's own status. The timer is unref'd, so a clean loop exits without it.
 * The holding handle is left alone, so the next leak is reported rather than
 * hidden. A signal handler owning the exit ({@link noteSignalOwnsExit}),
 * before or after arming, stops it.
 */
export function armProcessReturnGate(
  budgetMs: number = PROCESS_RETURN_BUDGET_MS,
): void {
  if (signalOwnsExit) return;
  const armedAt = Date.now();
  const deadline = setTimeout(() => {
    if (signalOwnsExit) return;
    writeStderrLine(
      processHeldNotice(Date.now() - armedAt, heldResourceKinds()),
    );
    process.exit(resolvedExitCode());
  }, budgetMs);
  deadline.unref();
}
