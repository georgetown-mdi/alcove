import { join, relative } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { preRunTrustFooter, settledTrustFooter } from "@exchange/trustFooter";

const srcRoot = fileURLToPath(new URL("../../../src", import.meta.url));

// The directories holding the app's screens, where a copy of the footer text
// would be written; the protocol, job and utility code renders no screen.
const screenDirectories = [
  "components",
  "console",
  "exchange",
  "recurring",
  "routes",
];

function sourceFiles(dir: string): Array<string> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function filesContainingEach(
  fragments: ReadonlyArray<string>,
): Array<Array<string>> {
  const sources = screenDirectories
    .flatMap((directory) => sourceFiles(join(srcRoot, directory)))
    .map((path) => ({
      path: relative(srcRoot, path),
      text: readFileSync(path, "utf8"),
    }));
  return fragments.map((fragment) =>
    sources
      .filter((source) => source.text.includes(fragment))
      .map((source) => source.path),
  );
}

describe("the privacy footer", () => {
  test("states the pre-run assurance with the step that decides the send set", () => {
    expect(preRunTrustFooter(2)).toBe(
      "The fields you match on are encrypted on your machine before they leave it. " +
        "Your partner receives only the fields listed under 'you will send' " +
        "(step 2 above) and only for clients who are in common.",
    );
    expect(preRunTrustFooter(3)).toContain("(step 3 above)");
  });

  test("a server-driven run omits the this-browser sentence", () => {
    expect(settledTrustFooter(false)).toBe(
      "Your file never left this browser. The results above are all your " +
        "partner received about your data.",
    );
    expect(settledTrustFooter(true)).toBe(
      "The results above are all your partner received about your data.",
    );
  });

  test("its text is written in one source file", () => {
    const fragments = [
      "The fields you match on are encrypted on your machine",
      "never left this browser.",
      "all your partner received about your data",
    ];
    for (const files of filesContainingEach(fragments))
      expect(files).toEqual(["exchange/trustFooter.ts"]);
  });
});
