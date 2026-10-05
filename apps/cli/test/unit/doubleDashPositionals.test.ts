import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";

import { buildCli } from "../../src/cliParser";
import { positionalsBeforeDoubleDash } from "../../src/util/doubleDash";
import { captureProcessExit } from "../exitCapture";

afterEach(() => {
  vi.restoreAllMocks();
});

class StopBeforeHandler extends Error {}

// Drive the real parser and stop at a middleware appended after the CLI's own,
// which runs once validation and the unknown-option scan have passed and before
// any command handler, so no exchange or file access runs.
async function parsedArgv(
  argv: string[],
): Promise<{ parsed: Arguments | undefined; exit: string; stderr: string }> {
  const stderr: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
  captureProcessExit();
  let parsed: Arguments | undefined;
  let exit = "";
  try {
    await buildCli(argv)
      .middleware((reached) => {
        parsed = reached;
        throw new StopBeforeHandler();
      })
      .parseAsync();
  } catch (err) {
    if (!(err instanceof StopBeforeHandler))
      exit = err instanceof Error ? err.message : String(err);
  }
  return { parsed, exit, stderr: stderr.join("\n") };
}

test("exchange reads INPUT and OUTPUT after `--`, where it exited 64 for want of an INPUT", async () => {
  const { parsed, exit, stderr } = await parsedArgv([
    "exchange",
    "--config-file",
    "alcove.yaml",
    "--",
    "-in.csv",
    "-out",
  ]);
  expect(stderr).not.toContain("non-option arguments");
  expect(exit).toBe("");
  expect(parsed?.["input"]).toBe("-in.csv");
  expect(parsed?.["output"]).toBe("-out");
  expect(parsed?.["config-file"]).toBe("alcove.yaml");
});

test("exchange fills OUTPUT from after `--` when INPUT comes before it", async () => {
  const { parsed } = await parsedArgv(["exchange", "in.csv", "--", "-out"]);
  expect(parsed?.["input"]).toBe("in.csv");
  expect(parsed?.["output"]).toBe("-out");
});

test("exchange with no INPUT before or after `--` exits 64 naming it", async () => {
  for (const argv of [["exchange"], ["exchange", "--"]]) {
    const { parsed, exit, stderr } = await parsedArgv(argv);
    expect(parsed).toBeUndefined();
    expect(exit).toBe("exit:64");
    expect(stderr).toContain("Missing required argument: input");
  }
});

test("verify-receipt reads its three paths after `--`", async () => {
  const { parsed, exit } = await parsedArgv([
    "verify-receipt",
    "--",
    "-record.json",
    "-in.csv",
    "-out.csv",
  ]);
  expect(exit).toBe("");
  expect(parsed?.["record"]).toBe("-record.json");
  expect(parsed?.["input-file"]).toBe("-in.csv");
  expect(parsed?.["inputFile"]).toBe("-in.csv");
  expect(parsed?.["result-file"]).toBe("-out.csv");
});

test("verify-receipt with no record exits 64 naming it", async () => {
  const { exit, stderr } = await parsedArgv(["verify-receipt", "--"]);
  expect(exit).toBe("exit:64");
  expect(stderr).toContain("Missing required argument: record");
});

test("probe-host-key reads its URL after `--`", async () => {
  const { parsed, exit } = await parsedArgv([
    "probe-host-key",
    "--",
    "-sftp://h",
  ]);
  expect(exit).toBe("");
  expect(parsed?.["sftp-url"]).toBe("-sftp://h");
});

test("doctor mount reads its directory after `--`", async () => {
  const { parsed, exit } = await parsedArgv(["doctor", "mount", "--", "-dir"]);
  expect(exit).toBe("");
  expect(parsed?.["directory"]).toBe("-dir");
});

test("doctor mount with no directory after `--` exits 64 naming it", async () => {
  const { exit, stderr } = await parsedArgv(["doctor", "mount", "--"]);
  expect(exit).toBe("exit:64");
  expect(stderr).toContain("Missing required argument: directory");
});

test.each([
  ["init", ["sftp://h/p", "-in.csv"]],
  ["invite", ["sftp://h/p", "-in.csv", "-out"]],
  ["accept", ["-invitation", "-in.csv", "-out"]],
  ["apply", ["-update"]],
])(
  "%s appends the tokens after `--` to its positionals",
  async (command, after) => {
    const { parsed, exit } = await parsedArgv([command, "--", ...after]);
    expect(exit).toBe("");
    expect(parsed?.["args"]).toEqual(after);
  },
);

test("a `--`-leading path after `--` is a positional, not an unknown option", async () => {
  const { parsed, exit, stderr } = await parsedArgv([
    "accept",
    "invitation",
    "--",
    "--in.csv",
  ]);
  expect(exit).toBe("");
  expect(stderr).not.toContain("Unknown option");
  expect(parsed?.["args"]).toEqual(["invitation", "--in.csv"]);
  expect(
    positionalsBeforeDoubleDash(parsed!, parsed?.["args"] as unknown[]),
  ).toEqual(["invitation"]);
});

test("a `--`-leading token before `--` is still refused as an unknown option", async () => {
  const { exit, stderr } = await parsedArgv([
    "accept",
    "--in.csv",
    "--",
    "-out",
  ]);
  expect(exit).toBe("exit:64");
  expect(stderr).toContain("Unknown option --in.csv");
});

// yargs counts a `<required>` positional before the middleware that places the
// tokens after `--` runs, so a command declared that way exits 64 on them.
test("no command declares a `<required>` positional", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const printed: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
  captureProcessExit();
  for (const argv of [["--help"], ["doctor", "--help"]]) {
    let exit = "";
    try {
      await buildCli(argv).parseAsync();
    } catch (err) {
      exit = err instanceof Error ? err.message : String(err);
    }
    expect(exit).toBe("exit:0");
  }
  const declarations = printed
    .join("\n")
    .split("\n")
    .filter((line) => /^ {2}alcove [a-z]/.test(line))
    .map((line) => line.trim().split(/\s{2,}/)[0]);
  expect(declarations).toContain("alcove exchange [input] [output]");
  expect(declarations).toContain("alcove doctor mount [directory]");
  expect(declarations.filter((line) => line.includes("<"))).toEqual([]);
});

test("the quick exchange reads its URL and paths after `--`", async () => {
  const { parsed, exit } = await parsedArgv([
    "--",
    "sftp://h/p",
    "-in.csv",
    "-out",
  ]);
  expect(exit).toBe("");
  expect(parsed?._).toEqual(["sftp://h/p", "-in.csv", "-out"]);
});

// Run the command's own handler, which reads the count of positionals given
// before `--` from the parsed argv: a handler handed a different argv object
// than the middleware set it on would refuse the `--`-leading path as an
// unknown argument.
async function handlerRun(
  argv: string[],
): Promise<{ exit: string; stderr: string }> {
  const stderr: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  captureProcessExit();
  let exit = "";
  try {
    await buildCli(argv).parseAsync();
  } catch (err) {
    exit = err instanceof Error ? err.message : String(err);
  }
  return { exit, stderr: stderr.join("\n") };
}

test("accept's handler takes `--`-leading paths after `--` as its input and output", async () => {
  expect(process.stdin.isTTY).toBeFalsy();
  const { exit, stderr } = await handlerRun([
    "accept",
    "invitation",
    "--",
    "--in.csv",
    "--out",
  ]);
  expect(stderr).not.toContain("Unknown argument");
  expect(stderr).toContain("standard input is not a terminal");
  expect(exit).toBe("exit:64");
});

test("apply's handler takes a `--`-leading update after `--`", async () => {
  const missingConfig = join(tmpdir(), `alcove-absent-${randomUUID()}.yaml`);
  const { exit, stderr } = await handlerRun([
    "apply",
    "--config-file",
    missingConfig,
    "--",
    "--update",
  ]);
  expect(stderr).not.toContain("Unknown argument");
  expect(stderr).toContain(missingConfig);
  expect(exit).not.toBe("");
});
