import fs from "node:fs";

import { REAL_PROBE_DEPS, runProbe } from "../src/doctor/probe";
import type { CommandResult, CommandRunner } from "../src/doctor/runner";
import { nodeCommandRunner } from "../src/doctor/runner";
import { readSmbProbeInput } from "../src/doctor/smbEnvironment";

/**
 * A doctor probe run against the real Samba server of the `smb-doctor` CI job
 * (.github/workflows/cli_build_and_test.yaml), interrupted by a real SIGINT
 * once its put has landed. Before the signal it adds the renamed probe file
 * and a set of names the cleanup's mask must not match, so the job can check
 * that the one masked delete removed both probe files and nothing else.
 * Reads the `SMB_*` variables `doctor probe` reads; `SMB_TOKEN` is required.
 * Prints `credentials <path>` and one `kept <name>` line per name that must
 * survive, then is expected to die of the SIGINT. Exits 1 if the setup did
 * not land, so the job never checks an empty share.
 */

const input = readSmbProbeInput(process.env);
if (input.token === "") throw new Error("set SMB_TOKEN for this run");

const probeName = `alcove-probe-${input.token}.tmp`;
const probeNames = [probeName, `${probeName}.renamed`];
const keptNames = [
  `alcove-probe-${input.token}x.tmp`,
  "alcove-probe-otherrun.tmp",
  `x-${probeName}`,
  `alcove-probe-${input.token}.tm`,
  "alcove-check.txt",
];

const report = (line: string): void => {
  fs.writeSync(1, `${line}\n`);
};

function fail(message: string, result: CommandResult): never {
  fs.writeSync(2, `${message}\n${result.output}\n`);
  process.exit(1);
}

/** The same smbclient arguments with `command` in place of the `-c` value. */
function withCommand(args: string[], command: string): string[] {
  const index = args.indexOf("-c");
  return [...args.slice(0, index + 1), command, ...args.slice(index + 2)];
}

const runner: CommandRunner = {
  async run(file, args, options): Promise<CommandResult> {
    const command = args[args.indexOf("-c") + 1];
    if (command !== `put ${probeName} ${probeName}`)
      return nodeCommandRunner.run(file, args, options);

    const put = await nodeCommandRunner.run(file, args, options);
    if (put.code !== 0) fail("the probe file put failed", put);
    const extra = [...probeNames.slice(1), ...keptNames]
      .map((name) => `put ${probeName} ${name}`)
      .join("; ");
    const seeded = await nodeCommandRunner.run(
      file,
      withCommand(args, extra),
      options,
    );
    if (seeded.code !== 0) fail("adding the extra names failed", seeded);
    const listed = await nodeCommandRunner.run(
      file,
      withCommand(args, "ls"),
      options,
    );
    const listedLines = listed.output.split("\n").map((line) => line.trim());
    for (const name of [...probeNames, ...keptNames])
      if (!listedLines.some((line) => line.startsWith(`${name} `)))
        fail(`${name} is not on the share before the interrupt`, listed);

    report(`credentials ${args[args.indexOf("-A") + 1] ?? ""}`);
    for (const name of keptNames) report(`kept ${name}`);
    // Resolved by a listener added after the probe's own, so the probe has
    // taken the signal by the time the put it interrupted ends. Signal
    // handles do not hold the event loop open, so a timer does until then.
    const holdOpen = setInterval(() => undefined, 1000);
    const ended = new Promise<CommandResult>((resolve) =>
      process.once("SIGINT", () => {
        clearInterval(holdOpen);
        resolve(put);
      }),
    );
    process.kill(process.pid, "SIGINT");
    return ended;
  },
};

void runProbe(input, { ...REAL_PROBE_DEPS, runner }).catch(() => undefined);
