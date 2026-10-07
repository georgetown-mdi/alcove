/**
 * The command-line export of a managed (recurring) exchange: the record
 * composed into the two files `alcove exchange` opens -- `alcove.yaml` and
 * `.alcove.key` -- plus the command that runs them, letting an operator with
 * a host scheduler move a managed exchange onto the CLI
 * (docs/notes/managed-exchange-design.md, "Who this is for").
 *
 * This module is the pure half -- no download, no store write, no spend; the
 * one thing it reads beyond the record is this browser's relay settings,
 * through an injected reader.
 *
 * - It SPLITS the export artifact rather than serializing a second format.
 *   The config text is core's {@link serializeExchangeDocument}, the writer
 *   Alcove's own `saveConfig` uses, and the key fields are the artifact
 *   module's {@link keyFileFieldsFromRecord}: the CLI's own file shapes
 *   (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Export artifact"). This adds only
 *   the two files' framing and the two fields the artifact does not hold.
 * - It INJECTS a webrtc `connection.role` from the record's local `side`, at
 *   export time only: the stored document holds none (the spec's "Role: a
 *   local `side` field, not the document"), while the CLI derives its
 *   rendezvous peer id from `role` (`apps/cli/src/run/prepare.ts`). The sftp and
 *   filedrop connections have no `role`, and their records no `side`. Nothing
 *   here writes back.
 * - It INCLUDES the max-age policy in the document as
 *   `authentication.token_max_age_days`: the CLI stamps a rotated token's
 *   `expires` only from that config key. The EXPORTED document may hold an
 *   `authentication` block while the STORED document must not (the read-path
 *   refine in {@link ./managedExchangeRecord.ts}); the spelling is the
 *   block's operator-authored, secret-free one, and the block is a strict
 *   object, so a typo fails closed.
 * - It REFUSES any stored document the app could not have held: a
 *   connection holding a field outside what a configuration on its channel
 *   holds, or a literal credential, a stored `authentication` block, or a
 *   top-level document field outside what a command-line configuration holds.
 *   Each is reachable only by importing a hand-crafted artifact, whose embedded
 *   document validates against the full exchange schema -- which can represent
 *   a TURN `credential`, a `provider_options` map, an `ice_provision` auth
 *   block, a PeerJS `server.key`/`server.username`, and a shared secret. A
 *   connection on a channel this app does not run exports like any other:
 *   exporting it is how the operator runs it, and an sftp `@path` reference it
 *   holds is written back as read, for the CLI to resolve
 *   (`apps/cli/src/util/atSignRefs.ts`). A `signing` block a configuration-only
 *   record holds is written back as read too, and so is one whose mode is
 *   `none` on a record that runs here; the record schema refuses any other
 *   mode beside a secret, so no artifact installs one.
 * - It WRITES the relay key registration a record's runs make: the registrar
 *   as `connection.relay_registrar`, with this browser's own TURN urls as the
 *   `connection.turn` entries whose credential each run mints -- the relay a
 *   run here registers for, and one the command line requires beside a
 *   registrar -- and a pending registration as the key file's own marker,
 *   which the command line's next run retries before it dials. A record whose
 *   runs relay through the partner's relay
 *   ({@link managedExchangeRelaysThroughPartner}) registers nothing, so it
 *   exports neither. A registrar with no own TURN url to write, and a
 *   registration a re-invite left pending, which no run can confirm, are
 *   refused.
 *
 * The key file is a plaintext credential under the CLI key file's own trust
 * model: custody and storage permissions, never a passphrase (the spec's
 * "Plaintext, custody-protected"; docs/SECURITY_DESIGN.md, "Key file
 * security"). The configuration half holds no secret -- the shared secret
 * and any `expires` ride the key file alone.
 */

import {
  ExchangeSpecSchema,
  relayRegistrarLabel,
  serializeExchangeDocument,
  serializeKeyFile,
} from "@alcove/core";

import { HANDOFF_LOG_FILE_NAME, bindPathsIn } from "@jobs/handoffBindPaths";

import { readOwnRelaySetting } from "../transport/ownRelaySetting";

import {
  connectionFieldsNotHeld,
  fieldsOutsideComposableDocument,
  literalCredentialFields,
} from "./managedCommandLineDocument";
import { MANAGED_RELAY_REENROLLMENT_STEP } from "./managedRelayRegistration";
import { keyFileFieldsFromRecord } from "./managedExchangeArtifact";
import { managedExchangeRelaysThroughPartner } from "./managedExchangeRecord";

import { MANAGED_INPUT_FILE_NAME } from "./managedInputHandle";
import { shellJoinCommand } from "./recurringHandoff";

import type {
  ConnectionConfig,
  ExchangeSpec,
  RelayRegistrar,
  WebRTCConnectionConfig,
} from "@alcove/core";
import type {
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
  RunnableManagedExchangeRecord,
} from "./managedExchangeRecord";
import type { HandoffBindPath } from "@jobs/handoffBindPaths";
import type { OwnRelayRead } from "../transport/ownRelaySetting";

/** The config file name `alcove exchange` reads at its default config path
 * (`DEFAULT_CONFIG_PATH`, `apps/cli/src/config.ts`), so a run in the folder
 * holding the exported files needs no `--config-file`. */
export const CRON_EXPORT_CONFIG_FILE_NAME = "alcove.yaml";

/** The key file name `alcove exchange` reads at its default key path
 * (`DEFAULT_KEY_PATH`, `apps/cli/src/keyFile.ts`), so a run in the folder holding
 * the exported files needs no `--key-file`. */
export const CRON_EXPORT_KEY_FILE_NAME = ".alcove.key";

/** The input CSV the emitted command links: the name a browser run reads from
 * the exchange's working folder, so the folder keeps one layout on either side.
 * It is a positional argument of the command rather than a hole in the exported
 * configuration. */
export const CRON_EXPORT_INPUT_FILE_NAME = MANAGED_INPUT_FILE_NAME;

/** The output the emitted command names: the folder it runs in
 * (docs/spec/EXCHANGE_RECORD.md, Result file name). Passing an output path
 * (rather than defaulting to stdout) is what gets the matched-records CSV the
 * owner-only treatment the key file gets -- a shell redirect leaves it at the
 * umask (see docs/SECURITY_DESIGN.md, "Key file security", Result CSV output). */
export const CRON_EXPORT_OUTPUT_FOLDER = "./";

/** The media type the configuration half is written to disk under: the exchange
 * document is the YAML the CLI's config loader reads. */
export const CRON_EXPORT_CONFIG_MIME = "application/yaml";

/** The media type the key half is written to disk under: `.alcove.key` is the
 * JSON document the CLI's key-file reader parses. */
export const CRON_EXPORT_KEY_MIME = "application/json";

/** One exported file: the name it must be saved under for the emitted command to
 * find it, its exact contents, and the media type it is written under. */
interface ManagedCronExportFile {
  /** The file name the CLI opens this content at. */
  fileName: string;
  /** The file's contents, ready to write verbatim. */
  text: string;
  /** The media type a download writes the file under. */
  mimeType: string;
}

/**
 * The configuration half of the command-line hand-off: the `alcove.yaml` the
 * CLI loads, and the invocation that runs it. The command names no path from
 * any machine -- the config and key are read at their defaults -- so it runs in
 * the folder the file is saved to, rather than a template with placeholders to
 * fill. It holds no secret, which is what lets a configuration-only record
 * compose it: an sftp credential it names is an `@path` reference.
 */
export interface ManagedCommandLineConfig {
  /** The `alcove.yaml` half: the exchange-file document, with `role` injected
   * and any max-age policy held, and no secret. */
  config: ManagedCronExportFile;
  /** The command to run in the folder holding that file, and the key file where
   * the exchange has one: {@link argv} quoted for a POSIX shell. */
  command: string;
  /** The `alcove exchange` invocation the command runs, as its arguments. */
  argv: Array<string>;
  /** The absolute paths outside the folder the configuration names, which a
   * container run mounts at their own path. */
  bindPaths: Array<HandoffBindPath>;
}

/**
 * Everything the operator needs to run a managed exchange from the command
 * line: the two files and the invocation.
 */
export interface ManagedCronExport extends ManagedCommandLineConfig {
  /** The `.alcove.key` half: the shared secret, any `expires`, and any
   * pending relay key registration. A plaintext credential -- this is the file
   * the handover's custody rules are about. */
  key: ManagedCronExportFile;
}

/** What to do about stored content only an imported file could have put
 * there, naming that content as `pronoun`. */
function removeAndImportAgain(pronoun: "it" | "them"): string {
  return (
    `Remove ${pronoun} from the file you imported this exchange from, ` +
    "import it again, and then export again."
  );
}

/**
 * Narrow a record's stored connection to what a configuration on its channel
 * holds, refusing any field outside it -- the exchange-file schema alone
 * admits the credential-bearing fields -- and any credential stated as a
 * literal value rather than an `@path`. A hard refusal, not a warning: this is
 * content the import would have refused, reachable only through a hand-crafted
 * artifact.
 */
function heldConnectionOrRefuse(exchangeFile: ExchangeSpec): ConnectionConfig {
  const connection = exchangeFile.connection;
  const outside = connectionFieldsNotHeld(connection);
  if (outside.length > 0)
    throw new Error(
      "This exchange's connection settings include fields this app does " +
        `not export to the command line: ${outside.join(", ")}. ` +
        removeAndImportAgain("them"),
    );
  const literal = literalCredentialFields(connection);
  if (literal.length > 0)
    throw new Error(
      "This exchange's connection settings state a credential as a value, " +
        "and the command-line export writes a credential only as a file " +
        `reference beginning with @: ${literal.join(", ")}. Replace each ` +
        "with a file reference in the file you imported this exchange from, " +
        "import it again, and then export again.",
    );
  return connection;
}

/**
 * The connection fields that register the relay key at `registrar`: the
 * registrar, and this browser's own TURN urls as entries whose credential
 * each run mints, which the command line requires beside a registrar and
 * registers only for. With no own TURN url, or a relay setting this build
 * cannot read, the export is refused rather than written without the
 * registrar, whose absence would leave the relay holding the key of a secret
 * the first command-line run rotates past.
 */
function relayRegistrationConnectionFields(
  registrar: RelayRegistrar,
  readOwn: () => OwnRelayRead,
): Pick<WebRTCConnectionConfig, "turn" | "relayRegistrar"> {
  const own = readOwn();
  const registers =
    `This exchange registers its relay key at ${relayRegistrarLabel(registrar)}, ` +
    "and the command line registers it only for a TURN relay named in " +
    "the configuration, ";
  if (own.kind === "unreadable")
    throw new Error(
      registers +
        "but this browser's relay setting could not be read. Set it again " +
        "on the Relay server page, then export again.",
    );
  const turn = own.kind === "set" ? own.relay.turn : [];
  if (turn.length === 0)
    throw new Error(
      registers +
        "but this browser's relay settings name no TURN url to write there. " +
        "Add your relay's TURN url on the Relay server page, or stop " +
        "registering under Relay registration on this exchange's page, then " +
        "export again.",
    );
  return {
    turn: turn.map((url) => ({ url })),
    relayRegistrar: registrar,
  };
}

/**
 * The connection the export writes: the stored one, with a webrtc `role` set
 * from the record's `side` and, on a record whose runs register at a relay
 * registrar, the fields that register there
 * ({@link relayRegistrationConnectionFields}). A webrtc record always holds a
 * side (the record schema binds the two), so a missing one is refused rather
 * than exported roleless for the CLI to refuse at the operator's first
 * scheduled run.
 */
function exportedConnection(
  connection: ConnectionConfig,
  record: ManagedExchangeRecord,
  readOwn: () => OwnRelayRead,
): ConnectionConfig {
  if (connection.channel !== "webrtc") return connection;
  if (record.side === undefined)
    throw new Error(
      "This exchange does not record whether you are the inviter or the " +
        "acceptor, so it cannot be exported to the command line. Import " +
        "this exchange again, and then export again.",
    );
  return {
    ...connection,
    role: record.side,
    ...(record.relayRegistrar !== undefined &&
    !managedExchangeRelaysThroughPartner(record)
      ? relayRegistrationConnectionFields(record.relayRegistrar, readOwn)
      : {}),
  };
}

/**
 * Refuse a record whose relay key registration a re-invite left pending: the
 * registrar holds the key of the secret the re-invite replaced, which is not
 * kept, so the command line's retry of the key file's marker, signed with the
 * current key, would be refused at its first run.
 */
function assertNoReinviteRegistrationPending(
  record: RunnableManagedExchangeRecord,
): void {
  if (record.relayRegistrationPendingReason !== "reinvite") return;
  const registrar =
    record.relayRegistrar === undefined
      ? "the relay registrar"
      : relayRegistrarLabel(record.relayRegistrar);
  throw new Error(
    "This exchange's re-invite replaced its shared secret, and " +
      `${registrar} has not confirmed the relay key derived from the new ` +
      "one, so a command-line run could not " +
      `register it either. First ${MANAGED_RELAY_REENROLLMENT_STEP}, then ` +
      "export again.",
  );
}

/**
 * Refuse a stored document holding an `authentication` block: the composed
 * document's block is injected from the record's local max-age policy alone,
 * so a stored one would ride the document spread into the configuration half
 * -- `shared_secret` and all. The record read path refines such a document
 * away ({@link ./managedExchangeRecord.ts}); this is that invariant enforced
 * as a check on the shape the composer is actually handed.
 */
function assertNoStoredAuthentication(exchangeFile: ExchangeSpec): void {
  if (exchangeFile.authentication !== undefined)
    throw new Error(
      "This exchange's settings include an authentication block, which " +
        "this app does not export to the command line. " +
        removeAndImportAgain("it"),
    );
}

/**
 * Refuse a document holding a top-level field outside what a command-line
 * configuration holds ({@link fieldsOutsideComposableDocument}), so the
 * document spread cannot republish a field no import admitted into the
 * emitted alcove.yaml.
 */
function assertComposableDocumentFields(document: ExchangeSpec): void {
  const outside = fieldsOutsideComposableDocument(document);
  if (outside.length > 0)
    throw new Error(
      "This exchange's settings include fields this app does not export " +
        `to the command line: ${outside.join(", ")}. ` +
        removeAndImportAgain("them"),
    );
}

/**
 * Compose the exchange-file document the export holds: the stored document
 * with a webrtc `role` set from the record's `side` and, when the record holds
 * a max-age policy, an `authentication` block holding it, and on a record
 * whose runs register at a relay registrar, the fields that register there.
 * Returns the schema's parse result rather than the assembled input, matching
 * `assembleExchangeSpec`'s discipline, so a value the exchange-file schema
 * would not accept fails here rather than at the operator's first scheduled
 * run.
 *
 * @throws {Error} if the stored connection holds a field or a literal
 *   credential the app does not hold, a webrtc record holds no side, the
 *   stored document holds an `authentication` block, it holds a top-level
 *   field the app does not compose, or the record's runs register at a relay
 *   registrar and this browser's relay settings name no TURN url.
 * @throws {ZodError} if the composed document fails exchange-file validation.
 */
function composeCronExportDocument(
  record: ManagedExchangeRecord,
  readOwn: () => OwnRelayRead,
): ExchangeSpec {
  const connection = heldConnectionOrRefuse(record.exchangeFile);
  assertNoStoredAuthentication(record.exchangeFile);
  const document = ExchangeSpecSchema.parse({
    ...record.exchangeFile,
    connection: exportedConnection(connection, record, readOwn),
    ...(record.tokenMaxAgeDays !== undefined
      ? { authentication: { tokenMaxAgeDays: record.tokenMaxAgeDays } }
      : {}),
  });
  assertComposableDocumentFields(document);
  return document;
}

/** The units above seconds a `--peer-timeout` value is written in, largest
 * first. */
const PEER_TIMEOUT_UNITS: ReadonlyArray<[string, number]> = [
  ["h", 3600],
  ["m", 60],
];

/** `seconds`, a whole number, as the CLI's `<int><unit>` duration in the
 * largest unit that states it exactly. */
function durationFlagValue(seconds: number): string {
  if (!Number.isInteger(seconds))
    throw new Error(
      `This exchange's run window is ${seconds} seconds, and the command ` +
        "line waits only a whole number of seconds. Change the schedule's " +
        "run window, and then export again.",
    );
  for (const [unit, size] of PEER_TIMEOUT_UNITS)
    if (seconds % size === 0) return `${seconds / size}${unit}`;
  return `${seconds}s`;
}

/**
 * The `alcove exchange` invocation the export runs: a log appended in the
 * folder, and on a record with an agreed schedule, a wait for the partner as
 * long as the agreed window, so a run started at the window's open gives up
 * when it closes.
 */
function exportedExchangeArgv(
  schedule: ManagedExchangeSchedule | undefined,
): Array<string> {
  return [
    "alcove",
    "exchange",
    `--log-file=${HANDOFF_LOG_FILE_NAME}`,
    ...(schedule !== undefined
      ? [`--peer-timeout=${durationFlagValue(schedule.windowSeconds)}`]
      : []),
    CRON_EXPORT_INPUT_FILE_NAME,
    CRON_EXPORT_OUTPUT_FOLDER,
  ];
}

/**
 * Compose a managed record's configuration half: the `alcove.yaml` file and
 * the command that runs it. Writes nothing, and is available to every stored
 * record -- including a configuration-only one, whose key file stayed with the
 * machine that runs it and which has no key half to compose.
 *
 * The emitted command is `alcove exchange`'s real invocation --
 * `[options] INPUT_FILE [OUTPUT_FOLDER]`, with the config and key read at their
 * defaults (`apps/cli/src/commands/exchange.ts`) and the options
 * {@link exportedExchangeArgv} adds.
 *
 * @throws {Error} if the record's stored connection holds a field or a
 *   literal credential the app does not hold, its stored document holds an
 *   `authentication` block or a top-level field the app does not compose, or
 *   its runs register at a relay registrar and `readOwn` names no TURN url.
 * @throws {ZodError} if the composed document fails exchange-file validation.
 */
export function composeManagedCronExportConfig(
  record: ManagedExchangeRecord,
  readOwn: () => OwnRelayRead = readOwnRelaySetting,
): ManagedCommandLineConfig {
  const document = composeCronExportDocument(record, readOwn);
  const argv = exportedExchangeArgv(record.schedule);
  return {
    config: {
      fileName: CRON_EXPORT_CONFIG_FILE_NAME,
      text: serializeExchangeDocument(document),
      mimeType: CRON_EXPORT_CONFIG_MIME,
    },
    command: shellJoinCommand(argv),
    argv,
    bindPaths: bindPathsIn(document),
  };
}

/**
 * Compose a managed record into the CLI's two files and the command that runs
 * them: the configuration half above, plus the key file. The record is read,
 * never written, and no marker, spend, or download is involved; `readOwn`
 * reads this browser's relay settings. The record type is the runnable one,
 * so the key half cannot be asked of a record that holds no secret.
 *
 * @throws {Error} if the record's stored connection holds a field or a
 *   literal credential the app does not hold, its stored document holds an
 *   `authentication` block or a top-level field the app does not compose, its
 *   runs register at a relay registrar and `readOwn` names no TURN url, or a
 *   re-invite left its relay key registration pending.
 * @throws {ZodError} if the composed document fails exchange-file validation.
 */
export function composeManagedCronExport(
  record: RunnableManagedExchangeRecord,
  readOwn: () => OwnRelayRead = readOwnRelaySetting,
): ManagedCronExport {
  const relaysThroughPartner = managedExchangeRelaysThroughPartner(record);
  if (!relaysThroughPartner) assertNoReinviteRegistrationPending(record);
  const commandLine = composeManagedCronExportConfig(record, readOwn);
  const keyFields = keyFileFieldsFromRecord(record);
  if (relaysThroughPartner) delete keyFields.relayRegistrationPendingSince;
  return {
    ...commandLine,
    key: {
      fileName: CRON_EXPORT_KEY_FILE_NAME,
      text: serializeKeyFile(keyFields),
      mimeType: CRON_EXPORT_KEY_MIME,
    },
  };
}
