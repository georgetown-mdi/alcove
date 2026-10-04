import { describe, expect, it } from "vitest";

import { CRON_EXPORT_OUTPUT_FOLDER } from "../../../src/psi/managed/managedCronExport";
import { HANDOFF_OUTPUT_FOLDER } from "../../../src/jobs/handoff";

describe("the scheduled-run output", () => {
  it("is the console hand-off's output, a folder the CLI names each run's result in", () => {
    expect(CRON_EXPORT_OUTPUT_FOLDER).toBe(HANDOFF_OUTPUT_FOLDER);
    expect(HANDOFF_OUTPUT_FOLDER.endsWith("/")).toBe(true);
  });
});
