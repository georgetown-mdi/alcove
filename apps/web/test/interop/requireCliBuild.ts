import { cliEntry, cliIsBuilt } from "./cliParty.js";

export const CLI_BUILD_COMMAND = "npm run build -w apps/cli";

// A globalSetup on the `interop` project: the suites there gate on cliIsBuilt,
// so without this guard a run with no CLI build reports a pass with zero tests
// executed. CI builds the CLI first (eb_build_and_test.yaml), so this only
// fires on a local run against a tree that has not built it.
export default function setup(): void {
  if (cliIsBuilt) return;
  throw new Error(
    `No CLI build at ${cliEntry}, so the interop suites would skip and this ` +
      `run would report a pass with no tests executed. Build it first with ` +
      `\`${CLI_BUILD_COMMAND}\`.`,
  );
}
