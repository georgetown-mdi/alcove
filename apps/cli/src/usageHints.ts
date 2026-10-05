import { positionalsBeforeDoubleDash } from "./util/doubleDash";

/**
 * The command names `alcove` registers, in the order its help lists them. The
 * quick exchange takes a URL where a command name would go, so a first
 * positional that is close to one of these names but is not a URL is reported as
 * a mistyped command rather than run as an exchange.
 */
export const COMMAND_NAMES: readonly string[] = [
  "init",
  "invite",
  "accept",
  "exchange",
  "update",
  "apply",
  "fingerprint",
  "enroll-relay",
  "verify-receipt",
  "probe-host-key",
  "doctor",
];

/** What a bare `alcove` prints: the common tasks and where to read more. */
export const BARE_INVOCATION_SUMMARY =
  "No command given. Common tasks:\n" +
  "  alcove URL INPUT_FILE [OUTPUT_FOLDER]       quick exchange, no setup\n" +
  "  alcove init [INPUT_FILE]                    write a configuration template\n" +
  "  alcove invite ... / alcove accept ...       set up a recurring exchange\n" +
  "  alcove exchange INPUT_FILE [OUTPUT_FOLDER]  run a recurring exchange\n" +
  "  alcove doctor probe                         check a network file drop\n" +
  "Run 'alcove --help' for every command and option, or\n" +
  "'alcove COMMAND --help' for one command.";

/** Levenshtein distance between two strings. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * The candidate `word` most likely stands for: the only candidate it is a
 * prefix of, otherwise the nearest candidate within two edits, otherwise
 * undefined. A tie at the nearest distance suggests nothing rather than guess.
 */
export function closestMatch(
  word: string,
  candidates: readonly string[],
): string | undefined {
  if (word.length === 0) return undefined;
  const extending = candidates.filter((candidate) =>
    candidate.startsWith(word),
  );
  if (extending.length === 1) return extending[0];
  let best: string | undefined;
  let bestDistance = Math.min(2, word.length - 1) + 1;
  let tied = false;
  for (const candidate of candidates) {
    const distance = editDistance(word, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance && best !== undefined) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

/**
 * The long option names a command accepts, read from its yargs option table:
 * every declared key and alias longer than one character.
 */
export function longOptionNames(options: {
  key: Record<string, unknown>;
  alias: Record<string, string[]>;
}): string[] {
  const names = new Set<string>();
  for (const key of Object.keys(options.key)) names.add(key);
  for (const [key, aliases] of Object.entries(options.alias)) {
    names.add(key);
    for (const alias of aliases) names.add(alias);
  }
  return [...names].filter((name) => name.length > 1);
}

function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * The long options yargs parsed for a command that name no option in `known`,
 * each paired with the option it most likely stands for: every key of the
 * parsed `argv` other than yargs' own `_`, `$0` and `--`, plus each
 * `--`-leading token in the `args` positional given before a `--` separator,
 * where the commands that take unknown options as arguments collect them.
 * yargs adds a camelCase copy of each dashed key, so that copy is skipped; a
 * one-character key comes from a short flag and is left to yargs' own message.
 */
export function unknownLongOptions(
  argv: Readonly<Record<string, unknown>>,
  known: readonly string[],
): Array<{ option: string; suggestion: string | undefined }> {
  const accepted = new Set<string>();
  for (const name of known) {
    accepted.add(name);
    accepted.add(camelCase(name));
  }
  const keys = Object.keys(argv);
  const camelCopies = new Set(
    keys.filter((key) => key.includes("-")).map(camelCase),
  );
  const names = keys.filter(
    (key) =>
      !["_", "$0", "--"].includes(key) &&
      key.length > 1 &&
      !camelCopies.has(key),
  );
  const positionals = Array.isArray(argv.args)
    ? positionalsBeforeDoubleDash(argv, argv.args)
    : [];
  for (const token of positionals) {
    if (typeof token === "string" && token.startsWith("--") && token !== "--")
      names.push(token.slice(2).split("=", 1)[0]);
  }
  const unknown: Array<{ option: string; suggestion: string | undefined }> = [];
  for (const name of names) {
    if (accepted.has(name)) continue;
    if (unknown.some((entry) => entry.option === `--${name}`)) continue;
    const suggestion = closestMatch(name, known);
    unknown.push({
      option: `--${name}`,
      suggestion: suggestion === undefined ? undefined : `--${suggestion}`,
    });
  }
  return unknown;
}

/**
 * One line per unrecognized option, naming it and, when one is close, the
 * option it most likely stands for.
 */
export function describeUnknownOptions(
  unknown: ReadonlyArray<{ option: string; suggestion: string | undefined }>,
): string {
  return unknown
    .map(({ option, suggestion }) =>
      suggestion === undefined
        ? `Unknown option ${option}.`
        : `Unknown option ${option}; did you mean ${suggestion}?`,
    )
    .join("\n");
}

/**
 * The usage error for a quick-exchange first positional that is a bare word
 * rather than a URL or an existing file: a mistyped command, with the command
 * it most likely stands for when one is close. Undefined when `arg` is not a
 * bare word, leaving the URL and file checks to report it.
 */
export function unknownCommandMessage(arg: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z-]*$/.test(arg)) return undefined;
  const suggestion = closestMatch(arg.toLowerCase(), COMMAND_NAMES);
  const hint = "Run 'alcove --help' to see the commands.";
  return suggestion === undefined
    ? `'${arg}' is not an alcove command or a server URL. ${hint}`
    : `'${arg}' is not an alcove command; did you mean 'alcove ${suggestion}'? ${hint}`;
}
