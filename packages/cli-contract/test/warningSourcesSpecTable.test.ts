import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { WARNING_SOURCES } from "../src/warningSources.js";

const SPEC_PATH = fileURLToPath(
  new URL("../../../docs/spec/CLI_EVENTS.md", import.meta.url),
);
const TABLE_HEADING = "#### Warning sources";

/** One body row of the spec table: its code-span key and its description. */
interface SpecTableRow {
  source: string;
  description: string;
}

/**
 * The body rows of the table under `heading`, keyed on the code span in the
 * first cell. Rows start past the alignment separator and stop at the next
 * heading.
 */
function specTableRows(text: string, heading: string): Array<SpecTableRow> {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) throw new Error(`no "${heading}" heading in ${SPEC_PATH}`);
  const rows: Array<SpecTableRow> = [];
  let inBody = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("#")) break;
    if (!line.trimStart().startsWith("|")) continue;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
      inBody = true;
      continue;
    }
    if (!inBody) continue;
    const [, first = "", ...rest] = line.split("|");
    const key = /^\s*`([^`]+)`\s*$/.exec(first);
    if (key === null) throw new Error(`a row without a code-span key: ${line}`);
    rows.push({ source: key[1], description: rest.join("|").trim() });
  }
  return rows;
}

describe("the CLI_EVENTS.md warning-source table", () => {
  const rows = specTableRows(readFileSync(SPEC_PATH, "utf8"), TABLE_HEADING);

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
