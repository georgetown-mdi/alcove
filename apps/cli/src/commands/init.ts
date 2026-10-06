import type { Argv, Arguments } from "yargs";

import {
  DEFAULT_LINKAGE_RULE_SET,
  inferDateInputFormatFromSource,
  keepOperatorSuppliedText,
  linkageTermsFromRuleSet,
  messageWithOperatorText,
  operatorSuppliedText,
  PLACEHOLDER_SSH_USERNAME,
  redactAndRenderOperatorSuppliedText,
  undeclaredColumnNames,
  UsageError,
} from "@alcove/core";
import type { BuiltInLinkageRuleSet } from "@alcove/core";

import {
  configPlaceholderFields,
  DEFAULT_CONFIG_PATH,
  writeConfigFile,
} from "../config";
import { channelForScheme, connectionFromURL } from "../connectionFromUrl";
import { detectFileConflicts, FileExistsError } from "../fileUtils";
import {
  DEFAULT_TEMPLATE_CONNECTION,
  PLACEHOLDER_FILEDROP_PATH,
  renderConfigTemplate,
} from "../configTemplate";
import type { TemplateConnection, TemplateDataSpec } from "../configTemplate";
import {
  assertUrlPasswordStorable,
  commandLineLiteralCredentials,
  warnIfCommandLineHoldsLiteralCredential,
} from "../literalCredentials";
import { openInputSource } from "../util/dataIo";
import { runOrExit } from "../util/exit";
import {
  assertNoUnknownOptions,
  csvDelimiterFlag,
  singleValue,
} from "../util/flags";
import {
  declarePositionals,
  positionalsBeforeDoubleDash,
  refuseSurplusPositionals,
  startsWithUrlScheme,
} from "../util/positionals";
import { configureLogging, logLevelFlag } from "../util/logging";
import { promptConfirm, stdinAnswersPrompts } from "../util/prompt";
import {
  addCsvDelimiterOption,
  addLoggingOptions,
  configFileFlag,
} from "../optionDefinitions";
import {
  buildDataSpec,
  looksLikeUrl,
  warnSanitizedColumns,
} from "../onlineBootstrap";
import {
  askIdentityAtPrompt,
  identityFromFlagOrPrompt,
  INIT_IDENTITY_QUESTION,
  PLACEHOLDER_IDENTITY,
} from "../partyIdentity";

const INIT_USAGE = "[options] [URL] [INPUT_FILE]";

export function builder(cmd: Argv): Argv {
  const withoutLogging = addCsvDelimiterOption(
    declarePositionals(
      cmd,
      {
        command: "init",
        usage: INIT_USAGE,
        optional: ["args"],
      },
      {
        // Capture positionals into `args` (rather than the global `_`) and
        // treat an unknown `-`-leading token as a positional, so a bare `-`
        // (stdin) or an input path is never swallowed or misread as a flag --
        // the same parsing the invite/accept commands use for their
        // positionals.
        "unknown-options-as-args": true,
      },
    ),
  )
    .positional("args", {
      type: "string",
      array: true,
      describe:
        "optional server [URL] (sftp://, ssh://, or file://) to fill the " +
        "connection block from, then an optional CSV [INPUT_FILE] to infer " +
        "column metadata, linkage fields, and standardizing transformations " +
        "from; `-` reads it from stdin",
    })
    .option("channel", {
      type: "string",
      describe:
        "channel of the connection block to write when no URL is given: " +
        "sftp (default) or filedrop",
    })
    .option("config-file", {
      type: "string",
      describe: `where to write the template (default: ${DEFAULT_CONFIG_PATH})`,
    })
    .option("identity", {
      type: "string",
      describe: "identity string to pre-fill (name, org, contact)",
    });
  return addLoggingOptions(withoutLogging).usage(
    "Usage:\n" +
      "  $0 init [options] [URL] [INPUT_FILE]\n\n" +
      "Write a commented alcove.yaml template -- every option documented\n" +
      "inline with defaults pre-filled -- then exit. No key file is created\n" +
      "and no exchange is run. With a URL, the connection block is filled\n" +
      "from it, leaving only the credential to add. With an INPUT_FILE,\n" +
      "column metadata, linkage fields, and standardizing transformations\n" +
      "are inferred from it.\n\n" +
      "INPUT_FILE may be `-` to read the CSV from stdin.",
  );
}

export async function handler(argv: Arguments): Promise<void> {
  let closeLogging: (() => void) | undefined;
  try {
    await runOrExit("init", async () => {
      // Inside runOrExit, so an unrecognized value is a clean usage error
      // (exit 64) on the same path as everything else.
      const logLevel = logLevelFlag(argv);
      const { log, close } = configureLogging({
        logLevel,
        logFile: singleValue(argv, "log-file") as string | undefined,
        name: "init",
      });
      closeLogging = close;

      const configFile = configFileFlag(argv);
      // Read here, with the other flags, so a repeated --identity is a usage
      // error before any question is asked or any file is written; what the
      // value means is decided below, once it is known whether this run can ask
      // for one instead.
      const identityFlag = singleValue(argv, "identity") as string | undefined;
      // Read with the other flags so a malformed value is a usage error before
      // anything is read or written. It reads the input file below AND is
      // written into the template, so the next run against that file needs no
      // flag of its own.
      const csvDelimiter = csvDelimiterFlag(argv);
      const positionals = (argv["args"] as Array<string> | undefined) ?? [];
      // This command sets unknown-options-as-args (so a bare `-` stdin token
      // survives as a positional), which also lets a mistyped `--flag` reach the
      // positionals rather than the top-level strictOptions; reject it here,
      // before any input read or file write.
      assertNoUnknownOptions(positionalsBeforeDoubleDash(argv, positionals));
      const { url, input } = resolveInitPositionals(positionals);
      assertUrlPasswordStorable(
        url,
        'add its path with a leading @ to connection.server in the file, e.g. password: "@./sftp-password.txt".',
      );
      warnIfCommandLineHoldsLiteralCredential(
        commandLineLiteralCredentials(argv, url, []),
        log,
      );
      const connection = templateConnection(
        url,
        singleValue(argv, "channel") as string | undefined,
      );

      // One interactivity decision serves both questions this command can ask,
      // so the two cannot disagree about who owns stdin.
      const interactive = stdinAnswersPrompts(input);

      // Decide whether to (over)write before reading the input, so a `-` stdin CSV
      // is never consumed when the answer is "fail-closed" or "leave it" -- the
      // overwrite prompt and a stdin CSV both want stdin, the same conflict accept
      // resolves by refusing `-`.
      const decision = await decideOverwrite(configFile, {
        interactive,
        confirm: () =>
          promptConfirm(
            `Overwrite ${redactAndRenderOperatorSuppliedText(
              operatorSuppliedText(configFile),
            )}?`,
          ),
      });
      if (decision === "skip") {
        log.info(
          `left the existing file at ${redactAndRenderOperatorSuppliedText(
            operatorSuppliedText(configFile),
          )} unchanged.`,
        );
        return;
      }

      // Asked after the overwrite decision, so a run that leaves the existing
      // file alone asks nothing: there is no file being written for the answer
      // to be remembered in, and Alcove remembers an answer nowhere else.
      // Absent both the flag and an answer, the template holds the
      // placeholder, like the connection's host and username: init produces a
      // scaffold to hand-edit, not a runnable config.
      const identity =
        (await identityFromFlagOrPrompt(
          identityFlag,
          interactive
            ? () => askIdentityAtPrompt(INIT_IDENTITY_QUESTION)
            : undefined,
        )) ?? PLACEHOLDER_IDENTITY;

      const data = await buildTemplateData(
        input,
        identity,
        DEFAULT_LINKAGE_RULE_SET,
        csvDelimiter,
      );
      const template = renderConfigTemplate(data, connection);
      try {
        // Exclusive on the "create" path (the path was free at the check): if a
        // file appeared between the check and this write -- a window a `-` stdin
        // CSV can hold open arbitrarily long -- fail closed rather than silently
        // clobber it, re-asserting the never-overwrite-unprompted contract at the
        // write the way provisionConfigAndKey re-gates. On the "overwrite" path
        // the operator already confirmed, so the write replaces in place.
        writeConfigFile(configFile, template, connection, {
          exclusive: decision === "create",
          log,
        });
      } catch (err) {
        // init performs no network activity, so every failure is a local,
        // operator-fixable problem -- classify a write failure as a usage error
        // (exit 64) rather than letting runOrExit's transport-failure default (69)
        // misclassify it.
        if (err instanceof FileExistsError) {
          const appeared = messageWithOperatorText`a file appeared at ${operatorSuppliedText(
            configFile,
          )} after the overwrite check; refusing to overwrite it unprompted. Re-run to decide.`;
          throw keepOperatorSuppliedText(
            new UsageError(appeared.text),
            appeared,
          );
        }
        const message = messageWithOperatorText`could not write ${operatorSuppliedText(
          configFile,
        )}: ${err instanceof Error ? err.message : String(err)}`;
        throw keepOperatorSuppliedText(new UsageError(message.text), message);
      }

      log.info(
        `wrote a configuration template to ${redactAndRenderOperatorSuppliedText(
          operatorSuppliedText(configFile),
        )}. No key file was created and no exchange was run. ` +
          initNextSteps(connection, identity),
      );
    });
  } finally {
    closeLogging?.();
  }
}

/**
 * The refusal a first positional that starts like a URL but does not parse
 * gets. It names no part of the argument: the argument may carry a password.
 */
export const INIT_URL_UNREADABLE =
  "could not read the URL. A valid form is sftp://[user@]host[:port]/path " +
  "or file:///path, with a port from 1 to 65535 and no spaces.";

/**
 * Resolve the optional URL and INPUT_FILE positionals, in that order. A first
 * positional with a connection scheme ({@link looksLikeUrl}) is the URL;
 * anything else is the input file, except an argument that starts with a
 * scheme but does not parse, which is refused without being echoed. A further positional is a mistake -- most
 * likely an OUTPUT_FOLDER copied from another command, which `init` does not
 * take -- so it is rejected as a usage error rather than silently ignored.
 *
 * @internal exported for testing
 */
export function resolveInitPositionals(positionals: Array<unknown>): {
  url?: URL;
  input?: string;
} {
  const given = positionals.map(String);
  if (
    given[0] !== undefined &&
    startsWithUrlScheme(given[0]) &&
    !looksLikeUrl(given[0])
  )
    throw new UsageError(INIT_URL_UNREADABLE);
  const url =
    given[0] !== undefined && looksLikeUrl(given[0])
      ? new URL(given[0])
      : undefined;
  const rest = url !== undefined ? given.slice(1) : given;
  refuseSurplusPositionals(rest.length, 1, "init", INIT_USAGE);
  return {
    ...(url !== undefined ? { url } : {}),
    ...(rest[0] !== undefined ? { input: rest[0] } : {}),
  };
}

/** The channels `init` writes a connection block for. */
const INIT_CHANNELS = ["sftp", "filedrop"] as const;

/**
 * The refusal a webrtc URL or `--channel webrtc` gets: a webrtc block needs
 * the party's `role`, which only an invitation decides.
 */
export const INIT_WEBRTC_REFUSED =
  "init writes an sftp or filedrop connection block. A webrtc block is " +
  "written by 'alcove invite', which takes a ws:// or wss:// URL, and by " +
  "'alcove accept' from the invitation; or uncomment the webrtc example at " +
  "the end of the template.";

/**
 * The connection block `init` writes: filled from `url` when one is given,
 * otherwise placeholders for the `--channel` channel (default sftp). An sftp
 * URL fills host, port, username, and the directory; only a credential is
 * then left to add, and a URL naming no username leaves that placeholder. A
 * URL with no directory names the login directory, so no `path` is written.
 * A URL holding a password writes it into the block as given.
 *
 * @throws {UsageError} for a webrtc or unknown channel, or a `--channel` that
 *   disagrees with the URL's.
 * @internal exported for testing
 */
export function templateConnection(
  url: URL | undefined,
  channelFlag: string | undefined,
): TemplateConnection {
  if (channelFlag === "webrtc") throw new UsageError(INIT_WEBRTC_REFUSED);
  if (
    channelFlag !== undefined &&
    !(INIT_CHANNELS as ReadonlyArray<string>).includes(channelFlag)
  ) {
    const message = messageWithOperatorText`unknown --channel ${operatorSuppliedText(
      channelFlag,
    )}; expected sftp or filedrop`;
    throw keepOperatorSuppliedText(new UsageError(message.text), message);
  }

  if (url === undefined)
    return channelFlag === "filedrop"
      ? { channel: "filedrop", path: PLACEHOLDER_FILEDROP_PATH }
      : DEFAULT_TEMPLATE_CONNECTION;

  const urlChannel = channelForScheme(url.protocol);
  if (urlChannel === "webrtc") throw new UsageError(INIT_WEBRTC_REFUSED);
  if (channelFlag !== undefined && channelFlag !== urlChannel)
    throw new UsageError(
      `--channel ${channelFlag} does not match the URL, which names the ` +
        `${urlChannel ?? "another"} channel; give the URL alone`,
    );
  let parsed: ReturnType<typeof connectionFromURL>;
  try {
    parsed = connectionFromURL(url, {});
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    // connectionFromURL's refusals end in "; got: <url>", and the URL may
    // carry a password; keep the reason alone.
    const reason = error.message.replace(/;?\s*got: [\s\S]*$/, "");
    throw new UsageError(`could not use the URL: ${reason}`);
  }
  if (parsed.channel === "filedrop")
    return {
      channel: "filedrop",
      path: parsed.path ?? PLACEHOLDER_FILEDROP_PATH,
    };
  return {
    channel: "sftp",
    server: {
      host: parsed.server.host,
      port: parsed.server.port ?? 22,
      username: parsed.server.username ?? PLACEHOLDER_SSH_USERNAME,
      ...(parsed.server.path !== undefined ? { path: parsed.server.path } : {}),
      ...(parsed.server.password !== undefined
        ? { password: parsed.server.password }
        : {}),
    },
  };
}

/**
 * What the success notice asks the operator to do next: the placeholders the
 * written file still holds, by field, and on sftp the credential to add.
 */
function initNextSteps(
  connection: TemplateConnection,
  identity: string,
): string {
  const placeholders = [
    ...configPlaceholderFields(connection, ["connection"]),
    ...configPlaceholderFields({ identity }, ["linkage_terms"]),
  ];
  const steps = [
    ...(placeholders.length > 0
      ? [
          `replace the placeholder${placeholders.length > 1 ? "s" : ""} in ` +
            placeholders.join(", "),
        ]
      : []),
    ...(connection.channel === "sftp" &&
    connection.server.password === undefined
      ? ["add your SFTP credential to connection.server"]
      : []),
  ];
  const edit =
    steps.length > 0
      ? `Edit the file -- ${steps.join(", and ")} -- then run`
      : "Review the file, then run";
  return `${edit} 'alcove invite' or 'alcove accept' to set up an exchange.`;
}

/**
 * Resolve the exchange-data sections of the template: the inferred metadata,
 * linkage fields, and standardization when an input CSV is given, or just the
 * default linkage terms when it is not. Reuses `buildDataSpec` -- the same
 * inference `invite`/`accept`/zero-setup run -- so the template matches what
 * those commands would author from the same file. Reads only the header plus
 * a bounded DOB sample via {@link inferDateInputFormatFromSource}, which
 * yields the same format as a full read.
 *
 * That read applies core's header sanitation like every other, so it states the
 * positions it changed through the same warning line the exchange reads use: the
 * config this writes names the sanitized column, not the header as typed.
 *
 * `ruleSet` is the built-in rule set the terms are drawn from, the default set
 * unless one is chosen. The template cites whichever it was, so the file this
 * writes states where its rules came from and a later load resolves that
 * citation to the same rules.
 *
 * `csvDelimiter` reads the input by that field delimiter and is written into
 * the template, so the exchange the template governs runs it without a flag.
 *
 * @internal exported for testing
 */
export async function buildTemplateData(
  input: string | undefined,
  identity: string,
  ruleSet: BuiltInLinkageRuleSet = DEFAULT_LINKAGE_RULE_SET,
  csvDelimiter?: string,
): Promise<TemplateDataSpec> {
  const delimiterSection = csvDelimiter !== undefined ? { csvDelimiter } : {};
  if (input === undefined)
    return {
      linkageTerms: linkageTermsFromRuleSet(ruleSet, identity),
      ...delimiterSection,
    };

  let inferred;
  try {
    inferred = await inferDateInputFormatFromSource(
      openInputSource(input, { allowStdin: true }),
      undefined,
      csvDelimiter,
    );
  } catch (err) {
    // openInputSource's stdin-specific rejections (`-` disallowed, `-` at a bare
    // TTY) are already UsageErrors with actionable wording -- keep them. A missing
    // or unreadable file is reclassified as a usage error (exit 64) naming the
    // file: init authors a configuration from the file the operator named, so
    // there is no scheduled run to wait for it.
    if (err instanceof UsageError) throw err;
    const message = messageWithOperatorText`could not read input file ${operatorSuppliedText(
      input,
    )}: ${err instanceof Error ? err.message : String(err)}`;
    throw keepOperatorSuppliedText(new UsageError(message.text), message);
  }

  warnSanitizedColumns(inferred.sanitizedColumnPositions);

  const dataSpec = buildDataSpec({
    identity,
    ruleSet,
    rows: {
      rawRows: [],
      columns: inferred.columns,
      sanitizedColumnPositions: inferred.sanitizedColumnPositions,
    },
    ...(inferred.dateInputFormat !== undefined
      ? { dateInputFormat: inferred.dateInputFormat }
      : {}),
  });
  return {
    ...dataSpec,
    ...(dataSpec.metadata !== undefined
      ? {
          undeclaredColumns: undeclaredColumnNames(
            inferred.columns,
            dataSpec.metadata,
          ),
        }
      : {}),
    ...delimiterSection,
  };
}

/** What {@link decideOverwrite} states behind the occupied path. */
const UNCONFIRMED_OVERWRITE_REMEDY =
  "; refusing to overwrite it without an interactive confirmation. Delete " +
  "it, or pass --config-file to write the template elsewhere.";

/**
 * Decide what `init` should do about the output path. Returns `"create"` when
 * the path is free (the caller then writes exclusively, so a file that appears
 * before the write fails closed rather than being clobbered), `"overwrite"` when
 * a file exists and the user confirms replacing it, and `"skip"` when the user
 * declines. When a file exists but no interactive confirmation is possible (no
 * terminal, or a `-` stdin CSV already owns stdin), fails closed with a
 * {@link UsageError} rather than silently overwriting -- the same conservative
 * default the host-key and key-file non-interactive paths use.
 *
 * @internal exported for testing
 */
export async function decideOverwrite(
  configPath: string,
  opts: { interactive: boolean; confirm: () => Promise<boolean> },
): Promise<"create" | "overwrite" | "skip"> {
  // detectFileConflicts (lstat, not existsSync) so a dangling symlink at the
  // path is treated as occupied and still prompts -- existsSync resolves it to
  // false yet a write would follow it, the same fail-closed reasoning the
  // provisioning conflict gate uses.
  if (detectFileConflicts([configPath]).length === 0) return "create";
  if (!opts.interactive) {
    const message = messageWithOperatorText`a file already exists at ${operatorSuppliedText(
      configPath,
    )}${UNCONFIRMED_OVERWRITE_REMEDY}`;
    throw keepOperatorSuppliedText(new UsageError(message.text), message);
  }
  return (await opts.confirm()) ? "overwrite" : "skip";
}
