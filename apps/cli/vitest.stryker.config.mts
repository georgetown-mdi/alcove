import { configDefaults, defineConfig } from "vitest/config";

import { widenStrykerTestNamePattern } from "../../packages/core/vitest.stryker.config";

// Vitest configuration for mutation testing the CLI (apps/cli/stryker.config.mjs)
// only. Stryker roots vitest at the sandbox ROOT, so globs are
// repository-root-relative, and the `projects` array of vitest.config.mts is
// flattened to the unit tier, the one tier that needs no SFTP server or broker.
// The test-name plugin is core's: packages/core/vitest.stryker.config.ts says
// why nested tests kill nothing without it.
export default defineConfig({
  plugins: [widenStrykerTestNamePattern],
  test: {
    include: ["apps/cli/test/unit/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // Stryker's vitest runner forces the threads pool, where process.chdir
    // and process.umask throw; these files call one or the other and none
    // imports src/commands/accept.ts.
    exclude: [
      ...configDefaults.exclude,
      "apps/cli/test/unit/commands/fingerprint.test.ts",
      "apps/cli/test/unit/commands/logLevelImportTimeLoggers.test.ts",
      "apps/cli/test/unit/commands/stdoutPurity.test.ts",
      "apps/cli/test/unit/fileUtils.test.ts",
      "apps/cli/test/unit/util/atSignRefs.test.ts",
      "apps/cli/test/unit/util/cli.test.ts",
    ],
  },
});
