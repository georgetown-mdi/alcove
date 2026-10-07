import fs from "node:fs";

import type {
  BuiltInLinkageRuleSet,
  ConnectionConfig,
  ConnectionConfigAwaitingAddress,
  ExchangeSpec,
  LinkageRuleSetReference,
  LinkageSetIdentity,
  LinkageTerms,
  Metadata,
  ProvisionedServerAddress,
  RelayLocator,
  Standardization,
} from "@alcove/core";
import {
  BUILT_IN_LINKAGE_RULE_SETS,
  CSV_DELIMITER_DETECT,
  csvDelimiterRefusal,
  findBuiltInLinkageRuleSet,
  isCsvDelimiterChoice,
  isDrawnFromLinkageRuleSet,
  keepOperatorSuppliedText,
  messageWithOperatorText,
  normalizeCsvDelimiter,
  operatorSuppliedText,
  rawDecodeErrorDescription,
  redactAndRenderOperatorSuppliedText,
  redactAndSanitizeForDisplay,
  resolveLinkageRuleSetCitation,
  ruleSetCitation,
  safeParseConnectionConfigAwaitingAddress,
  safeParseLinkageTermsTheReaderWrote,
  safeParseMetadataTheReaderWrote,
  safeParseStandardizationTheReaderWrote,
  sanitizeForDisplay,
  parseExchangeSpec,
  retiredSettingIssue,
  serializeExchangeDocument,
  snakeizeKey,
  snakeizeKeys,
  UsageError,
} from "@alcove/core";

import {
  configFileLabel,
  configFileRefusal,
  normalizeKeyPathSpelling,
} from "./config/persist";
import { writeFileOwnerOnly } from "./fileUtils";
import {
  type ConnectionCredentialFields,
  type SavedConfigWarningOptions,
  warnIfSavedConfigHoldsLiteralCredential,
} from "./literalCredentials";
import { parseSensitiveYaml, editSensitiveYamlDocument } from "./sensitiveFile";

export { applyConnectionOverrides } from "./config/overrides";
export type {
  ConnectionOptionsOverrides,
  ConnectionOverrides,
  ConnectionServerOverrides,
} from "./config/overrides";
export {
  diffLinkageTerms,
  formatReconcileDiffs,
  RECONCILE_UNSET,
  reconcileClause,
  reconcileClauseConflict,
  reconcileConflictError,
  reconcileConflictMessage,
  reconcileDiffValue,
  reconcileValueClause,
} from "./config/reconcileDiffs";
export type {
  ReconcileClause,
  ReconcileDiff,
  ReconcileDiffFit,
  ReconcileSideFit,
} from "./config/reconcileDiffs";
export {
  assertPartnerFingerprintRecordable,
  persistExpectedPartnerDeduplicate,
  persistFilledPayloadReceive,
  persistHostKeyFingerprint,
  persistPartnerFingerprint,
  persistStatedPayloadSend,
  replacedPayloadSendWarning,
} from "./config/persist";

/**
 * Default path for the exchange config file written by the provisioning
 * commands (`invite`, `accept`, and a zero-setup run with `--save`). Matches
 * the default the `exchange` command reads from, so a config written here is
 * found without an explicit `--config-file`.
 */
export const DEFAULT_CONFIG_PATH = "./alcove.yaml";

/**
 * The prefix every fill-this-in value a written configuration holds begins
 * with: the `init` template's and the provisioning commands' host, username,
 * directory, and identity placeholders.
 */
export const CONFIG_PLACEHOLDER_PREFIX = "REPLACE_WITH_";

/**
 * The dotted, snake_case paths of the string values under `value` that still
 * hold a {@link CONFIG_PLACEHOLDER_PREFIX} placeholder, in document order.
 * `path` names `value` itself (`["connection"]`). Matches a placeholder
 * anywhere in the string, so a directory placeholder written as an absolute
 * path (`/REPLACE_WITH_...`) is found too.
 */
export function configPlaceholderFields(
  value: unknown,
  path: ReadonlyArray<string>,
): Array<string> {
  if (typeof value === "string")
    return value.includes(CONFIG_PLACEHOLDER_PREFIX) ? [path.join(".")] : [];
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      configPlaceholderFields(item, [
        ...path.slice(0, -1),
        `${path.at(-1) ?? ""}[${index}]`,
      ]),
    );
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) =>
      configPlaceholderFields(item, [...path, snakeizeKey(key)]),
    );
  return [];
}

/**
 * Refuse a configuration that still holds a {@link CONFIG_PLACEHOLDER_PREFIX}
 * value under `value`, naming the field and the file. The value itself is
 * left out of the message: a credential read from an `@path` file is already
 * resolved here, and its content is not echoed.
 *
 * `remedyFor` may return the closing sentence for a field, in place of the
 * default, for a field a flag can also set for one run.
 *
 * @throws {UsageError} naming the field.
 */
export function assertNoConfigPlaceholder(params: {
  value: unknown;
  path: ReadonlyArray<string>;
  configFile: string;
  remedyFor?: (field: string) => string | undefined;
}): void {
  const field = configPlaceholderFields(params.value, params.path)[0];
  if (field === undefined) return;
  const remedy =
    params.remedyFor?.(field) ??
    `Replace it with this exchange's value before running the exchange.`;
  const message = messageWithOperatorText`config file ${operatorSuppliedText(
    params.configFile,
  )} still has a ${CONFIG_PLACEHOLDER_PREFIX}... placeholder as ${field}. ${remedy}`;
  throw keepOperatorSuppliedText(new UsageError(message.text), message);
}

/**
 * Logs a one-time reminder, on the file-sync channels only, that retain mode
 * is a bilateral agreement with no negotiation: this party has it enabled
 * (with the `lockless_rendezvous` and `timestamp_in_filename` it implies),
 * and the peer must set all three identically. A `retain_files` or
 * `lockless_rendezvous` mismatch fails fast at rendezvous on both sides;
 * `timestamp_in_filename` is not advertised but cannot diverge on its own.
 * Shared by `exchange` and `zero-setup` so the wording cannot drift.
 */
export function announceRetainMode(
  connection: ConnectionConfig,
  log: { info: (message: string) => void },
): void {
  if (
    (connection.channel === "sftp" || connection.channel === "filedrop") &&
    connection.options?.retainFiles === true
  ) {
    log.info(
      "retain mode is enabled, with lockless_rendezvous and " +
        "timestamp_in_filename; your partner must set all three identically " +
        "(these flags are not negotiated).",
    );
  }
}

/**
 * Validates the CLI-only entry-sweep flags. `--force-retain-sweep` is an
 * escalation of `--sweep-exchange-files`, never standalone: passing it alone
 * is a {@link UsageError} (exit 64). Whether retain is actually in play is a
 * runtime property of the directory, checked instead by the connection's
 * pre-sweep inspection. Shared by `exchange` and `zero-setup`.
 */
export function assertRetainSweepGuard(
  sweepExchangeFiles: boolean,
  forceRetainSweep: boolean,
): void {
  if (forceRetainSweep && !sweepExchangeFiles)
    throw new UsageError(
      "--force-retain-sweep requires --sweep-exchange-files; it escalates the " +
        "sweep to wipe a retain-mode transcript and is meaningless on its own.",
    );
}

// --- Config writer -----------------------------------------------------------

/**
 * Write a configuration's text to `configPath` owner-read-only, then warn
 * when its connection holds a credential as typed rather than as an `@path`.
 * Every writer of a new configuration goes through here, so the warning
 * comes from one place.
 */
export function writeConfigFile(
  configPath: string,
  text: string,
  connection: ConnectionCredentialFields | undefined,
  options: { exclusive?: boolean } & SavedConfigWarningOptions = {},
): void {
  writeFileOwnerOnly(configPath, text, { exclusive: options.exclusive });
  warnIfSavedConfigHoldsLiteralCredential(configPath, connection, options);
}

/**
 * Write an {@link ExchangeSpec} to `configPath` as the snake_case YAML document
 * {@link serializeExchangeDocument} renders -- guidance comments and the
 * shared-secret strip included -- through {@link writeConfigFile}.
 *
 * Does not guard against overwriting an existing file; callers provision
 * through `provisionConfigAndKey`, which runs the conflict gate first.
 */
export function saveConfig(
  configPath: string,
  spec: ExchangeSpec,
  options: { exclusive?: boolean } & SavedConfigWarningOptions = {},
): void {
  writeConfigFile(
    configPath,
    serializeExchangeDocument(spec),
    spec.connection,
    options,
  );
}

/**
 * The fields {@link persistTermsUpdate} writes. `expectedPartnerDeduplicate`
 * is `"unchanged"` where the configuration's record is left as it stands.
 */
export interface TermsUpdateWrite {
  linkageTerms: LinkageTerms;
  expectedPartnerDeduplicate: boolean | "unchanged";
}

/**
 * Replace `linkage_terms` in an existing `alcove.yaml` and refresh the record
 * that follows from it -- `expected_partner_deduplicate` -- in one write, so
 * the record does not state a commitment the new terms do not back. Every
 * other key, the connection block included, keeps its values and its key
 * order, and a line the write does not change keeps its bytes as
 * {@link editSensitiveYamlDocument} allows.
 *
 * The edited document is read back through the same schema `alcove
 * exchange` loads it with before it is written; a document that would not
 * load is refused and the file is left unchanged.
 *
 * Rewritten with the same owner-only permissions, and the same atomic rename,
 * {@link saveConfig} uses.
 *
 * @throws {UsageError} if the edited document would not load.
 */
export function persistTermsUpdate(
  configPath: string,
  write: TermsUpdateWrite,
): void {
  const serialized = termsUpdateDocument(configPath, write);
  const loadError = termsUpdateLoadError(configPath, serialized);
  if (loadError !== undefined)
    throw configFileRefusal(
      configPath,
      "was left unchanged: with the update applied it would not load " +
        `(${describeConfigSchemaError(loadError)}).`,
    );
  writeFileOwnerOnly(configPath, serialized);
}

/**
 * The term of the configuration at `configPath` that {@link persistTermsUpdate}
 * would refuse `write` on, without writing anything: the top-level key, and
 * under `linkage_terms` the field of the linkage terms, of the first schema
 * issue. Undefined where the edited document loads.
 *
 * The top-level key is the operator's own or one this write sets, and the
 * field is named only from a fixed list, so no partner-chosen text is named.
 */
export function termsUpdateInvalidTerm(
  configPath: string,
  write: TermsUpdateWrite,
): string | undefined {
  const loadError = termsUpdateLoadError(
    configPath,
    termsUpdateDocument(configPath, write),
  );
  if (loadError === undefined) return undefined;
  const issues =
    loadError !== null && typeof loadError === "object" && "issues" in loadError
      ? (loadError as { issues?: ReadonlyArray<SchemaIssue> }).issues
      : undefined;
  const [top, field] = (issues?.[0]?.path ?? []).map((segment) =>
    typeof segment === "string" ? snakeizeKey(segment) : undefined,
  );
  if (top === undefined) return "linkage_terms";
  return top === "linkage_terms" &&
    field !== undefined &&
    (NAMED_LINKAGE_TERMS_FIELDS as ReadonlyArray<string>).includes(field)
    ? `${top}.${field}`
    : top;
}

const NAMED_LINKAGE_TERMS_FIELDS = [
  "version",
  "identity",
  "date",
  "algorithm",
  "linkage_strategy",
  "output",
  "deduplicate",
  "linkage_fields",
  "linkage_keys",
  "linkage_rule_set",
  "payload",
  "legal_agreement",
] as const;

function termsUpdateDocument(
  configPath: string,
  write: TermsUpdateWrite,
): string {
  return editSensitiveYamlDocument(
    fs.readFileSync(configPath, "utf8"),
    configFileLabel(configPath),
    (doc) => {
      for (const record of ["linkage_terms", "expected_partner_deduplicate"])
        normalizeKeyPathSpelling(configPath, doc, [record]);
      doc.setIn(
        ["linkage_terms"],
        doc.createNode(snakeizeKeys(write.linkageTerms)),
      );
      if (write.expectedPartnerDeduplicate !== "unchanged")
        doc.setIn(
          ["expected_partner_deduplicate"],
          write.expectedPartnerDeduplicate,
        );
    },
  );
}

function termsUpdateLoadError(configPath: string, serialized: string): unknown {
  try {
    parseExchangeSpec(
      configWithNamedRuleSetRules(
        parseSensitiveYaml(serialized, configFileLabel(configPath)),
        configPath,
      ),
    );
    return undefined;
  } catch (err) {
    return err;
  }
}

/**
 * What {@link persistInvitationRelay} did to a kept configuration's
 * `connection.invitation_relay`.
 */
export type InvitationRelayRefresh = "set" | "removed" | "absent" | "notWebrtc";

/**
 * Write, overwrite, or remove `connection.invitation_relay` in an existing
 * `alcove.yaml` from the invitation an acceptance has just consented to,
 * leaving every other key of the connection block untouched. The field is
 * invitation-derived rather than the operator's own, so an acceptance that
 * keeps the configuration refreshes it: a relay a prior invitation named must
 * not stay in force after the operator was shown this invitation's.
 *
 * `relay === undefined` removes the field. A connection block whose channel
 * is not webrtc holds no relay and is left as it is.
 *
 * Rewritten with the same owner-only permissions {@link saveConfig} uses.
 * Throws if the file cannot be read or parsed, since the caller just read it.
 */
export function persistInvitationRelay(
  configPath: string,
  relay: RelayLocator | undefined,
): InvitationRelayRefresh {
  // Widened by the assertion: the edit callback assigns it, which control-flow
  // narrowing does not follow.
  let outcome = "notWebrtc" as InvitationRelayRefresh;
  const serialized = editSensitiveYamlDocument(
    fs.readFileSync(configPath, "utf8"),
    configFileLabel(configPath),
    (doc) => {
      normalizeKeyPathSpelling(configPath, doc, ["connection", "channel"]);
      if (doc.getIn(["connection", "channel"]) !== "webrtc") return;
      const field = ["connection", "invitation_relay"];
      normalizeKeyPathSpelling(configPath, doc, field);
      if (relay === undefined) {
        outcome = doc.hasIn(field) ? "removed" : "absent";
        doc.deleteIn(field);
        return;
      }
      outcome = "set";
      doc.setIn(
        field,
        doc.createNode({
          ...(relay.turn !== undefined ? { turn: relay.turn } : {}),
          ...(relay.stun !== undefined ? { stun: relay.stun } : {}),
        }),
      );
    },
  );
  if (outcome === "set" || outcome === "removed")
    writeFileOwnerOnly(configPath, serialized);
  return outcome;
}

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
type SchemaIssue = {
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

// --- Rules taken from a named rule set ---------------------------------------

/**
 * A rule-set reference as one clause, keys first -- the keys are the specific
 * artifact and the fields the substrate they are built from -- matching the
 * order the invitation display and core's mismatch message render the pair in.
 * Each half is rendered by `renderHalf`, which applies the treatment its sink
 * calls for: a warning escapes the two names for its `log.warn`, a refusal
 * composes them raw for the single escape its display applies.
 */
function ruleSetCitationClause(
  reference: LinkageRuleSetReference,
  renderHalf: (identity: LinkageSetIdentity) => string,
): string {
  return `${renderHalf(reference.keySet)} over ${renderHalf(reference.fieldSet)}`;
}

/**
 * One half of a rule-set citation for a refusal message, through core's
 * terms-value grammar ({@link ruleSetCitation}) and otherwise raw: a fragment
 * composed into an `Error` is escaped once at the sink that shows it, so
 * escaping it here would double-escape every backslash the operator reads.
 */
function refusalRuleSetHalf(identity: LinkageSetIdentity): string {
  return ruleSetCitation(identity.name, identity.version);
}

/**
 * The set identity `raw` writes, or `undefined` where it is not written as one.
 * Shape only, and the shallowest shape a lookup needs: what a name and a
 * version may hold is the linkage-terms schema's to decide, and a citation it
 * refuses reaches the operator under its own issue path either way.
 */
function citedSetIdentity(raw: unknown): LinkageSetIdentity | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return undefined;
  const { name, version } = raw as Record<string, unknown>;
  if (typeof name !== "string" || typeof version !== "string") return undefined;
  return { name, version };
}

/**
 * The rule set `raw` names, or `undefined` where it does not name one whole.
 * Both spellings of each half are read, as every raw-document read here is: a
 * configuration file writes `field_set`, and the camelCase form is what
 * reaches the schema.
 */
function citedRuleSetReference(
  raw: unknown,
): LinkageRuleSetReference | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return undefined;
  const halves = raw as Record<string, unknown>;
  const fieldSet = citedSetIdentity(halves["field_set"] ?? halves["fieldSet"]);
  const keySet = citedSetIdentity(halves["key_set"] ?? halves["keySet"]);
  if (fieldSet === undefined || keySet === undefined) return undefined;
  return { fieldSet, keySet };
}

/**
 * Whether a raw block writes a key under either spelling, a present-but-empty
 * value included: what the document declares is the question here, not what
 * the declaration holds, which the schema decides.
 */
function declaresKey(
  block: Record<string, unknown>,
  written: string,
  camelized: string,
): boolean {
  return Object.hasOwn(block, written) || Object.hasOwn(block, camelized);
}

/** The two rule lists, each as the pair of spellings a raw read accepts. */
const RULE_LIST_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ["linkage_fields", "linkageFields"],
  ["linkage_keys", "linkageKeys"],
];

/**
 * The rule lists `document` writes at its own top level, spelled as it writes
 * them. A list un-indented out of `linkage_terms` lands exactly there, and the
 * block it left then holds no rules at all.
 *
 * The top level and nothing deeper: that is where the mis-indentation puts a
 * list. A list under a key spelled some third way is outside what any read
 * here can see, a limit docs/EXCHANGE_REFERENCE.md states.
 */
function ruleListsWrittenAtTopLevel(document: unknown): Array<string> {
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  )
    return [];
  const top = document as Record<string, unknown>;
  return RULE_LIST_SPELLINGS.flatMap(([written, camelized]) => {
    if (Object.hasOwn(top, written)) return [written];
    if (Object.hasOwn(top, camelized)) return [camelized];
    return [];
  });
}

/**
 * What this build ships, as the sentence the unknown-set refusal states it in.
 * A build shipping none says so rather than trailing an empty list: the
 * refusal is read by someone deciding what to write instead.
 */
function shippedRuleSets(
  ruleSets: ReadonlyArray<BuiltInLinkageRuleSet>,
): string {
  if (ruleSets.length === 0) return "This build ships no rule set at all.";
  const shipped = ruleSets
    .map((ruleSet) =>
      ruleSetCitationClause(ruleSet.reference, refusalRuleSetHalf),
    )
    .join("; ");
  return `It ships ${shipped}.`;
}

/**
 * A raw configuration's `linkage_terms` with its `linkage_fields` and
 * `linkage_keys` taken from the rule set the block's `linkage_rule_set` names,
 * where it names a set this build ships and writes neither list of its own.
 * Every path that reads a configuration file runs its terms through this ahead
 * of the schema, so a named set resolves alike whether the file is read to run
 * an exchange, to mint an invitation from, or to compare against one.
 *
 * Rules are taken whole or not at all:
 *
 * - Both lists written -- what every configuration written to date holds --
 *   are the rules, untouched here. The citation beside them stays the claim
 *   {@link warnOnLinkageRuleSetCitationDrift} judges.
 * - Neither list written, and the citation names a shipped set: both lists
 *   come from that set, and the citation stands as the file wrote it.
 * - Neither list written, and the citation names a set this build does not
 *   ship: refused, naming what was cited and what this build ships. Nothing
 *   here guesses at a name it does not ship, and the file writes no rules to
 *   fall back to.
 * - One list written and the other not: refused. A key set is built from its
 *   own fields, so filling in the missing half would compose the rules of one
 *   exchange from two sources under one name.
 * - Neither list written in the block, but one of them written at the top
 *   level of the document around it: refused, naming where it was found and
 *   where it belongs. A list un-indented out of the block is an editing
 *   mistake, not a file asking to run the whole set.
 *
 * A citation written in some other shape is left for the schema, which names
 * the field and the issue.
 *
 * @param ruleSets the sets a citation is looked up in, this build's own
 * ({@link BUILT_IN_LINKAGE_RULE_SETS}) by default.
 * @param enclosingDocument the raw document the block was read out of, where
 * the caller holds it, for the misplacement check above. Omitting it checks
 * the block alone.
 */
export function linkageTermsWithNamedRuleSetRules(
  rawTerms: unknown,
  configPath: string,
  ruleSets: ReadonlyArray<BuiltInLinkageRuleSet> = BUILT_IN_LINKAGE_RULE_SETS,
  enclosingDocument?: unknown,
): unknown {
  if (
    rawTerms === null ||
    typeof rawTerms !== "object" ||
    Array.isArray(rawTerms)
  )
    return rawTerms;
  const terms = rawTerms as Record<string, unknown>;
  const citation = terms["linkage_rule_set"] ?? terms["linkageRuleSet"];
  if (citation === undefined) return rawTerms;

  const writesFields = declaresKey(terms, "linkage_fields", "linkageFields");
  const writesKeys = declaresKey(terms, "linkage_keys", "linkageKeys");
  if (writesFields && writesKeys) return rawTerms;

  const reference = citedRuleSetReference(citation);
  if (reference === undefined) return rawTerms;
  const cited = ruleSetCitationClause(reference, refusalRuleSetHalf);

  if (writesFields || writesKeys) {
    const written = writesFields ? "linkage_fields" : "linkage_keys";
    const missing = writesFields ? "linkage_keys" : "linkage_fields";
    throw configFileRefusal(
      configPath,
      `names the rule set ${cited} in linkage_terms.linkage_rule_set and ` +
        `writes ${written} but no ${missing}. Alcove takes both lists from ` +
        `a named set or neither: remove ${written} to run the set's own ` +
        `rules, or write ${missing} out beside it.`,
    );
  }

  const misplaced = ruleListsWrittenAtTopLevel(enclosingDocument);
  if (misplaced.length > 0) {
    const names = misplaced.join(" and ");
    const them = misplaced.length === 1 ? "it" : "them";
    throw configFileRefusal(
      configPath,
      `names the rule set ${cited} in linkage_terms.linkage_rule_set and ` +
        "writes no linkage_fields or linkage_keys inside that block, but " +
        `writes ${names} at the top level of the file. Indent ${them} under ` +
        `linkage_terms to run the rules the file holds, or delete ${them} ` +
        "to run the named set's own rules.",
    );
  }

  const ruleSet = findBuiltInLinkageRuleSet(reference, ruleSets);
  if (ruleSet === undefined)
    throw configFileRefusal(
      configPath,
      `names the rule set ${cited} in linkage_terms.linkage_rule_set and ` +
        "writes no linkage_fields or linkage_keys of its own, but this build " +
        `ships no such rule set. ${shippedRuleSets(ruleSets)} Name a set ` +
        "this build ships, or write the linkage_fields and linkage_keys out " +
        "in the file.",
    );

  // Cloned rather than aliased: a built-in set is frozen through every level,
  // and what this returns is a document later passes rewrite.
  return {
    ...terms,
    linkageFields: structuredClone(ruleSet.linkageFields),
    linkageKeys: structuredClone(ruleSet.linkageKeys),
  };
}

/**
 * `rawConfig` with its linkage terms' rules taken from the rule set they name
 * ({@link linkageTermsWithNamedRuleSetRules}), for a caller holding the whole
 * raw document. A new object where anything was filled in, leaving the
 * caller's own value as it read it, and the configuration itself otherwise.
 *
 * Runs on the raw configuration, ahead of the schema: what it fills in is a
 * block the schema requires.
 *
 * @param ruleSets the sets a citation is looked up in, this build's own
 * ({@link BUILT_IN_LINKAGE_RULE_SETS}) by default.
 */
export function configWithNamedRuleSetRules(
  rawConfig: unknown,
  configPath: string,
  ruleSets: ReadonlyArray<BuiltInLinkageRuleSet> = BUILT_IN_LINKAGE_RULE_SETS,
): unknown {
  if (
    rawConfig === null ||
    typeof rawConfig !== "object" ||
    Array.isArray(rawConfig)
  )
    return rawConfig;
  const config = rawConfig as Record<string, unknown>;
  const key = Object.hasOwn(config, "linkage_terms")
    ? "linkage_terms"
    : Object.hasOwn(config, "linkageTerms")
      ? "linkageTerms"
      : undefined;
  if (key === undefined) return rawConfig;
  const filled = linkageTermsWithNamedRuleSetRules(
    config[key],
    configPath,
    ruleSets,
    config,
  );
  return filled === config[key] ? rawConfig : { ...config, [key]: filled };
}

// --- Rule-set citation drift -------------------------------------------------

/**
 * One half of a rule-set citation -- a set's name and content version -- for
 * the drift warning, which names a half on its own wherever it reports on
 * that half alone.
 *
 * The names are free text the config author chose, and `log.warn` is their
 * sink, so each is escaped here before rendering through core's terms-value
 * grammar ({@link ruleSetCitation}) -- the same grammar core's own mismatch
 * message and both consent surfaces use. Escaping BEFORE delimiting:
 * escaping after could truncate a value and take the closing delimiter off
 * it.
 */
function describeRuleSetHalf(identity: LinkageSetIdentity): string {
  return ruleSetCitation(
    redactAndSanitizeForDisplay(identity.name),
    redactAndSanitizeForDisplay(identity.version),
  );
}

/**
 * A rule-set citation as one clause for the drift warning, each half escaped
 * for that sink ({@link ruleSetCitationClause}).
 */
function describeRuleSetCitation(reference: LinkageRuleSetReference): string {
  return ruleSetCitationClause(reference, describeRuleSetHalf);
}

/**
 * Whether an acceptance stands behind a config's linkage terms, which
 * decides the remedy the drift warning can accurately offer for the
 * citation those terms hold.
 *
 * - `held-alone` -- no acceptance stands behind them, so both remedies are
 *   open: drop a citation the rules no longer earn, or put the cited set's
 *   rules back.
 * - `accepted-with-partner` -- an acceptance put them under agreement with
 *   an inviting party. Editing the rules to match the citation would take
 *   them out of that agreement, and the exchange would refuse them against
 *   the partner still running the originals.
 */
export type LinkageTermsStanding = "held-alone" | "accepted-with-partner";

/**
 * What a command can offer its operator besides settling a drifted citation
 * with the party whose acceptance stands behind the terms. Only the
 * `accepted-with-partner` reading takes it.
 *
 * - `decline-to-reuse` -- the command is putting the agreed terms to use, so
 *   the operator can leave them and start from terms that hold no claim
 *   they cannot support.
 * - `author-fresh-terms` -- the command is minting an invitation FROM those
 *   terms, so the operator can author fresh ones instead of reusing the
 *   accepted ones for it.
 */
export type CitationDriftAlternative =
  "decline-to-reuse" | "author-fresh-terms";

/**
 * Whether an acceptance stands behind a loaded config's linkage terms, read
 * from `expected_partner_deduplicate`. `alcove accept` writes this field on
 * every config it writes or reuses, `alcove apply` on every config it applies
 * a terms update to, and nothing else writes one, so its presence is exactly
 * the mark of a config an acceptance stands behind (see
 * {@link persistExpectedPartnerDeduplicate}). Both values read the same
 * way: the record says an acceptance happened, not what was agreed.
 */
export function linkageTermsStandingOf(
  spec: Pick<ExchangeSpec, "expectedPartnerDeduplicate">,
): LinkageTermsStanding {
  return spec.expectedPartnerDeduplicate === undefined
    ? "held-alone"
    : "accepted-with-partner";
}

/**
 * Warn when a loaded config's `linkage_terms.linkage_rule_set` cites a set
 * this build ships over rules that are not drawn from it -- the state a
 * hand edit to `linkage_fields` or `linkage_keys` leaves behind. Left
 * unreported, that citation travels onto the invitation and both parties'
 * exchange records claiming a provenance the rules no longer have.
 *
 * Only a half this build can RESOLVE is judged: a citation naming a set
 * Alcove does not ship has no content here to compare the rules against,
 * so that half is passed over, and each half is judged separately so a
 * foreign half cannot buy the built-in half a pass.
 *
 * Warns rather than refuses: the citation is display-and-record only, and
 * the exchange runs on the declared fields and keys either way.
 *
 * `standing` decides the remedy wording (see {@link LinkageTermsStanding}):
 * terms an acceptance stands behind are agreed with the inviting party, so
 * restoring the cited set's rules would edit terms both parties hold and
 * the exchange would then abort against the partner. `alternative` names
 * what that operator can do instead of settling (see
 * {@link CitationDriftAlternative}).
 *
 * @param ruleSets the sets the citation is resolved against, this build's own
 * ({@link BUILT_IN_LINKAGE_RULE_SETS}) by default. The rules are compared
 * against the set the terms cite, whichever of those it is.
 */
export function warnOnLinkageRuleSetCitationDrift(
  terms: Pick<LinkageTerms, "linkageRuleSet" | "linkageFields" | "linkageKeys">,
  configPath: string,
  log: { warn: (message: string) => void },
  standing: LinkageTermsStanding,
  alternative: CitationDriftAlternative,
  ruleSets: ReadonlyArray<BuiltInLinkageRuleSet> = BUILT_IN_LINKAGE_RULE_SETS,
): void {
  const cited = terms.linkageRuleSet;
  if (cited === undefined) return;

  const shipped = resolveLinkageRuleSetCitation(cited, ruleSets);

  // Each half is judged by handing the predicate that half's shipped
  // declarations over rules with nothing on the other side: an empty list
  // runs neither of the predicate's loops, so the half not under test
  // cannot decide the answer.
  const drifted: string[] = [];
  const reportDrift = (field: string, citedHalf: LinkageSetIdentity): void => {
    drifted.push(
      `its ${field} are not drawn from the ` +
        `${describeRuleSetHalf(citedHalf)} this build ships`,
    );
  };
  if (
    shipped.linkageFields !== undefined &&
    !isDrawnFromLinkageRuleSet(
      {
        reference: cited,
        linkageFields: shipped.linkageFields,
        linkageKeys: [],
      },
      { linkageFields: terms.linkageFields, linkageKeys: [] },
    )
  )
    reportDrift("linkage_fields", cited.fieldSet);
  if (
    shipped.linkageKeys !== undefined &&
    !isDrawnFromLinkageRuleSet(
      { reference: cited, linkageFields: [], linkageKeys: shipped.linkageKeys },
      { linkageFields: [], linkageKeys: terms.linkageKeys },
    )
  )
    reportDrift("linkage_keys", cited.keySet);
  if (drifted.length === 0) return;

  const consequence =
    standing === "accepted-with-partner"
      ? "The citation is recorded in both parties' exchange records, so it " +
        "credits a source these rules did not come from. You accepted these " +
        "terms from the inviting party, so editing the rules here would make " +
        "them differ from that party's and the exchange would refuse them. " +
        (alternative === "author-fresh-terms"
          ? "Agree the citation with that party, or author fresh terms for " +
            "this invitation."
          : "Agree the citation with that party and accept again, or decline " +
            "to reuse these terms.")
      : "This citation is copied into the invitation, into the terms your " +
        "partner reviews, and into both parties' exchange records, so it " +
        "credits a source these rules did not come from. Remove " +
        "linkage_rule_set if you wrote these rules yourself, or restore the " +
        "rules the cited set defines.";

  log.warn(
    `${redactAndRenderOperatorSuppliedText(operatorSuppliedText(configPath))}: ` +
      `linkage_terms.linkage_rule_set cites ` +
      `${describeRuleSetCitation(cited)}, but ${drifted.join(", and ")}. ` +
      consequence,
  );
}
