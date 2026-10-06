import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import logLibrary from "loglevel";
import type { Arguments } from "yargs";
import {
  getDefaultLinkageTerms,
  getLogger,
  inferMetadata,
  LinkageTermsUnsatisfiableError,
  sanitizeErrorForDisplay,
  UsageError,
} from "@alcove/core";

// The two steps an online invitation reaches after its linkage gate, spied so a
// refusal can be pinned as arriving before either: `runOnlineBootstrap` is the
// dial, and `prepareForOnlineExchange` holds the run-boundary grading whose
// refusal is stated on the agreed standing. Every other export is genuine.
vi.mock("../../../src/onlineBootstrap", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/onlineBootstrap")
  >("../../../src/onlineBootstrap");
  return {
    ...actual,
    runOnlineBootstrap: vi.fn(),
    prepareForOnlineExchange: vi.fn(actual.prepareForOnlineExchange),
  };
});

import {
  handler as inviteHandler,
  validateInvite,
} from "../../../src/commands/invite";
import {
  buildDataSpec,
  prepareForOnlineExchange,
  runOnlineBootstrap,
} from "../../../src/onlineBootstrap";
import type { CommonBootstrapOptions } from "../../../src/optionDefinitions";
import { streamOf, withStdin } from "../../stdinStream";
import { pathAsDisplayed } from "../../platformPaths";
import { captureProcessExit } from "../../exitCapture";

const silentLog = getLogger("online-mint-linkage-seat-test");
silentLog.setLevel("silent");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// A linkage column no built-in linkage key references (phone is opt-in only).
// The online mint derives its terms from the input's own columns, so the terms
// it would hold declare no linkage key at all -- the draft shortfall this path
// reaches.
const UNLINKABLE_CSV = "phone,memo\n555-0100,a memo\n";

function fixture(csv: string): {
  input: string;
  options: CommonBootstrapOptions;
} {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-online-mint-seat-"));
  tmpDirs.push(dir);
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(input, csv);
  return {
    input,
    options: {
      configFile: path.join(dir, "alcove.yaml"),
      keyFile: path.join(dir, ".alcove.key"),
      identity: "Agency A",
      record: false,
      eventStream: false,
      logLevel: logLibrary.levels.SILENT,
      verbosity: 0,
    },
  };
}

test("the online mint states a draft shortfall without claiming an agreement", async () => {
  const { input, options } = fixture(UNLINKABLE_CSV);
  let thrown: unknown;
  try {
    await validateInvite({
      resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
      options,
      acceptTimeout: 900,
      log: silentLog,
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(LinkageTermsUnsatisfiableError);
  // A UsageError subclass, so the CLI's error->exit boundary reports exit 64.
  expect(thrown).toBeInstanceOf(UsageError);
  // The refusal composes its tokens raw; render it the way the CLI's error
  // boundary does.
  const rendered = sanitizeErrorForDisplay(thrown);
  expect(rendered).toContain(
    "the input file's linkage terms declare no linkage key",
  );
  // The operator authored no terms document here, so the remedy is the one the
  // input side can act on, and it names the file the terms came from.
  expect(rendered).toContain(
    "To fix: provide a CSV that covers the required field types, then generate the " +
      "invitation again; these terms are derived from the CSV input " +
      `${pathAsDisplayed(input)}.`,
  );
  // Nobody has agreed to these terms and nobody has seen them, so the refusal
  // may neither call them agreed nor send the operator to renegotiate.
  expect(rendered).not.toContain("agree linkage terms");
  expect(rendered).not.toContain("agreed");
  expect(rendered).not.toContain("your partner");
  expect(rendered).not.toContain("out of band");
  // The same verdict is graded again inside prepareForExchange, at the run
  // boundary, where it is stated on the agreed standing. The mint refuses
  // first, so on this path that grading is never entered for a shortfall.
  expect(prepareForOnlineExchange).not.toHaveBeenCalled();
});

test("the online mint names the stdin source, not the `-` sentinel, when the input is piped", async () => {
  const { options } = fixture(UNLINKABLE_CSV);
  let thrown: unknown;
  try {
    await withStdin(streamOf(UNLINKABLE_CSV), () =>
      validateInvite({
        resolved: {
          mode: "online",
          url: new URL("sftp://host/drop"),
          input: "-",
        },
        options,
        acceptTimeout: 900,
        log: silentLog,
      }),
    );
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(LinkageTermsUnsatisfiableError);
  const rendered = sanitizeErrorForDisplay(thrown);
  // The input positional may be the stdin sentinel `-`; the remedy names what
  // it stands for rather than the sentinel itself.
  expect(rendered).toContain(
    "To fix: provide a CSV that covers the required field types, then generate the " +
      "invitation again; these terms are derived from the CSV read from " +
      "stdin.",
  );
  expect(rendered).not.toContain("derived from -.");
});

test("the refused online mint prints no invitation and opens no connection", async () => {
  const { input, options } = fixture(UNLINKABLE_CSV);
  // printInvitation is the one console.log this path makes, so an unused spy is
  // the whole statement that no token was disclosed.
  const printed = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = captureProcessExit();
  try {
    await expect(
      inviteHandler({
        _: [],
        $0: "alcove",
        identity: "Agency A",
        args: ["wss://peers.example.org/psi", input],
        "config-file": options.configFile,
        "key-file": options.keyFile,
        "log-level": "silent",
        record: false,
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64");
    expect(exit).toHaveBeenCalledWith(64);
    expect(printed).not.toHaveBeenCalled();
    expect(runOnlineBootstrap).not.toHaveBeenCalled();
  } finally {
    exit.mockRestore();
    printed.mockRestore();
  }
});

test("the run boundary keeps the agreed seat's words for the same grading", async () => {
  // The seat the online mint used to fall into. prepareForExchange grades every
  // run, whoever authored the terms, so its refusal counts the keys as agreed
  // and settles the shortfall out of band -- and it must keep doing so, or the
  // two seats have crossed again from the other side.
  const terms = getDefaultLinkageTerms(
    "Agency B",
    inferMetadata(["first_name", "last_name", "dob", "ssn"], []),
  );
  const rows = {
    rawRows: [{ first_name: "Alice", last_name: "Smith", dob: "1990-01-02" }],
    columns: ["first_name", "last_name", "dob"],
    sanitizedColumnPositions: [],
  };
  let thrown: unknown;
  try {
    prepareForOnlineExchange(
      buildDataSpec({ terms, identity: "Agency B", rows }),
      "Agency B",
      rows,
    );
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(LinkageTermsUnsatisfiableError);
  const rendered = sanitizeErrorForDisplay(thrown);
  expect(rendered).toContain(
    "this input cannot satisfy every linkage key the agreed terms declare",
  );
  expect(rendered).toContain("agreed linkage keys");
  expect(rendered).toContain("Agree new terms with your partner");
  expect(rendered).toContain("an input file that satisfies the current terms");
});
