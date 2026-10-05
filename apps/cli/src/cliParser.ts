import { readFileSync } from "node:fs";
import * as path from "node:path";

import yargs from "yargs";
import type { Argv } from "yargs";

import { sanitizeForDisplay } from "@alcove/core";

import {
  builder as zeroSetupBuilder,
  handler as zeroSetupHandler,
  QUICK_EXCHANGE_USAGE,
} from "./commands/zeroSetup";
import {
  builder as exchangeBuilder,
  handler as exchangeHandler,
} from "./commands/exchange";
import {
  builder as fingerprintBuilder,
  handler as fingerprintHandler,
} from "./commands/fingerprint";
import {
  builder as inviteBuilder,
  handler as inviteHandler,
} from "./commands/invite";
import {
  builder as acceptBuilder,
  handler as acceptHandler,
} from "./commands/accept";
import {
  builder as updateBuilder,
  handler as updateHandler,
} from "./commands/update";
import {
  builder as applyBuilder,
  handler as applyHandler,
} from "./commands/apply";
import {
  builder as initBuilder,
  handler as initHandler,
} from "./commands/init";
import {
  builder as probeHostKeyBuilder,
  handler as probeHostKeyHandler,
} from "./commands/probeHostKey";
import {
  builder as verifyReceiptBuilder,
  handler as verifyReceiptHandler,
} from "./commands/verifyReceipt";
import { builder as doctorBuilder } from "./commands/doctor";
import {
  builder as enrollRelayBuilder,
  handler as enrollRelayHandler,
} from "./commands/enrollRelay";
import {
  describeUnknownOptions,
  longOptionNames,
  unknownLongOptions,
} from "./usageHints";

/**
 * Read this package's own version from its co-located package.json, resolved
 * from `__dirname` rather than left to yargs' `.version()` default: yargs
 * walks up from its own install directory, which in this npm-workspaces
 * monorepo lands on the repo root and reports the root manifest's version
 * instead. `__dirname` resolves correctly both from the built dist
 * (dist/index.js) and this source file under a test runner (src/cliParser.ts)
 * -- both one level below apps/cli, so `../package.json` is the same relative
 * path in either.
 */
function readCliVersion(): string {
  const pkgPath = path.join(__dirname, "..", "package.json");
  // Non-sensitive: this package's own manifest, not a credential file, so there
  // is no secret for a parse error to leak.
  // eslint-disable-next-line no-restricted-properties -- non-credential parse, see above
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

/**
 * The unknown long options in the command line `parser` is parsing, read from
 * the command's option table and the argv yargs parsed for it. yargs exposes
 * both at runtime (`getOptions()`, `parsed`) but leaves them out of its type
 * declarations; `parsedArgv` defaults to that parsed argv.
 */
function unknownOptionsIn(
  parser: Argv,
  parsedArgv?: Readonly<Record<string, unknown>>,
): ReturnType<typeof unknownLongOptions> {
  const internals = parser as unknown as {
    getOptions(): Parameters<typeof longOptionNames>[0];
    parsed: { argv: Record<string, unknown> } | false;
  };
  const argv =
    parsedArgv ?? (internals.parsed === false ? {} : internals.parsed.argv);
  return unknownLongOptions(argv, longOptionNames(internals.getOptions()));
}

/**
 * Report a command-line usage fault and exit 64 (EX_USAGE). The message comes
 * from this operator's own command line but still routes through the
 * display-boundary sanitizer; the trailing hint is fixed text, kept outside
 * the sanitize call to preserve its literal newline.
 */
function failUsage(message: string): never {
  console.error(
    `${sanitizeForDisplay(message)}\nRun with --help to see the available options.`,
  );
  process.exit(64);
}

/**
 * Build the configured Alcove yargs parser for `argv`, up to but NOT including
 * `.parseAsync()`. Kept separate from the entry point (`index.ts`) so importing
 * it has no side effect: the entry point drives it against the real process argv,
 * and tests drive it against a synthetic one to assert the strict-option / fail
 * behavior without spawning the binary. Each call constructs a fresh instance, so
 * a test may parse repeatedly.
 */
export function buildCli(argv: string[]): Argv {
  const cli = yargs(argv);
  return (
    cli
      .scriptName("alcove")
      .version(readCliVersion())
      .usage(QUICK_EXCHANGE_USAGE)
      .command(
        "$0",
        "Quick exchange with no setup and no shared secret: " +
          "alcove [--save] URL INPUT_FILE [OUTPUT_FILE]",
        zeroSetupBuilder,
        zeroSetupHandler,
      )
      .command(
        "init [args..]",
        "Write a commented configuration template (no exchange, no key file)",
        initBuilder,
        initHandler,
      )
      .command(
        "invite [args..]",
        "Generate an invitation (offline), or invite and run an exchange (online)",
        inviteBuilder,
        inviteHandler,
      )
      .command(
        "accept [args..]",
        "Accept a partner invitation (offline), or accept and run (online)",
        acceptBuilder,
        acceptHandler,
      )
      .command(
        "exchange [input] [output]",
        "Run a recurring exchange from alcove.yaml and its key file",
        exchangeBuilder,
        exchangeHandler,
      )
      .command(
        "update",
        "Make a terms update for an established partnership (no new secret)",
        updateBuilder,
        updateHandler,
      )
      .command(
        "apply [args..]",
        "Apply a partner's terms update to this party's configuration",
        applyBuilder,
        applyHandler,
      )
      .command(
        "fingerprint",
        "Print this party's signing certificate fingerprint, creating the " +
          "signing identity if it does not exist",
        fingerprintBuilder,
        fingerprintHandler,
      )
      .command(
        "enroll-relay",
        "Register this exchange's relay key with its relay (asks for the " +
          "relay owner's token)",
        enrollRelayBuilder,
        enrollRelayHandler,
      )
      .command(
        "verify-receipt [record] [input-file] [result-file]",
        "Verify a stored exchange record and open its commitments (read-only)",
        verifyReceiptBuilder,
        verifyReceiptHandler,
      )
      .command(
        "probe-host-key [sftp-url]",
        "Read and print an SFTP server's host-key fingerprint (no credential sent)",
        probeHostKeyBuilder,
        probeHostKeyHandler,
      )
      // Registered with a builder and no handler: the builder demands one of the
      // `probe` / `mount` subcommands, so there is no bare `alcove doctor` for a
      // handler to serve.
      .command(
        "doctor",
        "Check a network file drop before an exchange (probe | mount)",
        doctorBuilder,
      )
      // Fail fast on a misspelled option (e.g. --server-user for
      // --server-username): otherwise yargs drops it unread into argv,
      // silently ignoring a typo'd credential or path override. strictOptions
      // (not strict) validates flags only, leaving the zero-setup/exchange
      // commands' argv._ positionals (URL/input/output) untouched; full
      // strict would reject those as unknown arguments.
      .strictOptions()
      // invite/accept/init/apply set unknown-options-as-args (to admit a
      // `-`-leading invitation string as a positional), so strictOptions lets
      // a mistyped `--` option through to their positionals. This runs after
      // validation and before any handler.
      .middleware((parsedArgv) => {
        const unknown = unknownOptionsIn(cli, parsedArgv);
        if (unknown.length > 0) failUsage(describeUnknownOptions(unknown));
      })
      .fail((msg, err) => {
        // A thrown error propagates to the caller's catch, which sanitizes it.
        // yargs counts required positionals before it checks options, so an
        // unknown option is reported in place of whatever yargs' message is.
        if (err) throw err;
        const unknown = unknownOptionsIn(cli);
        failUsage(unknown.length > 0 ? describeUnknownOptions(unknown) : msg);
      })
      .help("h")
      .alias("h", "help")
      .alias("V", "version")
  );
}
