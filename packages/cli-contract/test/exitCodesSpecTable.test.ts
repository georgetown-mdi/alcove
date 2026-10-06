import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EXIT_CODE_TABLE } from "../src/exitCodes.js";
import { warningSourceRows } from "../src/specTable.js";

const DOC_PATH = fileURLToPath(
  new URL("../../../docs/CLI.md", import.meta.url),
);
const TABLE_HEADING = "## Exit codes";

/** The cells after the code: name, meaning, and what to do. */
function cellsAfterCode(description: string): Array<string> {
  return description
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell, index, cells) => index < cells.length - 1 || cell !== "");
}

describe("the CLI.md exit-code table", () => {
  const rows = warningSourceRows(readFileSync(DOC_PATH, "utf8"), TABLE_HEADING);

  it("lists exactly the codes EXIT_CODE_TABLE declares, in its order", () => {
    expect(rows.map((row) => row.source)).toEqual(
      EXIT_CODE_TABLE.map((row) => String(row.code)),
    );
  });

  it("names each code as EXIT_CODE_TABLE does", () => {
    expect(
      rows.map((row) => cellsAfterCode(row.description)[0].replace(/`/g, "")),
    ).toEqual(EXIT_CODE_TABLE.map((row) => row.name));
  });

  it("states a meaning and an action for every code", () => {
    expect(
      rows
        .filter((row) => {
          const cells = cellsAfterCode(row.description);
          return cells.length !== 3 || cells.some((cell) => cell === "");
        })
        .map((row) => row.source),
    ).toEqual([]);
  });

  it("states a code Alcove does not set as not set by Alcove", () => {
    const platformCodes = EXIT_CODE_TABLE.filter(
      (row) => row.setBy === "platform",
    ).map((row) => String(row.code));
    expect(
      rows
        .filter((row) =>
          cellsAfterCode(row.description)[1].startsWith("Not set by Alcove"),
        )
        .map((row) => row.source),
    ).toEqual(platformCodes);
  });
});
