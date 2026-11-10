import { stringify as stringifyYaml } from "yaml";

import {
  ExchangeSpecSchema,
  atLowestExchangeFileVersion,
  mintExchangeSpec,
  serializeExchangeDocument,
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
  JobWebrtcExchangeIntent,
} from "@jobContract/intentSchemas";
import type { AuthoredSignalingServer } from "./signalingServer";

/**
 * Compose the CLI config document (snake_case YAML the CLI loads verbatim) from a
 * validated filedrop {@link JobExchangeIntent}. `rendezvousPath` is the
 * resolved rendezvous mount; with `outboundRendezvousPath` beside it, the two
 * are a split pair's inbound and outbound legs, composed as
 * `inbound_path`/`outbound_path` in place of `path`. Both are server-side
 * configuration, never a browser-sent string. `identityFile` is the
 * `signing.identity_file` the intent cannot hold, read only under
 * `certificate` mode, so a caller composing an unsigned exchange may omit it.
 * Contract: docs/spec/SERVER_JOB_API.md, "Composed CLI configuration".
 *
 * `include_own_columns` is forwarded verbatim: a local output-composition
 * setting the CLI reads when it writes this party's result file, adding nothing
 * to what the partner is sent. The schema refuses it beside a count-only
 * algorithm, so an intent pairing the two fails here rather than at the run.
 */
export function composeConfigDocument(
  intent: JobFiledropExchangeIntent,
  rendezvousPath: string,
  outboundRendezvousPath?: string,
  identityFile?: string,
): string {
  return stringifyYaml(
    snakeizeKeys(
      composeFiledropConfigSpec(
        intent,
        rendezvousPath,
        outboundRendezvousPath,
        identityFile,
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
  identityFile?: string,
): ExchangeSpec {
  const options = intentOptionsToFileSyncOptions(intent.options);
  const {
    metadata,
    standardization,
    expectedPartnerDeduplicate,
    retentionDisposition,
    includeOwnColumns,
    includeMatchingKey,
    csvDelimiter,
  } = intent;
  const signing = composedSigning(intent, identityFile);
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
    ...(includeMatchingKey !== undefined ? { includeMatchingKey } : {}),
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
 * The connection's `server` block is exactly the authored entry, its `@path`
 * credential references verbatim; the intent contributes nothing to it. The
 * spec is assembled directly rather than minted, stated at its lowest format
 * version as the minting path states it. `identityFile` is as in
 * {@link composeConfigDocument}. Contract: docs/spec/SERVER_JOB_API.md,
 * "Composed CLI configuration".
 */
export function composeSftpConfigSpec(
  intent: JobSftpExchangeIntent,
  serverEntry: JobSftpServerEntry,
  identityFile?: string,
): ExchangeSpec {
  const options = intentOptionsToFileSyncOptions(intent.options);
  return assembledConfigSpec(
    intent,
    {
      channel: "sftp",
      server: serverEntry,
      ...(options !== undefined ? { options } : {}),
    },
    identityFile,
  );
}

/**
 * Compose the validated exchange spec a webrtc job runs under: the connection
 * dials the operator-authored coordination server with `role` set from the
 * intent's `side`. An acceptor's run states the accepted invitation's relay
 * as `invitation_relay`, as `alcove accept` writes it, and no relay of its
 * own. An inviter's run states the console's own relay, where one is set, as
 * `turn` entries holding only a url, whose credential the run mints from the
 * shared secret, its WebSocket relay as `websocket_relay`, and its registrar
 * as `relay_registrar`; the invitation names those urls as `alcove invite`
 * names them. The intent's `allowedRelays` are stated as `allowed_relays`, so
 * a later run of the file in the working folder lists the same relays. Every
 * other block is composed as on the sftp path.
 */
function composeWebrtcConfigSpec(
  intent: JobWebrtcExchangeIntent,
  signalingServer: AuthoredSignalingServer,
  identityFile?: string,
): ExchangeSpec {
  const options = intentOptionsToFileSyncOptions(intent.options);
  const { host, port, path, secure, invitationRelay, ownRelay } =
    signalingServer;
  const inviterRelay = intent.side === "inviter" ? ownRelay : undefined;
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
      ...(intent.side === "acceptor" && invitationRelay !== undefined
        ? { invitationRelay }
        : {}),
      ...(inviterRelay?.turn !== undefined
        ? { turn: inviterRelay.turn.map((url) => ({ url })) }
        : {}),
      ...(inviterRelay?.relayRegistrar !== undefined
        ? { relayRegistrar: inviterRelay.relayRegistrar }
        : {}),
      ...(inviterRelay?.websocket !== undefined
        ? { websocketRelay: inviterRelay.websocket }
        : {}),
      ...(intent.allowedRelays !== undefined
        ? { allowedRelays: intent.allowedRelays }
        : {}),
      ...(options !== undefined ? { options } : {}),
    },
    identityFile,
  );
}

/** {@link composeWebrtcConfigSpec}'s spec as the document `alcove invite`
 * writes, guidance comments included, since it is written into the working
 * folder for the command line to run again. */
export function composeWebrtcConfigDocument(
  intent: JobWebrtcExchangeIntent,
  signalingServer: AuthoredSignalingServer,
  identityFile?: string,
): string {
  return serializeExchangeDocument(
    composeWebrtcConfigSpec(intent, signalingServer, identityFile),
  );
}

/** The spec `connection` and the intent's own blocks compose, validated
 * through core's {@link ExchangeSpecSchema}. */
function assembledConfigSpec(
  intent: JobExchangeIntent,
  connection: ExchangeSpec["connection"],
  identityFile: string | undefined,
): ExchangeSpec {
  const {
    metadata,
    standardization,
    expectedPartnerDeduplicate,
    retentionDisposition,
    includeOwnColumns,
    includeMatchingKey,
    csvDelimiter,
  } = intent;
  const signing = composedSigning(intent, identityFile);
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
    ...(includeMatchingKey !== undefined ? { includeMatchingKey } : {}),
    ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
  };
  return ExchangeSpecSchema.parse(atLowestExchangeFileVersion(assembled));
}

/**
 * The sftp config document: {@link composeSftpConfigSpec}'s validated spec under
 * the same snakeize + yaml discipline `mintExchangeFile` uses.
 */
export function composeSftpConfigDocument(
  intent: JobSftpExchangeIntent,
  serverEntry: JobSftpServerEntry,
  identityFile?: string,
): string {
  return stringifyYaml(
    snakeizeKeys(composeSftpConfigSpec(intent, serverEntry, identityFile)),
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
