import { spawn, type StdioOptions } from "node:child_process";
import { constants as osConstants } from "node:os";
import { getHeapStatistics } from "node:v8";

import { sanitizeErrorForDisplay } from "@alcove/core";

import { EVENT_STREAM_FD } from "./eventStream";
import { PSI_HEAP_CEILING_FLAG, PSI_HEAP_CEILING_MIB } from "./psiMemoryBudget";

// The installed CLI's main thread starts at Node's default heap limit, and
// preparing an input near the 2^24-element target runs out of heap there. A
// command that runs an exchange therefore runs itself again, once, under the
// PSI heap ceiling. The mechanism: docs/spec/FILE_SYNC.md, "Memory a PSI round
// needs".

/**
 * The environment variable the restarted process finds set, which stops it
 * restarting again.
 */
export const PSI_HEAP_RESTART_MARKER = "ALCOVE_PSI_HEAP_RESTARTED";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"] as const;

let restartAllowed = false;

/**
 * Let {@link restartUnderPsiHeapCeiling} restart this process. Called by the
 * CLI's entry point alone, so a command handler run in-process by a test
 * never starts a second copy of the test runner.
 */
export function allowPsiHeapRestart(): void {
  restartAllowed = true;
}

/** Whether this process is one {@link restartUnderPsiHeapCeiling} started. */
export function restartedForPsiHeap(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[PSI_HEAP_RESTART_MARKER] !== undefined;
}

/**
 * Whether a process with heap limit `heapLimitBytes` and environment `env`
 * restarts under the ceiling: its limit is below it, and it is not already
 * the restarted process.
 */
export function needsPsiHeapRestart(
  heapLimitBytes: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    !restartedForPsiHeap(env) && heapLimitBytes < PSI_HEAP_CEILING_MIB * 2 ** 20
  );
}

/**
 * The arguments the restarted process is given: the heap flag ahead of this
 * process's own Node flags, so a `--max-old-space-size` the operator put on
 * node's command line still wins, then the script and its arguments.
 */
export function psiHeapRestartArgs(
  execArgv: readonly string[],
  argv: readonly string[],
): string[] {
  return [PSI_HEAP_CEILING_FLAG, ...execArgv, ...argv.slice(1)];
}

/**
 * Run this command again in a child Node process under the PSI heap ceiling
 * when {@link needsPsiHeapRestart} holds and the entry point allowed it
 * ({@link allowPsiHeapRestart}), and end this process as the child
 * ends: its exit code, or the signal that terminated it. Resolves at once when
 * no restart is needed and never resolves otherwise. SIGINT and SIGTERM
 * reaching this process are passed to the child. `passEventStreamFd` hands the
 * child this process's fd 3, the `--event-stream` descriptor.
 */
export function restartUnderPsiHeapCeiling(options: {
  passEventStreamFd: boolean;
}): Promise<void> {
  if (
    !restartAllowed ||
    !needsPsiHeapRestart(getHeapStatistics().heap_size_limit)
  )
    return Promise.resolve();
  const stdio: StdioOptions = options.passEventStreamFd
    ? ["inherit", "inherit", "inherit", EVENT_STREAM_FD]
    : "inherit";
  const child = spawn(
    process.execPath,
    psiHeapRestartArgs(process.execArgv, process.argv),
    {
      stdio,
      env: { ...process.env, [PSI_HEAP_RESTART_MARKER]: "1" },
    },
  );
  // On Windows a child's kill() terminates it outright, skipping its cleanup,
  // and a console Ctrl-C already reaches every process attached to the
  // console, so the signal is only kept from ending this process there.
  const forward = (signal: NodeJS.Signals): void => {
    if (process.platform !== "win32") child.kill(signal);
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  child.on("error", (err) => {
    if (child.pid !== undefined) return;
    console.error(
      `could not start the exchange with a larger heap limit ` +
        `(node ${PSI_HEAP_CEILING_FLAG}): ${sanitizeErrorForDisplay(err)}. ` +
        `Set NODE_OPTIONS=${PSI_HEAP_CEILING_FLAG} and run the command again.`,
    );
    process.exit(64);
  });
  child.on("exit", (code, signal) => {
    for (const forwarded of FORWARDED_SIGNALS) process.off(forwarded, forward);
    if (signal === null) process.exit(code ?? 1);
    process.kill(process.pid, signal);
    // A signal whose default action leaves this process running.
    process.exit(128 + (osConstants.signals[signal] ?? 0));
  });
  return new Promise<void>(() => {});
}
