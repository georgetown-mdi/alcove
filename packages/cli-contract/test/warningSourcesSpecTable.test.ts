import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { expectSpecTableLists, specTableRows } from "../src/testSupport.js";
import { WARNING_SOURCES } from "../src/warningSources.js";

const SPEC_PATH = fileURLToPath(
  new URL("../../../docs/spec/CLI_EVENTS.md", import.meta.url),
);
const TABLE_HEADING = "#### Warning sources";

describe("the CLI_EVENTS.md warning-source table", () => {
  it("lists exactly the values WARNING_SOURCES declares, each once", () => {
    expectSpecTableLists(SPEC_PATH, TABLE_HEADING, WARNING_SOURCES);
  });

  it("describes every value it lists", () => {
    const rows = specTableRows(readFileSync(SPEC_PATH, "utf8"), TABLE_HEADING);
    expect(
      rows
        .filter((row) => row.description.replace(/\|/g, "").trim() === "")
        .map((row) => row.source),
    ).toEqual([]);
  });
});
