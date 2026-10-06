// The one reader of a command's positionals. It delivers the tokens after a
// `--` separator to them, so a path beginning with `-` can be given as
// `alcove exchange -- -in.csv`, and refuses a positional past the last one the
// command takes. yargs leaves the tokens after `--` out of every declared
// positional, and counts a `<required>` positional before any middleware runs,
// so a command using this helper declares its positionals `[bracketed]` and
// names the required ones here, where they are demanded after the middleware
// below fills them.

import type { Argv, Arguments, ParserConfigurationOptions } from "yargs";

import { UsageError } from "@alcove/core";

const AFTER_SEPARATOR_KEY = "--";

// How many trailing entries of a variadic positional came from after `--`,
// keyed by the parsed argv object, which the middleware, the global
// middleware and the handler share. Held outside argv because the
// unknown-option scan treats any extra argv key as an option.
const appendedAfterSeparator = new WeakMap<object, number>();

/** A command's name and positionals, each list in declaration order. */
export interface CommandPositionals {
  /** The command as typed after `alcove`, e.g. `exchange` or `doctor mount`. */
  command: string;
  /**
   * The command's usage after `alcove COMMAND`, shown when it is given more
   * positionals than it takes; empty for a command that takes none.
   */
  usage: string;
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
 * The refusal of a command line holding more positionals than `alcove
 * command` takes; `command` is empty for the quick exchange. It names no
 * argument: one may be a URL holding a password.
 */
export function surplusPositionalsError(
  command: string,
  usage: string,
): UsageError {
  const invocation = command === "" ? "alcove" : `alcove ${command}`;
  return new UsageError(
    `too many arguments for ${invocation}; usage: ${invocation} ` +
      (usage === "" ? "[options]" : usage),
  );
}

/**
 * Throw {@link surplusPositionalsError} when `given` positionals exceed the
 * `most` a command takes. For a command whose variadic positional takes every
 * token, so the count depends on the form the first one selects.
 */
export function refuseSurplusPositionals(
  given: number,
  most: number,
  command: string,
  usage: string,
): void {
  if (given > most) throw surplusPositionalsError(command, usage);
}

/**
 * Set `cmd` to read its positionals: each token after a `--` separator fills
 * the next positional the command line left unset, and a variadic (array)
 * positional takes every token left. The `required` positionals are demanded
 * once those tokens are placed, and a token past the last positional, before
 * or after `--`, is refused with {@link surplusPositionalsError}.
 *
 * `parserConfiguration` is the rest of the command's parser configuration:
 * yargs replaces, rather than merges, a command's configuration on each call,
 * so this is the command's only call.
 */
export function declarePositionals(
  cmd: Argv,
  positionals: CommandPositionals,
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
      // yargs counts the tokens under this key as non-option arguments too,
      // so leaving them would count a placed token twice below.
      delete argv[AFTER_SEPARATOR_KEY];
    }, true)
    // A token no positional took is a non-option argument past the command's
    // own words, which this bounds at zero.
    .demandCommand(
      0,
      0,
      "",
      surplusPositionalsError(positionals.command, positionals.usage).message,
    );
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

/**
 * Whether `value` begins with a Windows drive letter and a separator (`C:\`
 * or `C:/`). The URL parser takes `C:` for a one-letter scheme, so a command
 * that tells a URL from a path asks this first.
 */
export function isWindowsDrivePath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value);
}

/**
 * Whether `value` begins like a URL (`scheme:/`), not counting a Windows
 * drive path ({@link isWindowsDrivePath}).
 */
export function startsWithUrlScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\//i.test(value) && !isWindowsDrivePath(value);
}
