import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  expectSpecTableLists,
  specTableRows,
} from "@alcove/cli-contract/test-support";

import { RELAY_WARNING_SOURCES } from "@jobs/cliDriver";

const SPEC_PATH = fileURLToPath(
  new URL("../../../../../docs/spec/SERVER_JOB_API.md", import.meta.url),
);
const TABLE_HEADING = "### Warning sources on the job stream";

describe("the SERVER_JOB_API.md relay warning-source table", () => {
  it("lists exactly the values RELAY_WARNING_SOURCES declares, each once", () => {
    expectSpecTableLists(SPEC_PATH, TABLE_HEADING, RELAY_WARNING_SOURCES);
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
