import { configDefaults, defineConfig } from "vitest/config";

// Vitest configuration for mutation testing the CLI (apps/cli/stryker.config.mjs)
// only. Stryker roots vitest at the sandbox ROOT, so globs are
// repository-root-relative, and the `projects` array of vitest.config.mts is
// flattened to the unit tier, the one tier that needs no SFTP server or broker.

// Mirrors packages/core/vitest.stryker.config.ts, which says why nested tests
// kill nothing without it.
const widenStrykerTestNamePattern = {
  name: "alcove-stryker-test-name-pattern",
  configureVitest({
    vitest,
  }: {
    vitest: { config: { testNamePattern?: RegExp } };
  }) {
    let pattern = vitest.config.testNamePattern;
    Object.defineProperty(vitest.config, "testNamePattern", {
      configurable: true,
      enumerable: true,
      get: () => pattern,
      set: (value: RegExp | undefined) => {
        pattern =
          value === undefined
            ? value
            : new RegExp(
                value.source.replaceAll(" ", "(?: > | )"),
                value.flags,
              );
      },
    });
  },
};

export default defineConfig({
  plugins: [widenStrykerTestNamePattern],
  test: {
    include: ["apps/cli/test/unit/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // Stryker's vitest runner forces the threads pool, where process.chdir
    // and process.umask throw and a worker's os.homedir() ignores a changed
    // process.env.HOME. Each file below calls chdir or umask, except
    // atSignRefs.test.ts, which points HOME at a temp dir for tilde
    // expansion; none imports src/commands/accept.ts.
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
