// Loaded with `--import` into each party a completion run spawns: a timer due
// every INTERVAL_MS measures how late the main thread's event loop runs it.
// Each lateness over REPORT_MS is appended to the file
// ALCOVE_STRESS_LOOP_LAG_FILE names as `<ISO time the timer ran> <ms late>`,
// and the process's maximum is appended as `max <ms>` as it exits.
import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

const INTERVAL_MS = 100;
const REPORT_MS = 1_000;

const target = process.env.ALCOVE_STRESS_LOOP_LAG_FILE;
if (isMainThread && target !== undefined) {
  let due = performance.now() + INTERVAL_MS;
  let max = 0;
  setInterval(() => {
    const now = performance.now();
    const late = now - due;
    due = now + INTERVAL_MS;
    if (late > max) max = late;
    if (late > REPORT_MS)
      appendFileSync(
        target,
        `${new Date().toISOString()} ${Math.round(late)}\n`,
      );
  }, INTERVAL_MS).unref();
  process.on("exit", () => {
    appendFileSync(target, `max ${Math.round(max)}\n`);
  });
}
