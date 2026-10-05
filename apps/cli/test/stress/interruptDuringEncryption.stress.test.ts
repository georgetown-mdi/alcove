import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { expect, test } from "vitest";

import {
  CLI,
  GB,
  cliPartyNeedBytes,
  hostMemory,
  writeInput,
} from "./completionRun";

// Ctrl-C while a party's PSI worker is masking: the built CLI exits 130 on
// every attempt, never aborting (134) by tearing its worker down inside a
// native call. Two file-sync parties run on this host, each on a terminal of
// its own (util-linux script(1)), so the interrupt is a real Ctrl-C: the
// terminal signals the whole foreground process group. The terminal also
// turns on the live progress line, which is how the test sees a masking
// operation running: the first party to draw one is sent Ctrl-C at a spread
// of delays, and must still be drawing it when the signal is sent.
//
// ALCOVE_STRESS_INTERRUPT_ROWS sets the records a side (500,000 by default,
// which masks for several seconds); ALCOVE_STRESS_INTERRUPT_ATTEMPTS sets the
// attempt count (9 by default).

const ROWS = Number(process.env.ALCOVE_STRESS_INTERRUPT_ROWS ?? 500_000);
const ATTEMPTS = Number(process.env.ALCOVE_STRESS_INTERRUPT_ATTEMPTS ?? 9);
// After the first live line, which is drawn a second into the operation;
// spread so the signal lands in different chunks.
const DELAYS_MS = [0, 1000, 3000];
const ATTEMPT_TIMEOUT_MS = 15 * 60_000;
const CTRL_C = "\x03";

const MASKING_LINE =
  /(?:encrypting my data|doubly-encrypting partner's data|identifying shared elements): [^\r\n]*elapsed/;

interface Party {
  child: ChildProcess;
  log: () => string;
  exited: Promise<number | null>;
}

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

function startParty(dir: string, drop: string): Party {
  const command = [
    process.execPath,
    CLI,
    "--no-record",
    `file://${drop}`,
    join(dir, "input.csv"),
    join(dir, "results"),
  ]
    .map(shellQuote)
    .join(" ");
  // A terminal with no size draws the live line at zero width, so empty.
  const child = spawn(
    "script",
    ["-qfec", `stty cols 200 rows 50; ${command}`, "/dev/null"],
    { cwd: dir, stdio: ["pipe", "pipe", "pipe"] },
  );
  // A Ctrl-C written after the party exited is dropped, not an error.
  child.stdin!.on("error", () => {});
  let log = "";
  child.stdout!.on("data", (chunk: Buffer) => (log += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (log += chunk.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", (code) => resolve(code)),
  );
  return { child, log: () => log, exited };
}

// Whether the last thing `party` wrote is a live line, so the operation it
// shows has not finished.
function drawingLiveLine(party: Party): boolean {
  const segments = party
    .log()
    .split(/[\r\n]/)
    .filter((segment) => segment.trim() !== "");
  return MASKING_LINE.test(segments.at(-1) ?? "");
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

test(
  `Ctrl-C during encryption at ${ROWS} records exits 130 on each of ${ATTEMPTS} attempts`,
  { timeout: ATTEMPTS * ATTEMPT_TIMEOUT_MS },
  async (ctx) => {
    ctx.skip(
      !existsSync(CLI),
      "the interrupt run drives the built CLI; run npm run build -w apps/cli",
    );
    ctx.skip(
      platform() !== "linux" || spawnSync("script", ["--version"]).status !== 0,
      "the interrupt run needs util-linux script(1) for a terminal",
    );
    const need = 2 * cliPartyNeedBytes(ROWS);
    const memory = hostMemory();
    ctx.skip(
      memory.bytes < need,
      `two parties of ${ROWS} records need about ` +
        `${(need / GB).toFixed(1)} GB; this host's ${memory.measure} is ` +
        `${(memory.bytes / GB).toFixed(1)} GB`,
    );
    const root = mkdtempSync(join(tmpdir(), "alcove-interrupt-"));
    const live: Array<ChildProcess> = [];
    try {
      const a = join(root, "a");
      const b = join(root, "b");
      for (const dir of [a, b]) mkdirSync(dir);
      await writeInput(join(a, "input.csv"), ROWS, 0);
      await writeInput(join(b, "input.csv"), ROWS, Math.floor(ROWS / 2));

      const outcomes: Array<string> = [];
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const drop = join(root, `drop-${attempt}`);
        mkdirSync(drop);
        const parties = [startParty(a, drop), startParty(b, drop)];
        live.push(...parties.map((party) => party.child));
        try {
          expect(
            await waitFor(
              () => parties.some((party) => MASKING_LINE.test(party.log())),
              ATTEMPT_TIMEOUT_MS,
            ),
          ).toBe(true);
          const target = parties.find((party) =>
            MASKING_LINE.test(party.log()),
          )!;
          const delayMs = DELAYS_MS[attempt % DELAYS_MS.length]!;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          const stillMasking = drawingLiveLine(target);
          const operation = target
            .log()
            .match(new RegExp(MASKING_LINE.source, "g"))!
            .at(-1)!;
          const signalledAt = performance.now();
          target.child.stdin!.write(CTRL_C);
          const code = await target.exited;
          const exitMs = Math.round(performance.now() - signalledAt);
          outcomes.push(
            `attempt ${attempt + 1}: Ctrl-C ${delayMs} ms after the first ` +
              `live line, at "${operation}"; exit ${code} ${exitMs} ms later`,
          );
          if (code !== 130) console.log(target.log().slice(-4000));
          expect(stillMasking).toBe(true);
          expect(code).toBe(130);
        } finally {
          for (const party of parties) {
            party.child.stdin!.write(CTRL_C);
            const force = setTimeout(() => party.child.kill("SIGKILL"), 60_000);
            await party.exited;
            clearTimeout(force);
          }
          rmSync(drop, { recursive: true, force: true });
        }
      }
      console.log(outcomes.join("\n"));
    } finally {
      for (const child of live)
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  },
);
