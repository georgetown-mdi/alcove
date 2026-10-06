import { join, relative } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { preRunTrustFooter, settledTrustFooter } from "@exchange/trustFooter";

const srcRoot = fileURLToPath(new URL("../../../src", import.meta.url));

function sourceFiles(dir: string): Array<string> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function filesContaining(fragment: string): Array<string> {
  return sourceFiles(srcRoot)
    .filter((path) => readFileSync(path, "utf8").includes(fragment))
    .map((path) => relative(srcRoot, path));
}

describe("the privacy footer", () => {
  test("states the pre-run assurance with the step that decides the send set", () => {
    expect(preRunTrustFooter(2)).toBe(
      "PII for linkage is encrypted locally before leaving your machine. " +
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
    for (const fragment of [
      "PII for linkage is encrypted locally",
      "never left this browser.",
      "all your partner received about your data",
    ])
      expect(filesContaining(fragment)).toEqual(["exchange/trustFooter.ts"]);
  });
});
