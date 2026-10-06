// Reading the CLI's subcommand registry, shared by check-command-inventory.mjs
// and derive-image-dependencies.mjs.

/** The CLI parser module that registers every subcommand. */
export const CLI_PARSER = "apps/cli/src/cliParser.ts";

/** Extract registered subcommand names from cliParser source (skips `$0`). */
export function registeredCommands(parserSource) {
  return [...parserSource.matchAll(/\.command\(\s*"([^"$][^"\s]*)/g)].map(
    (m) => m[1],
  );
}
