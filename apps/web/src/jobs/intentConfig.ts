import { stringify as stringifyYaml } from "yaml";

import {
  ExchangeSpecSchema,
  mintExchangeSpec,
  snakeizeKeys,
} from "@alcove/core";

import { composedSigning } from "@jobContract/intentSchemas";

import type {
  ExchangeFileInput,
  ExchangeSpec,
  FileSyncOptions,
} from "@alcove/core";

import type { JobSftpServerEntry } from "@jobContract/sftpConnection";

import type {
  JobExchangeIntent,
  JobExchangeOptions,
  JobFiledropExchangeIntent,
  JobSftpExchangeIntent,
  JobSigningPaths,
  JobWebrtcExchangeIntent,
} from "@jobContract/intentSchemas";
import type { AuthoredSignalingServer } from "./signalingServer";

/**
 * Compose the CLI config document (snake_case YAML the CLI loads verbatim) from a
 * validated filedrop {@link JobExchangeIntent}, setting the connection directory to
 * the operator-configured rendezvous mount (`JOB_RENDEZVOUS_DIR`) both parties can
 * reach. The directory is server-side environment configuration, never a
 * browser-sent string.
 *
 * On a split-provisioned console (`JOB_RENDEZVOUS_OUTBOUND_DIR` set) the
 * caller passes both mounts and the connection holds the CLI's
 * `inbound_path`/`outbound_path` pair instead of the single `path`, never
 * both together, which `mintExchangeSpec`'s own schema refuses. The pair's
 * own rules are core's.
 *
 * The connection is built as a credential-free filedrop locator, so by
 * core's {@link ExchangeFileInput} typing no credential is representable. The
 * shared secret rides the key file; the one `authentication` key composed is
 * the intent's max-age policy ({@link composedAuthentication}). The client's
 * `linkageTerms`, `metadata`, and
 * `standardization` reach the file only after core's schema validation; the
 * one path field (`path`) is set by the server, not the client.
 *
 * Forwarding `metadata`/`standardization` is what makes the operator's data-prep
 * edits authoritative on the console path: the CLI's `prepareForExchange` uses the
 * composed metadata rather than falling back to `inferMetadata`, so a column the
 * operator marked ignored (or non-payload) is not silently disclosed.
 *
 * `expectedPartnerDeduplicate`, when present, is forwarded as the config's
 * `expected_partner_deduplicate`: the CLI holds the inviter's presented
 * `deduplicate` to the value its invitation declared and refuses a
 * contradiction before any key or payload moves. `false` is forwarded
 * verbatim, a real declaration; only an omitted field binds nothing.
 *
 * `signingPaths` supplies the two paths a `signing` block names, which the
 * intent cannot hold; it is read only under `certificate` mode, so a caller
 * composing an unsigned exchange may omit it. The `retention_disposition`
 * note is forwarded verbatim.
 *
 * `include_own_columns` is forwarded verbatim too: a local output-composition
 * setting the CLI reads when it writes this party's result file, adding nothing
 * to what the partner is sent. The schema refuses it beside a count-only
 * algorithm, so an intent pairing the two fails here rather than at the run.
 *
 * `csv_delimiter` is forwarded the same way: the field delimiter the CLI reads
 * this party's own input by and writes its own result with. Core's spec schema
 * resolves the spellings a party may write (`tab`, `detect`) and grades the
 * result, so the composed document holds the same value a hand-authored
 * configuration would. An absent field composes no key, which reads and writes
 * commas.
 */
export function composeConfigDocument(
  intent: JobFiledropExchangeIntent,
  rendezvousPath: string,
  outboundRendezvousPath?: string,
  signingPaths?: JobSigningPaths,
): string {
  return stringifyYaml(
    snakeizeKeys(
      composeFiledropConfigSpec(
        intent,
        rendezvousPath,
        outboundRendezvousPath,
        signingPaths,
      ),
    ),
  );
}

/**
 * The validated spec {@link composeConfigDocument} serializes. Exported as the
 * spec beside {@link composeSftpConfigSpec} so a caller that merges this
 * composition with another document, or renders it through a different writer,
 * reads the same composition rather than re-parsing its text.
 */
export function composeFiledropConfigSpec(
  intent: JobFiledropExchangeIntent,
  rendezvousPath: string,
  outboundRendezvousPath?: string,
  signingPaths?: JobSigningPaths,
): ExchangeSpec {
  const options = intentOptionsToFileSyncOptions(intent.options);
  const {
    metadata,
    standardization,
    expectedPartnerDeduplicate,
    retentionDisposition,
    includeOwnColumns,
    csvDelimiter,
  } = intent;
  const signing = composedSigning(intent, signingPaths);
  const authentication = composedAuthentication(intent);
  const fileInput: ExchangeFileInput = {
    connection: {
      channel: "filedrop",
      ...(outboundRendezvousPath === undefined
        ? { path: rendezvousPath }
        : {
            inboundPath: rendezvousPath,
            outboundPath: outboundRendezvousPath,
          }),
      ...(options !== undefined ? { options } : {}),
    },
    linkageTerms: intent.linkageTerms,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(standardization !== undefined ? { standardization } : {}),
    ...(expectedPartnerDeduplicate !== undefined
      ? { expectedPartnerDeduplicate }
      : {}),
    ...(signing !== undefined ? { signing } : {}),
    ...(retentionDisposition !== undefined ? { retentionDisposition } : {}),
    ...(includeOwnColumns !== undefined ? { includeOwnColumns } : {}),
    ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
  };
  const minted = mintExchangeSpec(fileInput);
  return authentication === undefined
    ? minted
    : ExchangeSpecSchema.parse({ ...minted, authentication });
}

/**
 * Compose the validated exchange spec an sftp job runs under, from a validated
 * sftp intent and the operator-authored server entry. Exported as the spec
 * rather than only the serialized document so the mount load can measure which
 * document fields this composition emits at all, instead of restating them
 * ({@link ./configLoad}).
 *
 * The connection's `server` block is exactly the authored entry: every
 * host, port, identity, and credential-reference field is server-side data
 * validated when authored; the intent contributes nothing to it. The
 * entry's `@path` credential strings land in the YAML verbatim -- references
 * the CLI child resolves at exchange time, so no secret byte transits this
 * process. The client's `linkageTerms`, `metadata`, `standardization`,
 * `expectedPartnerDeduplicate`, `signing`, `retention_disposition`,
 * `include_own_columns`, and `csv_delimiter` are composed as they are on the
 * filedrop path; `options` is the same
 * numeric/boolean/enum subset, plus the `connectionPerPoll` dialing mode
 * this channel alone admits.
 *
 * This path does not use `mintExchangeFile`: its {@link ExchangeFileInput}
 * typing makes credentials unrepresentable, an invariant shared with the
 * browser minting flow that must not admit the console's credential-reference
 * entries. Instead the exchange spec is assembled directly and validated
 * through core's {@link ExchangeSpecSchema}. The shared secret rides the key
 * file; the one `authentication` key composed is the intent's max-age policy
 * ({@link composedAuthentication}).
 */
export function composeSftpConfigSpec(
  intent: JobSftpExchangeIntent,
  serverEntry: JobSftpServerEntry,
  signingPaths?: JobSigningPaths,
): ExchangeSpec {
  const options = intentOptionsToFileSyncOptions(intent.options);
  return assembledConfigSpec(
    intent,
    {
      channel: "sftp",
      server: serverEntry,
      ...(options !== undefined ? { options } : {}),
    },
    signingPaths,
  );
}

/**
 * Compose the validated exchange spec a webrtc job runs under: the connection
 * dials the operator-authored coordination server with `role` set from the
 * intent's `side`, and states no STUN, TURN or relay setting, so the run takes
 * a direct connection or none. Every other block is composed as on the sftp
 * path.
 */
export function composeWebrtcConfigSpec(
  intent: JobWebrtcExchangeIntent,
  signalingServer: AuthoredSignalingServer,
  signingPaths?: JobSigningPaths,
): ExchangeSpec {
  const options = intentOptionsToFileSyncOptions(intent.options);
  const { host, port, path, secure } = signalingServer;
  return assembledConfigSpec(
    intent,
    {
      channel: "webrtc",
      server: {
        host,
        ...(port !== undefined ? { port } : {}),
        path,
        ...(secure ? {} : { secure: false }),
      },
      role: intent.side,
      ...(options !== undefined ? { options } : {}),
    },
    signingPaths,
  );
}

/** The webrtc config document: {@link composeWebrtcConfigSpec}'s spec,
 * written as {@link composeSftpConfigDocument} writes the sftp one. */
export function composeWebrtcConfigDocument(
  intent: JobWebrtcExchangeIntent,
  signalingServer: AuthoredSignalingServer,
  signingPaths?: JobSigningPaths,
): string {
  return stringifyYaml(
    snakeizeKeys(
      composeWebrtcConfigSpec(intent, signalingServer, signingPaths),
    ),
  );
}

/** The spec `connection` and the intent's own blocks compose, validated
 * through core's {@link ExchangeSpecSchema}. */
function assembledConfigSpec(
  intent: JobExchangeIntent,
  connection: ExchangeSpec["connection"],
  signingPaths: JobSigningPaths | undefined,
): ExchangeSpec {
  const {
    metadata,
    standardization,
    expectedPartnerDeduplicate,
    retentionDisposition,
    includeOwnColumns,
    csvDelimiter,
  } = intent;
  const signing = composedSigning(intent, signingPaths);
  const authentication = composedAuthentication(intent);
  const assembled: ExchangeSpec = {
    connection,
    linkageTerms: intent.linkageTerms,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(standardization !== undefined ? { standardization } : {}),
    ...(expectedPartnerDeduplicate !== undefined
      ? { expectedPartnerDeduplicate }
      : {}),
    ...(authentication !== undefined ? { authentication } : {}),
    ...(signing !== undefined ? { signing } : {}),
    ...(retentionDisposition !== undefined ? { retentionDisposition } : {}),
    ...(includeOwnColumns !== undefined ? { includeOwnColumns } : {}),
    ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
  };
  return ExchangeSpecSchema.parse(assembled);
}

/**
 * The sftp config document: {@link composeSftpConfigSpec}'s validated spec under
 * the same snakeize + yaml discipline `mintExchangeFile` uses.
 */
export function composeSftpConfigDocument(
  intent: JobSftpExchangeIntent,
  serverEntry: JobSftpServerEntry,
  signingPaths?: JobSigningPaths,
): string {
  return stringifyYaml(
    snakeizeKeys(composeSftpConfigSpec(intent, serverEntry, signingPaths)),
  );
}

/**
 * The `authentication` block a run's configuration states: the intent's
 * max-age policy alone, or no block at all. The shared secret and its
 * `expires` belong to the key file, so neither is representable here. The
 * run's CLI reads the policy as a command-line run does: it stamps the rotated
 * secret's `expires` from it, and a later run refuses that secret once the
 * instant has passed.
 */
function composedAuthentication(
  intent: JobExchangeIntent,
): ExchangeSpec["authentication"] {
  return intent.tokenMaxAgeDays === undefined
    ? undefined
    : { tokenMaxAgeDays: intent.tokenMaxAgeDays };
}

/**
 * Serialize the CLI key file body. Only the shared secret is written; no
 * `expires` is stamped, so a server-driven job holds no invitation-token
 * lifetime of its own.
 *
 * @throws {Error} for an intent stating no secret -- a run of the opened
 *   configuration, which uses the key file beside it and composes none.
 */
export function composeKeyFileDocument(intent: JobExchangeIntent): string {
  if (intent.sharedSecret === undefined)
    throw new Error("a key file was composed for an intent stating no secret");
  return JSON.stringify({ sharedSecret: intent.sharedSecret });
}

/**
 * Narrow the intent's tuning subset into a {@link FileSyncOptions}. Returns
 * undefined when no option was set, so the composed connection omits the
 * block entirely rather than holding an empty object.
 */
function intentOptionsToFileSyncOptions(
  options: JobExchangeOptions | undefined,
): FileSyncOptions | undefined {
  if (options === undefined) return undefined;
  const entries = Object.entries(options).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}
