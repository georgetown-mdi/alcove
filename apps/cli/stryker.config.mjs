// Stryker configuration for mutation testing the CLI's accept command against
// the CLI unit tier: `npm run test:mutation:cli`, and nightly through
// .github/workflows/nightly_mutation.yaml. scripts/stryker-security.mjs reads
// both exports, as it does packages/core/stryker.config.mjs: `scoreFloors` is
// the corpus and each file's committed floor, the default export the Stryker
// configuration itself. The floor rules: docs/TESTING.md, The floors.
//
// Every path here is repository-root-relative: Stryker runs from the repository
// root so its vitest runner resolves vitest through the root package.json.

// Per-file mutation-score floors, in whole percent, measured on the commit that
// set them and rounded down; raised when tests raise the score, never lowered.
export const scoreFloors = {
  "apps/cli/src/commands/accept.ts": 75,
};

export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: {
    configFile: "apps/cli/vitest.stryker.config.mts",
    // As in the core configuration: related-test resolution fails inside the
    // sandbox copy, so the whole tier runs, narrowed per mutant by perTest.
    related: false,
  },
  mutate: Object.keys(scoreFloors),
  coverageAnalysis: "perTest",
  timeoutMS: 120000,
  timeoutFactor: 3,
  reporters: ["clear-text", "progress", "html", "json"],
};
