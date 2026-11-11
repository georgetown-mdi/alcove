/** Opt-out for a run where a prerequisite is knowingly absent. */
export const ALLOW_MISSING_PREREQUISITES_ENV =
  "ALCOVE_ALLOW_MISSING_TEST_PREREQUISITES";

/**
 * Whether this environment is supposed to supply every test prerequisite. CI
 * runners are provisioned to a spec, so a missing prerequisite there is a
 * failure; anywhere else it is a fact about the machine.
 *
 * Shared by every prerequisite gate that decides this the same way: the web
 * suites' gate (`apps/web/test/requireTestPrerequisites.ts`), the broker
 * suite's (`packages/peerjs-broker/test/requireLoopbackTlsCert.ts`) and the
 * CLI's live one-command acceptance leg, which read it directly for their own
 * `openssl` prerequisite, so an operator whose machine cannot supply one sets
 * the single opt-out for all three.
 */
export function prerequisitesAreRequired(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[ALLOW_MISSING_PREREQUISITES_ENV] === "1") return false;
  return env.CI !== undefined && env.CI !== "" && env.CI !== "false";
}
