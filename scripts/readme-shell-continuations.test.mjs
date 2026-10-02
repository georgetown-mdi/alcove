import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { fencedBlocks } from "./lib/markdownFences.mjs";

// A shell line ending in a backslash and then a space does not continue: the
// pasted command ends there and the next line runs on its own.
test("no sh fence line in README.md ends in a backslash followed by whitespace", () => {
  const readme = readFileSync(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  );
  const broken = fencedBlocks(readme)
    .filter((block) => block.language === "sh")
    .flatMap(({ code, startLine }) =>
      code
        .split("\n")
        .flatMap((line, index) =>
          /\\[ \t]+$/.test(line) ? [`README.md:${startLine + index}`] : [],
        ),
    );
  expect(broken).toEqual([]);
});
