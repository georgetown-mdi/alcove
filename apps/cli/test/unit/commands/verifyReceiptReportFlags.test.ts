import { readFileSync } from "node:fs";
import * as path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { buildCli } from "../../../src/cliParser";
import { captureProcessExit } from "../../exitCapture";

afterEach(() => {
  vi.restoreAllMocks();
});

// Drive the real parser with process.exit trapped and the console captured, as
// cliParser.test.ts does.
async function parse(
  argv: string[],
): Promise<{ exit: string; stderr: string; stdout: string }> {
  const stderr: string[] = [];
  const stdout: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  });
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
  captureProcessExit();
  let exit = "";
  try {
    await buildCli(argv).parseAsync();
  } catch (err) {
    exit = err instanceof Error ? err.message : String(err);
  }
  return { exit, stderr: stderr.join("\n"), stdout: stdout.join("\n") };
}

const SOURCE = readFileSync(
  path.join(__dirname, "../../../src/commands/verifyReceipt.ts"),
  "utf8",
);

// Every `--flag` the command's own string literals name: its report lines,
// warnings, refusals and help text. Comments are left out, since a reader
// never sees them.
function flagsTheCommandNames(): string[] {
  const literals = SOURCE.replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "").match(
    /"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
  );
  const flags = new Set<string>();
  for (const literal of literals ?? [])
    for (const match of literal.matchAll(/(?<![\w-])--[a-z][a-z-]*/g))
      flags.add(match[0]);
  return [...flags].sort();
}

async function optionsHelp(): Promise<string> {
  const { exit, stdout } = await parse(["verify-receipt", "--help"]);
  expect(exit).toBe("exit:0");
  const options = stdout.split("\nOptions:\n")[1];
  expect(options).toBeDefined();
  return options!;
}

test("every flag the verify-receipt report names is an option its help lists", async () => {
  const options = await optionsHelp();
  const named = flagsTheCommandNames();
  expect(named.length).toBeGreaterThan(0);
  for (const flag of named) expect(options).toContain(`${flag} `);
});

test.each(["--input-file", "--result-file"])(
  "yargs takes %s for the positional, but help lists no such option, so the report names neither",
  async (flag) => {
    // yargs fills the positional from the same-named flag, so the run passes
    // option parsing and stops at the command's own both-or-neither check;
    // the flag still appears nowhere in help for an operator to find.
    const { exit, stderr } = await parse([
      "verify-receipt",
      path.join(__dirname, "no-such-record.json"),
      flag,
      "x.csv",
    ]);
    expect(exit).toBe("exit:64");
    expect(stderr).not.toContain("Unknown option");
    expect(await optionsHelp()).not.toContain(flag);
    expect(flagsTheCommandNames()).not.toContain(flag);
  },
);
