import { describe, expect, it } from "vitest";

import { CRON_EXPORT_OUTPUT_FILE_NAME } from "../../../src/psi/managed/managedCronExport";
import { JOB_FILE_NAMES } from "../../../src/jobs/intentSchemas";

describe("the scheduled-run output name", () => {
  it("is the console's result file name", () => {
    expect(CRON_EXPORT_OUTPUT_FILE_NAME).toBe(JOB_FILE_NAMES.output);
  });
});
