import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The sources and tests import `@alcove/core`, which resolves to core's
    // built dist, and no `pretest` rebuilds it: the guard fails the run before
    // any test when that dist is missing or older than core's sources.
    globalSetup: ["../../scripts/lib/coreDistFreshness.mjs"],
    reporters: [
      "default",
      "../../scripts/lib/skippedLegReporter.mjs",
      "../../scripts/lib/jsonReportReporter.mjs",
    ],
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
        },
      },
    ],
  },
});
