import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { warningSourceRows } from "../src/specTable.js";
import { WARNING_SOURCES } from "../src/warningSources.js";

const SPEC_PATH = fileURLToPath(
  new URL("../../../docs/spec/CLI_EVENTS.md", import.meta.url),
);
const TABLE_HEADING = "#### Warning sources";

describe("the CLI_EVENTS.md warning-source table", () => {
  const rows = warningSourceRows(
    readFileSync(SPEC_PATH, "utf8"),
    TABLE_HEADING,
  );

  it("lists exactly the values WARNING_SOURCES declares, each once", () => {
    const listed = rows.map((row) => row.source);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...WARNING_SOURCES].sort());
  });

  it("describes every value it lists", () => {
    expect(
      rows
        .filter((row) => row.description.replace(/\|/g, "").trim() === "")
        .map((row) => row.source),
    ).toEqual([]);
  });
});
