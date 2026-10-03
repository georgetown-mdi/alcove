import { expect, test } from "vitest";

import {
  closestMatch,
  editDistance,
  unknownCommandMessage,
  unknownLongOptions,
} from "../../src/usageHints";

test("editDistance counts single-character edits", () => {
  expect(editDistance("exchange", "exchange")).toBe(0);
  expect(editDistance("exchnage", "exchange")).toBe(2);
  expect(editDistance("", "abc")).toBe(3);
});

test("closestMatch prefers the only candidate the word begins", () => {
  expect(closestMatch("server-user", ["server-username", "server-port"])).toBe(
    "server-username",
  );
});

test("closestMatch suggests nothing for an ambiguous prefix or a tie", () => {
  expect(closestMatch("server", ["server-port", "server-username"])).toBe(
    undefined,
  );
  expect(closestMatch("ab", ["ac", "bb"])).toBe(undefined);
});

test("closestMatch suggests nothing past two edits", () => {
  expect(closestMatch("zzzzzz", ["exchange", "invite"])).toBe(undefined);
});

test("unknownLongOptions accepts known keys and yargs' camelCase copies", () => {
  const known = ["retain-files", "record", "log-level"];
  expect(
    unknownLongOptions(
      {
        _: ["exchange"],
        $0: "alcove",
        "--": ["--anything"],
        "retain-files": true,
        retainFiles: true,
        record: false,
        "log-level": "info",
        logLevel: "info",
      },
      known,
    ),
  ).toEqual([]);
});

test("unknownLongOptions names each unknown key once, with a suggestion", () => {
  expect(
    unknownLongOptions(
      { _: [], "retain-file": "x", retainFile: "x", zzzzzz: true },
      ["retain-files"],
    ),
  ).toEqual([
    { option: "--retain-file", suggestion: "--retain-files" },
    { option: "--zzzzzz", suggestion: undefined },
  ]);
});

test("unknownLongOptions reads a value yargs gave a known option as that value", () => {
  expect(
    unknownLongOptions({ _: [], "server-password": "--abc" }, [
      "server-password",
    ]),
  ).toEqual([]);
});

test("unknownLongOptions names a `--` token in the args positional, not one in `_`", () => {
  expect(
    unknownLongOptions(
      { _: ["accept", "--after-separator"], args: ["--identiy=x", "-AbC"] },
      ["identity", "args"],
    ),
  ).toEqual([{ option: "--identiy", suggestion: "--identity" }]);
});

test("unknownLongOptions leaves a one-character key to yargs", () => {
  expect(unknownLongOptions({ _: [], x: true }, [])).toEqual([]);
});

test("unknownCommandMessage leaves anything that is not a bare word to the URL checks", () => {
  expect(unknownCommandMessage("sftp://host/path")).toBe(undefined);
  expect(unknownCommandMessage("./in.csv")).toBe(undefined);
  expect(unknownCommandMessage("invte")).toContain("'alcove invite'");
});
