import { stringify as stringifyYaml } from "yaml";

import { ExchangeSpecSchema } from "./exchangeSpec.js";
import type { ExchangeSpec } from "./exchangeSpec.js";
import type { ConnectionConfig, FileSyncOptions } from "./connection.js";
import type { LinkageTerms } from "./linkageTermsSchema.js";
import type { Metadata, OwnColumnSelection } from "./metadata.js";
import type { SigningConfig } from "./signing.js";
import type { Standardization } from "./standardizationSchema.js";
import { snakeizeKeys } from "../utils/camelizeKeys.js";
import { PLACEHOLDER_SSH_USERNAME } from "./endpointProducer.js";
import { WebRTCEndpointSchema } from "./invitation.js";
import type { WebRTCEndpoint } from "./invitation.js";

// --- Locator-only connection description -------------------------------------

/**
 * The SFTP locator of a web-composed exchange config: where the rendezvous
 * is, never how to authenticate to it. No credential field is representable
 * (docs/spec/EXCHANGE_FILE.md#mint-layer-guarantees).
 */
interface SftpExchangeLocator {
  channel: "sftp";
  host: string;
  /** The exchange-spec schema validates the range. */
  port?: number;
  /** Shared mode; mutually exclusive with the split pair. */
  path?: string;
  /** Peer-written directory; set together with {@link outboundPath}. */
  inboundPath?: string;
  /** Self-written directory; set together with {@link inboundPath}. */
  outboundPath?: string;
  options?: FileSyncOptions;
}

/**
 * The file-drop locator: the shared directory or the split pair. No host or
 * credential is representable.
 */
interface FiledropExchangeLocator {
  channel: "filedrop";
  /** Shared mode; mutually exclusive with the split pair. */
  path?: string;
  /** Peer-written directory; set together with {@link outboundPath}. */
  inboundPath?: string;
  /** Self-written directory; set together with {@link inboundPath}. */
  outboundPath?: string;
  options?: FileSyncOptions;
}

/**
 * The credential-free WebRTC locator: the invitation's {@link WebRTCEndpoint}.
 * The full webrtc connection block can include credentials, so the guarantee is
 * that {@link connectionFromLocator} expands only these fields and
 * {@link WebRTCEndpointSchema} rejects any other.
 */
export type WebRTCExchangeLocator = WebRTCEndpoint;

/**
 * The credential-free connection a downloadable exchange config is minted
 * from. File-sync channels only: a webrtc exchange is coordinated live.
 */
export type ExchangeFileConnection =
  SftpExchangeLocator | FiledropExchangeLocator;

/**
 * Every locator {@link connectionFromLocator} expands, webrtc included for the
 * managed-record composer.
 */
export type ExchangeLocator = ExchangeFileConnection | WebRTCExchangeLocator;

// --- Mint --------------------------------------------------------------------

/**
 * A web-composed exchange to mint as a CLI config. The secret is not
 * representable: it travels only in the invitation code.
 */
export interface ExchangeFileInput {
  connection: ExchangeFileConnection;
  linkageTerms: LinkageTerms;
  metadata?: Metadata;
  standardization?: Standardization;
  /**
   * The `deduplicate` an accepted invitation declared for the partner's side,
   * which a later `alcove exchange` checks the presented value against. Omit
   * where no invitation was accepted.
   */
  expectedPartnerDeduplicate?: boolean;
  /** See {@link ExchangeSpecAssembly.signing}. */
  signing?: SigningConfig;
  /** See {@link ExchangeSpecAssembly.retentionDisposition}. */
  retentionDisposition?: string;
  /** See {@link ExchangeSpecAssembly.includeOwnColumns}. */
  includeOwnColumns?: OwnColumnSelection;
  /** See {@link ExchangeSpecAssembly.csvDelimiter}. */
  csvDelimiter?: string;
}

/** {@link ExchangeFileInput} with the connection already expanded. */
interface ExchangeSpecAssembly {
  connection: ConnectionConfig;
  linkageTerms: LinkageTerms;
  metadata?: Metadata;
  standardization?: Standardization;
  /** See {@link ExchangeFileInput.expectedPartnerDeduplicate}. */
  expectedPartnerDeduplicate?: boolean;
  /**
   * This party's receipt-signing block. It names the identity file and contains
   * no secret (`config/signing.ts`). Its paths must exist on the machine that
   * runs the config.
   */
  signing?: SigningConfig;
  /**
   * This party's retention note, recorded verbatim in its own exchange record.
   * Local: never swapped, cross-validated, or hashed into the agreed terms.
   */
  retentionDisposition?: string;
  /**
   * Which of this party's own columns its result file includes
   * (`ownResultColumnNames`, `config/metadata.ts`). Local like
   * {@link retentionDisposition}. The schema refuses it beside `psi-c`.
   */
  includeOwnColumns?: OwnColumnSelection;
  /**
   * The delimiter this party reads its CSV and writes its result with, or
   * `detect`. Local; omitted means commas. Validated against `csvDelimiter.ts`.
   */
  csvDelimiter?: string;
}

/**
 * Assemble an exchange spec and return the {@link ExchangeSpecSchema} parse
 * result, never the raw input. An absent optional block is an omitted key. The
 * one assembly rule behind the downloadable mint and the web managed record
 * (docs/spec/EXCHANGE_FILE.md#the-artifact-is-the-cli-config-schema).
 *
 * @throws {ZodError} if the assembled spec fails validation.
 */
export function assembleExchangeSpec(
  input: ExchangeSpecAssembly,
): ExchangeSpec {
  const assembled: ExchangeSpec = {
    connection: input.connection,
    linkageTerms: input.linkageTerms,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.standardization !== undefined
      ? { standardization: input.standardization }
      : {}),
    ...(input.expectedPartnerDeduplicate !== undefined
      ? { expectedPartnerDeduplicate: input.expectedPartnerDeduplicate }
      : {}),
    ...(input.signing !== undefined ? { signing: input.signing } : {}),
    ...(input.retentionDisposition !== undefined
      ? { retentionDisposition: input.retentionDisposition }
      : {}),
    ...(input.includeOwnColumns !== undefined
      ? { includeOwnColumns: input.includeOwnColumns }
      : {}),
    ...(input.csvDelimiter !== undefined
      ? { csvDelimiter: input.csvDelimiter }
      : {}),
  };
  return ExchangeSpecSchema.parse(assembled);
}

/**
 * Mint a browser-composed exchange as the snake_case YAML the CLI loads
 * verbatim, with no `authentication` block and the SFTP username seeded with
 * {@link PLACEHOLDER_SSH_USERNAME}
 * (docs/spec/EXCHANGE_FILE.md#mint-layer-guarantees). No Node imports: the web
 * app consumes this module.
 *
 * @throws {ZodError} if the assembled spec fails validation.
 */
export function mintExchangeFile(input: ExchangeFileInput): string {
  return stringifyYaml(snakeizeKeys(mintExchangeSpec(input)));
}

/**
 * The validated spec {@link mintExchangeFile} serializes.
 *
 * @throws {ZodError} if the assembled spec fails validation.
 */
export function mintExchangeSpec(input: ExchangeFileInput): ExchangeSpec {
  return assembleExchangeSpec({
    ...input,
    connection: connectionFromLocator(input.connection),
  });
}

/**
 * Expand a credential-free {@link ExchangeLocator} into a
 * {@link ConnectionConfig}; the schema enforces the split-pair rules. A webrtc
 * locator is parsed through {@link WebRTCEndpointSchema} first, so an
 * unexpected key is rejected before only `host`/`port`/`path` and `relay` are
 * copied.
 */
export function connectionFromLocator(
  locator: ExchangeLocator,
): ConnectionConfig {
  if (locator.channel === "webrtc") {
    const endpoint = WebRTCEndpointSchema.parse(locator);
    return {
      channel: "webrtc",
      server: {
        host: endpoint.host,
        ...(endpoint.port !== undefined ? { port: endpoint.port } : {}),
        ...(endpoint.path !== undefined ? { path: endpoint.path } : {}),
      },
      ...(endpoint.relay !== undefined
        ? { invitationRelay: endpoint.relay }
        : {}),
    };
  }
  if (locator.channel === "sftp") {
    return {
      channel: "sftp",
      server: {
        host: locator.host,
        username: PLACEHOLDER_SSH_USERNAME,
        ...(locator.port !== undefined ? { port: locator.port } : {}),
        ...(locator.path !== undefined ? { path: locator.path } : {}),
        ...(locator.inboundPath !== undefined
          ? { inboundPath: locator.inboundPath }
          : {}),
        ...(locator.outboundPath !== undefined
          ? { outboundPath: locator.outboundPath }
          : {}),
      },
      ...(locator.options !== undefined ? { options: locator.options } : {}),
    };
  }
  return {
    channel: "filedrop",
    ...(locator.path !== undefined ? { path: locator.path } : {}),
    ...(locator.inboundPath !== undefined
      ? { inboundPath: locator.inboundPath }
      : {}),
    ...(locator.outboundPath !== undefined
      ? { outboundPath: locator.outboundPath }
      : {}),
    ...(locator.options !== undefined ? { options: locator.options } : {}),
  };
}
