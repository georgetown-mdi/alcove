import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The sources and tests import `@alcove/core`, which resolves to core's
    // built dist, and no `pretest` rebuilds it: the guard fails the run before
    // any test when that dist is missing or older than core's sources. The
    // certificate guard fails a CI run in which the HTTPS legs would skip.
    globalSetup: [
      "../../scripts/lib/coreDistFreshness.mjs",
      "./test/requireLoopbackTlsCert.ts",
    ],
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
          environment: "node",
          // Above the default so a CPU-bound case still finishes when other
          // suites share the machine.
          testTimeout: 10_000,
        },
      },
    ],
  },
});
