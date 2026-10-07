import type { ConnectionConfig, ExchangeSpec } from "@alcove/core";
import {
  keepOperatorSuppliedText,
  messageWithOperatorText,
  operatorSuppliedText,
  serializeExchangeDocument,
  snakeizeKey,
  UsageError,
} from "@alcove/core";

import { writeFileOwnerOnly } from "./fileUtils";
import {
  type ConnectionCredentialFields,
  type SavedConfigWarningOptions,
  warnIfSavedConfigHoldsLiteralCredential,
} from "./literalCredentials";

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
  persistInvitationRelay,
  persistPartnerFingerprint,
  persistStatedPayloadSend,
  replacedPayloadSendWarning,
} from "./config/persist";
export type { InvitationRelayRefresh } from "./config/persist";
export {
  persistTermsUpdate,
  termsUpdateInvalidTerm,
} from "./config/termsUpdate";
export type { TermsUpdateWrite } from "./config/termsUpdate";
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
