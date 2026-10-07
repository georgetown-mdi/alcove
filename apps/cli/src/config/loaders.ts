import fs from "node:fs";

import type {
  ConnectionConfigAwaitingAddress,
  LinkageTerms,
  Metadata,
  ProvisionedServerAddress,
  Standardization,
} from "@alcove/core";
import {
  BUILT_IN_LINKAGE_RULE_SETS,
  CSV_DELIMITER_DETECT,
  csvDelimiterRefusal,
  isCsvDelimiterChoice,
  normalizeCsvDelimiter,
  operatorSuppliedText,
  rawDecodeErrorDescription,
  redactAndRenderOperatorSuppliedText,
  safeParseConnectionConfigAwaitingAddress,
  safeParseLinkageTermsTheReaderWrote,
  safeParseMetadataTheReaderWrote,
  safeParseStandardizationTheReaderWrote,
  sanitizeForDisplay,
  retiredSettingIssue,
  snakeizeKey,
} from "@alcove/core";

import { writeFileOwnerOnly } from "../fileUtils";
import {
  parseSensitiveYaml,
  editSensitiveYamlDocument,
} from "../sensitiveFile";

import {
  configFileLabel,
  configFileRefusal,
  normalizeKeyPathSpelling,
} from "./persist";
import {
  type LinkageTermsStanding,
  linkageTermsWithNamedRuleSetRules,
} from "./ruleSetCitation";

// --- Config reader -----------------------------------------------------------

/**
 * The portion of a pre-existing config that `invite` uses as the source for
 * an invitation: the linkage terms, the explicit data standardization and
 * metadata if any, plus the one connection fact the invitation declares. The
 * connection block itself is omitted -- `invite` does not build a connection
 * from it.
 */
export interface ConfigLinkageSource {
  linkageTerms: LinkageTerms;
  /** The config's explicit `standardization` block, absent when not present. */
  standardization?: Standardization;
  /**
   * The config's explicit `metadata` block, absent when not present.
   * Forwarded to the satisfiability check so it resolves the type fallback
   * against the same column types the exchange does -- without it, a config
   * that retypes a column could mint an invitation for an input the exchange
   * cannot actually satisfy.
   */
  metadata?: Metadata;
  /**
   * Whether the config's connection block has retain mode on
   * (`connection.options.retain_files: true`), which the minted invitation
   * declares to the partner as a consent fact.
   *
   * Read as that ONE boolean at its fixed path, never by validating the
   * connection block, so an unfinished or placeholder one does not block
   * generating an invitation. Anything other than a literal `true` counts
   * as false, including a `webrtc` connection.
   */
  retainsFiles: boolean;
  /**
   * The config's `csv_delimiter`, resolved through the same spellings and
   * graded by the same accepted-value rule the schema applies, and absent when
   * the config sets none. Read so a command that checks an input against this
   * config reads the file by the delimiter the exchange this config governs
   * will read it by.
   */
  csvDelimiter?: string;
  /**
   * Whether an acceptance stands behind the config's linkage terms, for
   * readers that report on the citation those terms hold. Read as the
   * single presence check {@link linkageTermsStandingOf} describes, at the
   * top-level key rather than through the spec schema.
   */
  linkageTermsStanding: LinkageTermsStanding;
}

/**
 * What reading a config file yielded for a caller that wants its linkage terms:
 * no file at the path, a file that defines no `linkage_terms` block, or the
 * loaded source. The two absences are separate outcomes because what each one
 * means belongs to the caller -- `invite` treats a config defining no terms as a
 * broken invitation source, while `verify-receipt` reads the same file for its
 * `signing.partner_fingerprint` and proceeds without terms.
 */
export type ConfigLinkageSourceResult =
  | { status: "no-config-file" }
  | { status: "no-linkage-terms" }
  | { status: "loaded"; source: ConfigLinkageSource };

/**
 * One schema issue as it reaches a renderer here: Zod's own issue fields,
 * with the nested issues an `invalid_key` wrapper holds.
 */
export type SchemaIssue = {
  path?: ReadonlyArray<PropertyKey>;
  message?: string;
  code?: string;
  issues?: ReadonlyArray<{ message: string }>;
};

/**
 * One schema-issue path with each segment named as the CONFIG FILE spells it.
 * Every schema refusal this module renders -- one block's issues, or a whole
 * document's -- names its path through here.
 *
 * `keys` says how the document was parsed. A document parsed through
 * `camelizeKeys` (`camelized`) yields issue paths in camelCase while the file
 * writes snake_case, so each segment is put back through {@link snakeizeKey}.
 * A schema that parses the on-disk form directly (`as-written`) is named
 * verbatim.
 *
 * A camelized path STOPS at a `params` segment, naming the block rather than
 * the key inside it: that free-form record holds the author's own key, the
 * camelized form of two different on-disk spellings can collide, and the
 * schema's own refusals under it (`parse_date`'s `output_format`, `pad_left`'s
 * `length`) write the param into the message text in the file's spelling.
 */
function schemaIssuePathAsWritten(
  issuePath: ReadonlyArray<PropertyKey>,
  keys: "camelized" | "as-written",
): Array<string> {
  const paramsIndex = keys === "camelized" ? issuePath.indexOf("params") : -1;
  const path =
    paramsIndex >= 0 ? issuePath.slice(0, paramsIndex + 1) : issuePath;
  // A Zod issue path is PropertyKey[], and Array.join throws a TypeError on a
  // symbol segment where String() renders it, so this map is a guard rather
  // than a redundant coercion: an error-formatting path must not fail while
  // reporting.
  return path.map((segment) =>
    keys === "camelized" ? snakeizeKey(String(segment)) : String(segment),
  );
}

/**
 * What one schema issue says went wrong, for a renderer to put after the path.
 *
 * A refused record KEY arrives as Zod's `invalid_key` issue: its own message is
 * the wrapper text `Invalid key in record`, while what the key violated sits on
 * the issues nested under it. Those nested messages are returned in the
 * wrapper's place -- with the path cut at `params`, the reason is the only part
 * left to say what is wrong -- and they are the schema's own fixed literals,
 * naming no key.
 */
function schemaIssueReason(issue: SchemaIssue): string {
  const nested = issue.code === "invalid_key" ? (issue.issues ?? []) : [];
  return nested.length > 0
    ? nested.map((inner) => inner.message).join(", ")
    : (issue.message ?? "schema validation failed");
}

/**
 * Render a config block's schema issues as `<key path>: <reason>` clauses,
 * so the operator can locate each offending field, mirroring accept's
 * decode-error formatting.
 *
 * Paths are named as the file spells them ({@link schemaIssuePathAsWritten}),
 * which is also how {@link describeConfigSchemaError} names the whole-document
 * case.
 */
function describeSchemaIssues(
  issues: ReadonlyArray<SchemaIssue>,
  keys: "camelized" | "as-written",
): string {
  return issues
    .map((issue) => {
      const segments = schemaIssuePathAsWritten(issue.path ?? [], keys);
      const at = segments.length > 0 ? `${segments.join(".")}: ` : "";
      return `${at}${schemaIssueReason(issue)}`;
    })
    .join("; ");
}

/**
 * A config file's schema failure rendered for the operator: the concise
 * `<path>: <reason>` one-liner {@link rawDecodeErrorDescription} composes, over
 * the path ({@link schemaIssuePathAsWritten}) and reason
 * ({@link schemaIssueReason}) a block's issues are rendered with, so the refusal
 * points at a line the operator can find in their own document
 * (docs/spec/EXCHANGE_FILE.md, "How a setting is named"). The exchange schema
 * validates the camelized shape, so its issues are named `camelized`.
 *
 * The composition stays with `rawDecodeErrorDescription` rather than with
 * {@link describeSchemaIssues}: it shows the first issue with a count of the
 * rest and bounds each path segment, the fit a whole-document refusal naming
 * every unread key needs.
 *
 * Composed RAW for interpolation into an `Error`, as the description it
 * delegates to is.
 */
export function describeConfigSchemaError(err: unknown): string {
  if (err === null || typeof err !== "object" || !("issues" in err))
    return rawDecodeErrorDescription(err);
  const { issues } = err as { issues?: Array<SchemaIssue> };
  if (!Array.isArray(issues) || issues.length === 0)
    return rawDecodeErrorDescription(err);
  return rawDecodeErrorDescription({
    issues: issues.map((issue) => ({
      path: schemaIssuePathAsWritten(issue.path ?? [], "camelized"),
      message: schemaIssueReason(issue),
    })),
  });
}

/**
 * Whether a read takes a `linkage_terms` block's rules from the rule set the
 * block names ({@link linkageTermsWithNamedRuleSetRules}), for a block that
 * names one and writes no rules of its own.
 *
 * Only a document THIS party wrote is read `"from-the-named-set"`. A
 * partner-authored terms document is read `"as-written"`, the default: the
 * citation in it is text that party wrote about its own rules, so filling
 * this build's content in under it would hash rules the partner never sent,
 * and a name this build does not ship would stop a verification the
 * partner's file is not at fault for.
 */
export type NamedRuleSetRules = "from-the-named-set" | "as-written";

/**
 * Read the linkage-terms source from a config file, reporting a missing file
 * and a config that defines no `linkage_terms` as distinct outcomes, so each
 * caller attributes them in its own terms.
 *
 * Only the `linkage_terms`, `standardization`, and `metadata` blocks are
 * parsed and validated; the connection block is excluded by design, so a
 * still-placeholder one does not fail the read.
 *
 * A retired top-level setting is refused first, with the refusal
 * `parseExchangeSpec` raises ({@link retiredSettingIssue}), and each of those
 * three blocks is read through the entry point that refuses a key its schema
 * would drop rather than read, the rule `parseExchangeSpec` holds over the
 * whole file (docs/spec/EXCHANGE_FILE.md, "What a consumer does with a setting
 * it cannot honor"). So a file `alcove exchange` refuses for either of those
 * reasons is not one `alcove invite` mints an invitation from; an unknown
 * top-level key or a defect in another block is left to `alcove exchange`.
 *
 * Every other defect is a {@link UsageError}: a config present at the path
 * is treated as intentional, so a broken one is reported for the user to
 * fix. Top-level keys are read as either the written snake_case form or
 * their camelCase spelling.
 *
 * @param rules whether a rule-set citation is resolved into this build's own
 * rules; see {@link NamedRuleSetRules}, whose default leaves the document as
 * its author wrote it.
 */
export function readConfigLinkageSource(
  configPath: string,
  rules: NamedRuleSetRules = "as-written",
): ConfigLinkageSourceResult {
  // Read, then parse through the sensitive-file chokepoint. A read failure
  // holds only a path and errno (ENOENT means no config, not an error here); a
  // YAML parse can echo source bytes (an inline credential), so it routes through
  // parseSensitiveYaml, which reports path-only (see sensitiveFile.ts).
  let source: string;
  try {
    source = fs.readFileSync(configPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "no-config-file" };
    throw configFileRefusal(
      configPath,
      "could not be read: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const raw = parseSensitiveYaml(source, configFileLabel(configPath));

  // A top-level YAML mapping is required. Exclude an array (also
  // `typeof === "object"`) and a scalar explicitly, so a malformed config is
  // reported as such rather than misattributed to a missing `linkage_terms`
  // block (an array has no such key, so it would otherwise fall through below).
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw configFileRefusal(
      configPath,
      "is not a valid configuration object (expected a YAML mapping at the " +
        "top level)",
    );
  const retired = retiredSettingIssue(raw);
  if (retired !== undefined)
    throw configFileRefusal(configPath, "is not valid: " + retired.message);
  const obj = raw as Record<string, unknown>;
  const rawTerms = obj["linkage_terms"] ?? obj["linkageTerms"];
  if (rawTerms === undefined) return { status: "no-linkage-terms" };

  // Rules the block names a set for instead of writing out are taken from that
  // set before validation: the schema requires both lists, and a mint from this
  // config declares what it resolved to, citation and all.
  const terms =
    rules === "from-the-named-set"
      ? linkageTermsWithNamedRuleSetRules(
          rawTerms,
          configPath,
          BUILT_IN_LINKAGE_RULE_SETS,
          obj,
        )
      : rawTerms;

  // Read through the entry point whose refusals address the party who WROTE
  // the document: this block is the operator's own, and the file is open to
  // them, so a mistyped text param names the remedy rather than the type
  // alone (@alcove/core, transformParamTypes.ts).
  const result = safeParseLinkageTermsTheReaderWrote(terms);
  if (!result.success)
    throw configFileRefusal(
      configPath,
      "has invalid linkage_terms: " +
        describeSchemaIssues(result.error.issues, "camelized"),
    );

  // The explicit standardization is optional. The parse camelizes the on-disk
  // snake_case keys (a step's `input_format`) before validating, like
  // linkage_terms above and like the `parseExchangeSpec` the run path reads the
  // same block through, so a step's params meet the declared-type check and the
  // function library under the one spelling both look up. An invalid block is
  // reported as a usage error, like invalid linkage_terms above.
  const rawStd = obj["standardization"];
  let standardization: Standardization | undefined;
  if (rawStd !== undefined) {
    const stdResult = safeParseStandardizationTheReaderWrote(rawStd);
    if (!stdResult.success)
      throw configFileRefusal(
        configPath,
        "has invalid standardization: " +
          describeSchemaIssues(stdResult.error.issues, "camelized"),
      );
    standardization = stdResult.data;
  }

  // The explicit metadata is optional. The parse camelizes the on-disk
  // snake_case keys (e.g. `is_payload`) before validating, like linkage_terms
  // above. An invalid block is reported as a usage error rather than silently
  // dropped, so the satisfiability check cannot fall back to name inference on a
  // config the operator believes types its columns explicitly.
  const rawMetadata = obj["metadata"];
  let metadata: Metadata | undefined;
  if (rawMetadata !== undefined) {
    const metaResult = safeParseMetadataTheReaderWrote(rawMetadata);
    if (!metaResult.success)
      throw configFileRefusal(
        configPath,
        "has invalid metadata: " +
          describeSchemaIssues(metaResult.error.issues, "camelized"),
      );
    metadata = metaResult.data;
  }

  return {
    status: "loaded",
    source: {
      linkageTerms: result.data,
      standardization,
      metadata,
      csvDelimiter: readCsvDelimiterDeclaration(obj, configPath),
      retainsFiles: readRetainFilesDeclaration(obj),
      linkageTermsStanding: readLinkageTermsStanding(obj),
    },
  };
}

/**
 * The config's `csv_delimiter`, resolved and graded here through core's own
 * spelling resolver and accepted-set rule -- the pair the exchange spec's
 * schema applies to the same key -- so this read and a later `alcove
 * exchange` over the same file take the same character and refuse the same
 * values. A value the rule refuses is a {@link UsageError}, like the invalid
 * blocks above: a command that read on past it would check the operator's
 * input by a delimiter their exchange will never run.
 *
 * Both key spellings are accepted, matching `saveConfig`'s snake_case write.
 */
function readCsvDelimiterDeclaration(
  obj: Record<string, unknown>,
  configPath: string,
): string | undefined {
  const declared = obj["csv_delimiter"] ?? obj["csvDelimiter"];
  if (declared === undefined) return undefined;
  if (typeof declared !== "string")
    throw configFileRefusal(
      configPath,
      "has an invalid csv_delimiter: write the delimiter as text, as in " +
        '`csv_delimiter: "|"`',
    );
  const resolved = normalizeCsvDelimiter(declared);
  if (!isCsvDelimiterChoice(resolved))
    throw configFileRefusal(
      configPath,
      "has an invalid csv_delimiter: " + csvDelimiterRefusal(declared),
    );
  return resolved;
}

/**
 * The standing of a loaded config's terms, read from the presence of a
 * top-level `expected_partner_deduplicate` at its fixed key, unparsed for
 * the same reason {@link readRetainFilesDeclaration} reads its own key that
 * way. Both spellings are accepted, matching `saveConfig`'s snake_case
 * write.
 *
 * Presence alone decides it, on {@link linkageTermsStandingOf}'s rule that
 * the record says an acceptance happened rather than what was agreed. A
 * value the strict paths refuse is refused there, by core's schema, on the
 * commands that build an exchange from the file.
 */
function readLinkageTermsStanding(
  obj: Record<string, unknown>,
): LinkageTermsStanding {
  const declared =
    obj["expected_partner_deduplicate"] ?? obj["expectedPartnerDeduplicate"];
  return declared === undefined ? "held-alone" : "accepted-with-partner";
}

/**
 * The config's `connection.options.retain_files`, read as a single boolean
 * at its fixed path so a still-placeholder connection block is not
 * validated on the way (see {@link ConfigLinkageSource.retainsFiles}). Both
 * key spellings are accepted, matching `saveConfig`'s snake_case write.
 *
 * Only a literal `true` counts as a declaration; every other shape yields
 * false.
 *
 * A `webrtc` connection declares nothing whatever its options say. This is
 * a runtime gate, not a schema refusal: `SharedOptionsSchema` silently
 * drops an unknown `retainFiles` on a webrtc connection's `options` rather
 * than rejecting it, so a hand-authored config pairing `channel: webrtc`
 * with `retain_files: true` loads successfully. In-repo writers are held to
 * this by the type system instead (`WebRTCConnectionConfig.options` has no
 * `retainFiles` member); that protection does not reach a hand-authored
 * file, which is what this function's own check is for.
 */
function readRetainFilesDeclaration(config: Record<string, unknown>): boolean {
  const connection = config["connection"];
  if (connection === null || typeof connection !== "object") return false;
  const block = connection as Record<string, unknown>;
  if (block["channel"] === "webrtc") return false;
  const options = block["options"];
  if (options === null || typeof options !== "object") return false;
  const entry = options as Record<string, unknown>;
  return entry["retain_files"] === true || entry["retainFiles"] === true;
}

/** A webrtc connection block whose create-mode server may still lack `host`. */
export type WebRTCConnectionAwaitingAddress = Extract<
  ConnectionConfigAwaitingAddress,
  { channel: "webrtc" }
>;

/** An sftp connection block whose create-mode server may still lack `host`. */
export type SFTPConnectionAwaitingAddress = Extract<
  ConnectionConfigAwaitingAddress,
  { channel: "sftp" }
>;

/**
 * The connection block of the config at `configPath` when it declares
 * `channel: webrtc`, validated through the connection schema, or `undefined`
 * for any other channel or no block: an offline `invite` names that
 * connection's coordination server and relay in its invitation. Every other
 * channel's block stays unread, so a placeholder one still mints (see
 * {@link ConfigLinkageSource.retainsFiles}). No `@path` reference is
 * resolved; the invitation takes no credential.
 *
 * A webrtc block that fails the schema is a {@link UsageError}: an invitation
 * minted without it would name no coordination server or relay while the
 * operator's file names both.
 */
export function loadConfigWebRTCConnection(
  configPath: string,
): WebRTCConnectionAwaitingAddress | undefined {
  const connection = loadConfigConnectionBlock(
    configPath,
    (block) => block["channel"] === "webrtc",
  );
  return connection?.channel === "webrtc" ? connection : undefined;
}

/**
 * The connection block of the config at `configPath` when it declares
 * `channel: sftp` and its server states a `provision` block, validated through
 * the connection schema, or `undefined` otherwise: an offline `invite` sends a
 * create-mode block's call and names the server it returns in its invitation.
 * An sftp block stating no `provision` stays unread, so a placeholder one still
 * mints. No `@path` reference is resolved.
 *
 * A block that fails the schema is a {@link UsageError}, so a misspelled
 * `mode` is refused rather than minting an invitation that names no server.
 */
export function loadConfigProvisionedSFTPConnection(
  configPath: string,
): SFTPConnectionAwaitingAddress | undefined {
  const connection = loadConfigConnectionBlock(configPath, (block) => {
    if (block["channel"] !== "sftp") return false;
    const server = block["server"];
    return (
      server !== null &&
      typeof server === "object" &&
      (server as Record<string, unknown>)["provision"] !== undefined
    );
  });
  return connection?.channel === "sftp" ? connection : undefined;
}

function loadConfigConnectionBlock(
  configPath: string,
  wanted: (block: Record<string, unknown>) => boolean,
): ConnectionConfigAwaitingAddress | undefined {
  let source: string;
  try {
    source = fs.readFileSync(configPath, "utf8");
  } catch (err: unknown) {
    throw configFileRefusal(
      configPath,
      "could not be read: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const raw = parseSensitiveYaml(source, configFileLabel(configPath));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return undefined;
  const connection = (raw as Record<string, unknown>)["connection"];
  if (connection === null || typeof connection !== "object") return undefined;
  const block = connection as Record<string, unknown>;
  if (!wanted(block)) return undefined;
  const result = safeParseConnectionConfigAwaitingAddress(connection);
  if (!result.success)
    throw configFileRefusal(
      configPath,
      `has an invalid ${String(block["channel"])} connection block: ` +
        describeSchemaIssues(
          result.error.issues.map((issue) => ({
            ...issue,
            path: ["connection", ...issue.path],
          })),
          "camelized",
        ),
    );
  return result.data;
}

/**
 * Write the server address a create-mode `server.provision` endpoint returned
 * into `connection.server` of an existing `alcove.yaml`, in place: `host`
 * always, `port` and `path` when the answer states them, every other field --
 * `provision` among them -- and the operator's comments and key order left as
 * they are. Rewritten with the same owner-only permissions {@link saveConfig}
 * uses; throws if the file cannot be read, parsed or updated.
 */
export function persistProvisionedServerAddress(
  configPath: string,
  address: ProvisionedServerAddress,
): void {
  const serialized = editSensitiveYamlDocument(
    fs.readFileSync(configPath, "utf8"),
    configFileLabel(configPath),
    (doc) => {
      const fields: Array<[string, string | number]> = [["host", address.host]];
      if (address.port !== undefined) fields.push(["port", address.port]);
      if (address.path !== undefined) fields.push(["path", address.path]);
      for (const [field, value] of fields) {
        normalizeKeyPathSpelling(configPath, doc, [
          "connection",
          "server",
          field,
        ]);
        try {
          doc.setIn(["connection", "server", field], value);
        } catch (err) {
          throw configFileRefusal(
            configPath,
            "could not be updated with the created server's address " +
              `(${err instanceof Error ? err.message : String(err)}); ` +
              "connection.server must be a mapping.",
          );
        }
      }
    },
  );
  writeFileOwnerOnly(configPath, serialized);
}

/**
 * The linkage-terms source for `invite`'s config-as-source path: the config
 * named at `configPath`, or `undefined` when no file exists there (the
 * caller then falls back to inferring terms from an input file).
 *
 * A config present at the path is the authoritative source of the
 * invitation's linkage terms, so one that defines none cannot serve as that
 * source and is a {@link UsageError} rather than a silent fall-through to
 * input inference.
 *
 * The file here is this party's own configuration, so a rule set it names
 * instead of writing the rules out is resolved (see
 * {@link NamedRuleSetRules}).
 */
export function loadConfigLinkageSource(
  configPath: string,
): ConfigLinkageSource | undefined {
  const result = readConfigLinkageSource(configPath, "from-the-named-set");
  if (result.status === "no-config-file") return undefined;
  if (result.status === "no-linkage-terms")
    throw configFileRefusal(
      configPath,
      "has no linkage_terms and cannot be used as the source for an " +
        "invitation; supply an input file or a configuration that defines " +
        "linkage terms",
    );
  return result.source;
}

/**
 * A field-delimiter choice as a message states it: the character in quotes,
 * escaped for the sink that shows it, or the word it is written as on a command
 * line and in a config -- `tab`, since a literal tab renders as blank space
 * where the operator reads it, and `detect`, which names no character at all.
 */
function csvDelimiterLabel(delimiter: string): string {
  if (delimiter === "\t") return "tab";
  if (delimiter === CSV_DELIMITER_DETECT) return CSV_DELIMITER_DETECT;
  return `"${sanitizeForDisplay(delimiter)}"`;
}

/**
 * What a configuration's recorded `csv_delimiter` does to every later run over
 * that file, as {@link csvDelimiterForRun}'s report states it: a character is
 * both read and written, while {@link CSV_DELIMITER_DETECT} is read by detection
 * and written as a comma -- the value core's `resultCsvDelimiter` resolves for
 * it.
 */
function recordedCsvDelimiterEffect(configured: string): string {
  return configured === CSV_DELIMITER_DETECT
    ? `follows the csv_delimiter (${CSV_DELIMITER_DETECT}) that file records: ` +
        "it takes the delimiter from the file itself and writes commas"
    : "reads and writes by the csv_delimiter " +
        `(${csvDelimiterLabel(configured)}) that file records`;
}

/**
 * The field delimiter one run reads its CSV by and writes its result with:
 * `--csv-delimiter` where the command line gives it, the configuration's
 * `csv_delimiter` otherwise -- the precedence every command that reads a CSV
 * applies.
 *
 * A flag naming something the configuration does not is reported where that
 * file governs later runs: it reads and writes every exchange run from it, so
 * an operator who meant to change those has a field to edit rather than a flag
 * to repeat. A flag naming what the file already records describes the run and
 * is not reported, and neither is one over a file recording no delimiter --
 * there is no recorded value for the run to disagree with, and a file recording
 * none reads and writes commas.
 *
 * `configPath` is the configuration this command read and leaves in place. A
 * caller whose configuration governs no later run -- one that writes the
 * delimiter this run used, or verifies files named on its own command line --
 * resolves the two values without this helper.
 */
export function csvDelimiterForRun(params: {
  configured: string | undefined;
  supplied: string | undefined;
  configPath: string;
  warn: (message: string) => void;
}): string | undefined {
  const { configured, supplied, configPath, warn } = params;
  if (supplied === undefined) return configured;
  if (configured !== undefined && configured !== supplied) {
    const named = redactAndRenderOperatorSuppliedText(
      operatorSuppliedText(configPath),
    );
    warn(
      `--csv-delimiter ${csvDelimiterLabel(supplied)} applies to this run; ` +
        `every later exchange over ${named} ` +
        `${recordedCsvDelimiterEffect(configured)}. ` +
        `Edit csv_delimiter in ${named} to change it.`,
    );
  }
  return supplied;
}
