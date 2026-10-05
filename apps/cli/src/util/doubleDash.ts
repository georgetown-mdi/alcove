// Delivers the tokens after a `--` separator to a command's positionals, so a
// path beginning with `-` can be given as `alcove exchange -- -in.csv`. yargs
// leaves those tokens out of every declared positional, and counts a
// `<required>` positional before any middleware runs, so a command using this
// helper declares its positionals `[bracketed]` and names the required ones
// here, where they are demanded after the middleware below fills them.

import type { Argv, Arguments, ParserConfigurationOptions } from "yargs";

const AFTER_SEPARATOR_KEY = "--";

// How many trailing entries of a variadic positional came from after `--`,
// keyed by the parsed argv object, which the middleware, the global
// middleware and the handler share. Held outside argv because the
// unknown-option scan treats any extra argv key as an option.
const appendedAfterSeparator = new WeakMap<object, number>();

/** A command's positionals, each list in declaration order. */
export interface DoubleDashPositionals {
  /** The positionals the command cannot run without; declared first. */
  required?: readonly string[];
  /** The positionals after them; a variadic one is last. */
  optional?: readonly string[];
}

function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function assignPositional(argv: Arguments, name: string, value: unknown): void {
  argv[name] = value;
  if (name.includes("-")) argv[camelCase(name)] = value;
}

/**
 * Set `cmd` to deliver the tokens after a `--` separator to its positionals:
 * each token fills the next positional the command line left unset, a
 * variadic (array) positional takes every token left, and any token past the
 * last positional joins `argv._`, as yargs treats a surplus positional. The
 * `required` positionals are demanded once those tokens are placed.
 *
 * `parserConfiguration` is the rest of the command's parser configuration:
 * yargs replaces, rather than merges, a command's configuration on each call,
 * so this is the command's only call.
 */
export function acceptPositionalsAfterDoubleDash(
  cmd: Argv,
  positionals: DoubleDashPositionals,
  parserConfiguration: Partial<ParserConfigurationOptions> = {},
): Argv {
  const required = positionals.required ?? [];
  const names = [...required, ...(positionals.optional ?? [])];
  const configured = cmd
    .parserConfiguration({ ...parserConfiguration, "populate--": true })
    .middleware((argv) => {
      const after = argv[AFTER_SEPARATOR_KEY];
      if (!Array.isArray(after) || after.length === 0) return;
      const rest = after.map(String);
      for (const name of names) {
        if (rest.length === 0) break;
        const current = argv[name];
        if (Array.isArray(current)) {
          appendedAfterSeparator.set(argv, rest.length);
          assignPositional(argv, name, [...current, ...rest.splice(0)]);
        } else if (current === undefined) {
          assignPositional(argv, name, rest.shift());
        }
      }
      argv._.push(...rest);
    }, true);
  return required.length > 0
    ? configured.demandOption([...required])
    : configured;
}

/**
 * The entries of the variadic positional `positionals` given before a `--`
 * separator: the ones an unknown-option scan may take for a mistyped flag,
 * since every token after `--` is a positional.
 */
export function positionalsBeforeDoubleDash(
  argv: object,
  positionals: readonly unknown[],
): unknown[] {
  const appended = appendedAfterSeparator.get(argv) ?? 0;
  return positionals.slice(0, positionals.length - appended);
}
