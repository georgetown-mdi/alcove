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

test("unknownLongOptions accepts known, camelCase and --no- spellings", () => {
  const known = ["retain-files", "record", "log-level"];
  expect(
    unknownLongOptions(
      ["--retain-files", "--retainFiles", "--no-record", "--log-level=info"],
      known,
    ),
  ).toEqual([]);
});

test("unknownLongOptions names each unknown option once, with a suggestion", () => {
  expect(
    unknownLongOptions(
      ["--retain-file", "x", "--retain-file", "--zzzzzz"],
      ["retain-files"],
    ),
  ).toEqual([
    { option: "--retain-file", suggestion: "--retain-files" },
    { option: "--zzzzzz", suggestion: undefined },
  ]);
});

test("unknownLongOptions stops at a bare --", () => {
  expect(unknownLongOptions(["--", "--anything"], [])).toEqual([]);
});

test("unknownCommandMessage leaves anything that is not a bare word to the URL checks", () => {
  expect(unknownCommandMessage("sftp://host/path")).toBe(undefined);
  expect(unknownCommandMessage("./in.csv")).toBe(undefined);
  expect(unknownCommandMessage("invte")).toContain("'alcove invite'");
});
