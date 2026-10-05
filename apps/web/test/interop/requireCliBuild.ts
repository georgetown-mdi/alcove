import { cliEntry, cliIsBuilt } from "./cliParty";

export const CLI_BUILD_COMMAND = "npm run build -w apps/cli";

export default function setup(): void {
  if (cliIsBuilt) return;
  throw new Error(
    `No CLI build at ${cliEntry}, so the interop suites cannot run, and skipping them would report a pass ` +
      `with no tests executed. Build it first with \`${CLI_BUILD_COMMAND}\`.`,
  );
}
