// Stryker configuration for mutation testing the CLI's accept command against
// the CLI unit tier. scripts/stryker-security.mjs reads only
// packages/core/stryker.config.mjs, so this one is run through a derived
// configuration that makes the vitest path absolute and moves the sandbox and
// reports out of the tree; the recipe is in docs/TESTING.md, Mutation testing.
//
// Every path here is repository-root-relative: Stryker runs from the repository
// root so its vitest runner resolves vitest through the root package.json.
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: {
    configFile: "apps/cli/vitest.stryker.config.mts",
    // As in the core configuration: related-test resolution fails inside the
    // sandbox copy, so the whole tier runs, narrowed per mutant by perTest.
    related: false,
  },
  mutate: ["apps/cli/src/commands/accept.ts"],
  coverageAnalysis: "perTest",
  timeoutMS: 120000,
  timeoutFactor: 3,
  reporters: ["clear-text", "progress", "html", "json"],
};
