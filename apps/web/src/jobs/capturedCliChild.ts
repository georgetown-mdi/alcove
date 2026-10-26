import { spawn } from "node:child_process";

import { sanitizedChildEnv } from "./cliDriver";

import type { ChildProcess } from "node:child_process";

/**
 * The one spawn boundary the console's short-lived CLI drivers cross: the
 * host-key probe ({@link ./sftpProbe}), the signing-identity fingerprint
 * ({@link ./signingIdentity}), the terms-proposal apply
 * ({@link ./termsProposal}), and the relay check ({@link ./relayCheck}). Each
 * is a request-scoped child that prints at most a single line and exits, so
 * all need the same three controls -- a no-shell argv
 * array, a capped stdout read, and a watchdog that bounds the child's lifetime
 * -- and each is reached from an unauthenticated loopback endpoint. Holding them
 * once is what keeps them from drifting apart: a caller contributes only its
 * argv, its own timeouts, and its own mapping from an outcome to a typed result.
 * The watchdog bounds the child, not the endpoint's latency: settling waits for
 * the stdio pipes to close, so a child that handed its stdout to a longer-lived
 * process it spawned defers settling past the kill. That shape is a stated limit
 * of this boundary, not one it enforces.
 *
 * `spawn` with an argv ARRAY and `shell: false` is the same allowlisted-argv
 * discipline `runCliChild` uses, so no value a caller composes is ever an
 * interpretable token. stderr is drained and DISCARDED: it can name filesystem
 * paths inside the container and can contain bytes an untrusted server chose, so
 * nothing this boundary returns is derived from it, while draining keeps a chatty
 * child's pipe from filling and blocking it.
 */

/**
 * The default cap on retained child stdout, in UTF-16 code units. Every
 * caller's child emits ONE line (a fingerprint digest, or a JSON object) and
 * sends every diagnostic to stderr, so anything past the line's own size is a
 * malformed or hostile child: the read is bounded rather than left to grow,
 * and the overflow is reported as a missing read the caller classifies as an
 * error. A caller whose line can be longer passes its own `stdoutCap`.
 */
const CAPTURED_STDOUT_CAP = 4096;

/**
 * How a captured child ended:
 * - `spawnFailed`: the child could not be spawned, or died before running.
 * - `timedOut`: the watchdog killed it (it outlived the caller's budget).
 * - `exited`: it ended on its own. `code` is its exit code, or null when a signal
 *   ended it; `stdout` is the captured text, or undefined when the read
 *   overflowed the cap.
 */
type CapturedChildOutcome =
  | { kind: "spawnFailed" }
  | { kind: "timedOut" }
  | { kind: "exited"; code: number | null; stdout: string | undefined };

/**
 * A request to end a captured child before its watchdog: `signal`'s abort
 * starts the SIGTERM-then-SIGKILL chain with `sigkillGraceMs` as its grace.
 */
export interface CapturedChildStop {
  signal: AbortSignal;
  sigkillGraceMs: number;
}

/**
 * Spawn `node argv` for a one-shot CLI child, capture its stdout under
 * `stdoutCap` or {@link CAPTURED_STDOUT_CAP}, and settle on the child's
 * `close`: once it has exited and its stdio has closed, whether it ended on its own, the watchdog
 * killed it, or it never spawned.
 *
 * The watchdog SIGTERMs at `sigtermMs`, escalating to SIGKILL after
 * `sigkillGraceMs` -- mirroring `jobManager.ts`'s cancel-escalation chain. Every
 * timer is unref'd and cleared on settle, so a pending watchdog never holds the
 * process open or fires after the result is out. Both budgets are the caller's;
 * what the child itself spends is its own subcommand's business.
 *
 * `stop` ends the child early through the same chain: aborting its signal
 * SIGTERMs the child, escalating to SIGKILL after its own `sigkillGraceMs`,
 * and the outcome is whatever the child's exit then reports.
 *
 * `cwd` is omitted to inherit the server's working directory; a caller resolving
 * paths relative to it pins its own and creates it first.
 */
export function runCapturedCliChild(args: {
  argv: Array<string>;
  cwd?: string;
  childEnv?: NodeJS.ProcessEnv;
  sigtermMs: number;
  sigkillGraceMs: number;
  stdoutCap?: number;
  stop?: CapturedChildStop;
}): Promise<CapturedChildOutcome> {
  const stdoutCap = args.stdoutCap ?? CAPTURED_STDOUT_CAP;
  return new Promise<CapturedChildOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args.argv, {
        ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: { ...sanitizedChildEnv(), ...args.childEnv },
      });
    } catch {
      resolve({ kind: "spawnFailed" });
      return;
    }
    let stdout = "";
    let stdoutOverflow = false;
    const out = child.stdout;
    if (out !== null) {
      out.setEncoding("utf8");
      out.on("data", (chunk: string) => {
        if (stdoutOverflow) return;
        stdout += chunk;
        if (stdout.length > stdoutCap) {
          stdoutOverflow = true;
          stdout = "";
        }
      });
    }
    child.stderr?.resume();

    let timedOut = false;
    let settled = false;
    const timers: Array<NodeJS.Timeout> = [];
    const stopSignal = args.stop?.signal;
    const settle = (outcome: CapturedChildOutcome): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      stopSignal?.removeEventListener("abort", onStop);
      resolve(outcome);
    };

    const terminate = (sigkillGraceMs: number): void => {
      child.kill("SIGTERM");
      const toSigkill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, sigkillGraceMs);
      toSigkill.unref();
      timers.push(toSigkill);
    };
    const toSigterm = setTimeout(() => {
      timedOut = true;
      terminate(args.sigkillGraceMs);
    }, args.sigtermMs);
    toSigterm.unref();
    timers.push(toSigterm);

    function onStop(): void {
      if (args.stop !== undefined) terminate(args.stop.sigkillGraceMs);
    }
    if (stopSignal?.aborted === true) onStop();
    else stopSignal?.addEventListener("abort", onStop, { once: true });

    // Settled on `close` alone: Node emits `close` after a failed spawn too, and
    // an `error` from a failed kill leaves the child running.
    let spawnFailed = false;
    child.on("error", () => {
      if (child.pid === undefined) spawnFailed = true;
    });
    child.on("close", (code) => {
      settle(
        spawnFailed
          ? { kind: "spawnFailed" }
          : timedOut
            ? { kind: "timedOut" }
            : {
                kind: "exited",
                code,
                stdout: stdoutOverflow ? undefined : stdout,
              },
      );
    });
  });
}
