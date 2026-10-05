import {
  ALLOW_MISSING_BUILD_ENV,
  BUILD_COMMAND,
  CONSOLE_BUILD_COMMAND,
  consoleEntry,
  hasBuild,
  hasConsoleBuild,
  prodEntry,
} from "./prodServer.js";

// A globalSetup on the `integration` project only, listed before the dev-server
// setup so a missing build fails the project once, before the run pays to start a
// server. The suites that drive the hosted build's `node .output/server/index.mjs`
// gate on hasBuild, and those that drive the console server on hasConsoleBuild,
// so without this guard a build-free run reports a PASS with the built-server
// surface unexercised. CI builds both first (eb_build_and_test.yaml), so this
// only fires on a local run against a fresh clone.
//
// The opt-out restores the skip for a dev-server-only run. The guard cannot
// live on the shared dev-server setup, which the `browser` project also runs
// and which needs no production build.

export default function setup(): void {
  const missing = [
    ...(hasBuild ? [] : [{ entry: prodEntry, command: BUILD_COMMAND }]),
    ...(hasConsoleBuild
      ? []
      : [{ entry: consoleEntry, command: CONSOLE_BUILD_COMMAND }]),
  ];
  if (missing.length === 0) return;

  const entries = missing.map(({ entry }) => entry).join(" or ");
  if (process.env[ALLOW_MISSING_BUILD_ENV] === "1") {
    console.log(
      `[prod-build] ${ALLOW_MISSING_BUILD_ENV}=1: skipping the suites that ` +
        `drive the built server (no build at ${entries}).`,
    );
    return;
  }

  const commands = missing.map(({ command }) => `\`${command}\``).join(" and ");
  throw new Error(
    `No web production build at ${entries}, so the integration suites that ` +
      `drive the built server would silently skip and this run would report a ` +
      `pass. Build it first with ${commands}, or set ` +
      `${ALLOW_MISSING_BUILD_ENV}=1 to skip those suites deliberately and run ` +
      `only the dev-server-backed ones.`,
  );
}
