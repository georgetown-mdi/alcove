import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { warningSourceRows } from "@alcove/cli-contract";

import { RELAY_WARNING_SOURCES } from "@jobs/cliDriver";

const SPEC_PATH = fileURLToPath(
  new URL("../../../../../docs/spec/SERVER_JOB_API.md", import.meta.url),
);
const TABLE_HEADING = "### Warning sources on the job stream";

describe("the SERVER_JOB_API.md relay warning-source table", () => {
  const rows = warningSourceRows(
    readFileSync(SPEC_PATH, "utf8"),
    TABLE_HEADING,
  );

  it("lists exactly the values RELAY_WARNING_SOURCES declares, each once", () => {
    const listed = rows.map((row) => row.source);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...RELAY_WARNING_SOURCES].sort());
  });

  it("describes every value it lists", () => {
    expect(
      rows
        .filter((row) => row.description.replace(/\|/g, "").trim() === "")
        .map((row) => row.source),
    ).toEqual([]);
  });
});
