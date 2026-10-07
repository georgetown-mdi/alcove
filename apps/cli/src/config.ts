import fs from "node:fs";

import type {
  ConnectionConfig,
  ExchangeSpec,
  LinkageTerms,
  RelayLocator,
} from "@alcove/core";
import {
  keepOperatorSuppliedText,
  messageWithOperatorText,
  operatorSuppliedText,
  parseExchangeSpec,
  serializeExchangeDocument,
  snakeizeKey,
  snakeizeKeys,
  UsageError,
} from "@alcove/core";

import { describeConfigSchemaError, type SchemaIssue } from "./config/loaders";
import {
  configFileLabel,
  configFileRefusal,
  normalizeKeyPathSpelling,
} from "./config/persist";
import { configWithNamedRuleSetRules } from "./config/ruleSetCitation";
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
export {
  configWithNamedRuleSetRules,
  linkageTermsStandingOf,
  linkageTermsWithNamedRuleSetRules,
  warnOnLinkageRuleSetCitationDrift,
} from "./config/ruleSetCitation";
export type {
  CitationDriftAlternative,
  LinkageTermsStanding,
} from "./config/ruleSetCitation";
export {
  csvDelimiterForRun,
  describeConfigSchemaError,
  loadConfigLinkageSource,
  loadConfigProvisionedSFTPConnection,
  loadConfigWebRTCConnection,
  persistProvisionedServerAddress,
  readConfigLinkageSource,
} from "./config/loaders";
export type {
  ConfigLinkageSource,
  ConfigLinkageSourceResult,
  NamedRuleSetRules,
  SFTPConnectionAwaitingAddress,
  WebRTCConnectionAwaitingAddress,
} from "./config/loaders";

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
