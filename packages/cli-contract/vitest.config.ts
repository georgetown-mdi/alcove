import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default", "../../scripts/lib/skippedLegReporter.mjs"],
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
