import { readFileSync } from "node:fs";
import * as path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { buildCli } from "../../src/cliParser";
import { ZERO_SETUP_OPTION_GROUPS } from "../../src/commands/zeroSetup";
import { BARE_INVOCATION_SUMMARY, COMMAND_NAMES } from "../../src/usageHints";
import { captureProcessExit } from "../exitCapture";

afterEach(() => {
  vi.restoreAllMocks();
});

// Drive the real parser against a synthetic argv with process.exit trapped (so
// execution stops at the exit instead of tearing down the test runner) and the
// console captured. Returns the rejection message the trapped exit produced (e.g.
// "exit:64"), the captured stderr text, and the captured stdout/console.log text
// (where yargs prints --version and --help). No command handler runs in any case
// here: a strict-option failure fires before the handler, and --help/--version
// short-circuit, so this drives only the parser, not a real exchange.
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

test("a misspelled option on the zero-setup command exits 64, naming the option", async () => {
  const { exit, stderr } = await parse([
    "--server-user",
    "u",
    "sftp://h/p",
    "in.csv",
    "out.csv",
  ]);
  expect(exit).toBe("exit:64");
  expect(stderr).toContain(
    "Unknown option --server-user; did you mean --server-username?",
  );
  expect(stderr).toContain("Run with --help");
});

test("a misspelled option on a subcommand exits 64, naming the option", async () => {
  const { exit, stderr } = await parse(["exchange", "in.csv", "--retain-file"]);
  expect(exit).toBe("exit:64");
  expect(stderr).toContain(
    "Unknown option --retain-file; did you mean --retain-files?",
  );
});

test("an unknown option is named ahead of the positional it took as its value", async () => {
  // yargs gives the unknown --retain-file the next token as its value, which
  // leaves `exchange` short of its required INPUT_FILE -- a fault yargs
  // reports before it checks options.
  const { exit, stderr } = await parse(["exchange", "--retain-file", "in.csv"]);
  expect(exit).toBe("exit:64");
  expect(stderr).toContain(
    "Unknown option --retain-file; did you mean --retain-files?",
  );
  expect(stderr).not.toContain("non-option arguments");
});

test("an unknown option on a command taking `-`-leading positionals is named with a suggestion", async () => {
  const { exit, stderr } = await parse(["invite", "--identiy", "Org"]);
  expect(exit).toBe("exit:64");
  expect(stderr).toContain(
    "Unknown option --identiy; did you mean --identity?",
  );
});

test("an unknown option with nothing close is named without a suggestion", async () => {
  const { exit, stderr } = await parse(["exchange", "in.csv", "--zzzzzz"]);
  expect(exit).toBe("exit:64");
  expect(stderr).toContain("Unknown option --zzzzzz.");
  expect(stderr).not.toContain("did you mean");
});

test("a bare `alcove` prints the common tasks and exits 64", async () => {
  const { exit, stderr } = await parse([]);
  expect(exit).toBe("exit:64");
  expect(stderr).toBe(BARE_INVOCATION_SUMMARY);
});

test("a mistyped command exits 64, naming the command it is closest to", async () => {
  const { exit, stderr } = await parse(["exchnage", "in.csv"]);
  expect(exit).toBe("exit:64");
  expect(stderr).toContain(
    "'exchnage' is not an alcove command; did you mean 'alcove exchange'?",
  );
});

test("the unknown-argument message is routed through the display sanitizer", async () => {
  // A control byte in an option token must never reach the terminal raw (it could
  // drive an ANSI/escape sequence): the message is printed through
  // sanitizeForDisplay, which escapes the ESC (U+001B) to a visible `\x1b`. Build
  // the ESC with fromCharCode so no raw control byte lives in this source file.
  const esc = String.fromCharCode(0x1b);
  const { exit, stderr } = await parse([
    "exchange",
    "in.csv",
    `--foo${esc}bar`,
  ]);
  expect(exit).toBe("exit:64");
  expect(stderr).not.toContain(esc);
  expect(stderr).toContain("\\x1b");
});

test("--help short-circuits without a strict-option failure", async () => {
  // A known path (help) is not swept up by strictOptions: it exits 0 and prints no
  // unknown-argument error, confirming the check does not false-fire.
  const { exit, stderr } = await parse(["exchange", "--help"]);
  expect(exit).toBe("exit:0");
  expect(stderr).not.toContain("Unknown arguments");
});

test("--version prints the CLI's own package version, not yargs' walk-up guess", async () => {
  // yargs' default .version() heuristic walks up from ITS OWN install directory,
  // which in this npm-workspaces monorepo resolves to the repo root's package.json
  // (version 0.0.0), not apps/cli/package.json.
  const { name, version } = JSON.parse(
    readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
  ) as { name: string; version: string };
  expect(name).toBe("alcove");
  expect(version).not.toBe("0.0.0");

  const { exit, stdout } = await parse(["--version"]);
  expect(exit).toBe("exit:0");
  expect(stdout.trim()).toBe(version);
});

test("`doctor` on its own demands one of its checks rather than running", async () => {
  // It is registered with a builder and no handler, so the only thing standing
  // between a bare `alcove doctor` and a silent no-op is this demand.
  const { exit, stderr } = await parse(["doctor"]);
  expect(exit).toBe("exit:64");
  expect(stderr).toContain("doctor probe");
});

test("`doctor mount` demands the directory it is to check", async () => {
  const { exit } = await parse(["doctor", "mount"]);
  expect(exit).toBe("exit:64");
});

test("a misspelled option on a doctor check exits 64, naming the option", async () => {
  const { exit, stderr } = await parse(["doctor", "probe", "--jsonn"]);
  expect(exit).toBe("exit:64");
  expect(stderr).toContain("jsonn");
});

test("top-level help lists the commands before any option", async () => {
  const { exit, stdout } = await parse(["--help"]);
  expect(exit).toBe("exit:0");
  const commandsAt = stdout.indexOf("\nCommands:\n");
  expect(commandsAt).toBeGreaterThan(-1);
  expect(stdout.search(/^\s+-/m)).toBeGreaterThan(commandsAt);
});

test("top-level help lists exactly the commands a mistyped name is matched against", async () => {
  const { stdout } = await parse(["--help"]);
  const listed = [...stdout.matchAll(/^ {2}alcove ([a-z-]+)/gm)].map(
    (match) => match[1],
  );
  expect(listed).toEqual(COMMAND_NAMES);
});

test("top-level help puts every quick-exchange option in a named group", async () => {
  const { stdout } = await parse(["--help"]);
  const optionsSection = /\nOptions:\n([\s\S]*?)(\n\n|$)/.exec(stdout);
  expect(optionsSection).not.toBeNull();
  const ungrouped = [...optionsSection![1].matchAll(/--([a-z-]+)/g)].map(
    (match) => match[1],
  );
  expect(ungrouped.sort()).toEqual(["help", "version"]);
  for (const [heading] of ZERO_SETUP_OPTION_GROUPS)
    expect(stdout).toContain(`\n${heading}\n`);
});

test.each(COMMAND_NAMES)(
  "`%s --help` describes the command beneath its usage line",
  async (command) => {
    const { exit, stdout } = await parse([command, "--help"]);
    expect(exit).toBe("exit:0");
    const [usage, description] = stdout.split("\n\n");
    expect(usage).toContain(`alcove ${command}`);
    expect(description).toBeDefined();
    expect(description).not.toMatch(/^(Positionals|Options|Commands):/);
  },
);

test("`--retain-files` help states that it turns the options it needs on", async () => {
  for (const command of [[], ["exchange"], ["invite"], ["accept"]]) {
    const { stdout } = await parse([...command, "--help"]);
    const flat = stdout.replace(/\s+/g, " ");
    expect(flat).toContain(
      "Turns on --timestamp-in-filename and --lockless-rendezvous",
    );
    expect(flat).not.toContain("Requires --timestamp-in-filename");
  }
});

test("`doctor probe --help` names the environment variables it reads", async () => {
  const { stdout } = await parse(["doctor", "probe", "--help"]);
  const flat = stdout.replace(/\s+/g, " ");
  for (const variable of ["SMB_SERVER", "SMB_SHARE", "SMB_USER"])
    expect(flat).toContain(variable);
});
