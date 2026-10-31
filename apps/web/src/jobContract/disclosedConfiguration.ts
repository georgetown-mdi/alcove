/**
 * The mounted configuration as `GET /api/jobs/config` states it to the browser:
 * an explicitly mapped projection of the settings the authoring forms edit.
 */

import type { ExchangeSpec, SigningConfig } from "@alcove/core";

import type { JobSigningIdentityLocation } from "./intentSchemas";

/** A channel the console opens a configuration on. */
export type OpenedChannel = "sftp" | "filedrop" | "webrtc";

/**
 * The SFTP connection as the response states it: the fields the console's
 * connection form edits, and a `credentialMethod` naming WHICH credential the
 * file states rather than the credential itself. `username` and
 * `hostKeyFingerprint` are here because the form edits both; the credential,
 * its passphrase, and every `@path` among them are not, and no value of theirs
 * leaves the server.
 */
export interface DisclosedSftpServer {
  host: string;
  port?: number;
  path?: string;
  inboundPath?: string;
  outboundPath?: string;
  username?: string;
  hostKeyFingerprint?: string | Array<string>;
  keyboardInteractive?: boolean;
  credentialMethod?: "password" | "private_key";
}

/** The `signing` settings the receipts card edits. The identity file is a
 * path, so it is not in the document: the response names the setting where the
 * file states it (`signingPathSettings` in `@jobs/configLoad`), and states the
 * path only for a file run in place ({@link InPlaceSigningIdentity}). */
export interface DisclosedSigning {
  mode: SigningConfig["mode"];
  partnerFingerprint?: string;
}

/**
 * The `signing.identity_file` a webrtc configuration the console runs in place
 * names: `identityFile` as the file spells it, the path that run signs with,
 * and `consoleLocation` where that path is one of the console's own identity
 * locations -- `folder` for the default in the working folder, or a file in
 * the secrets mount -- so the browser can compare it with the location the
 * receipts card holds. Absent `consoleLocation` is a path the console never
 * signs with.
 */
export interface InPlaceSigningIdentity {
  identityFile: string;
  consoleLocation?: { mount: "folder" } | JobSigningIdentityLocation;
}

/**
 * The file-sync tuning fields the authoring forms edit, projected from core's
 * `FileSyncOptions` by name so a field a later schema version adds
 * reaches no browser until this states it.
 */
export interface DisclosedFileSyncOptions {
  peerTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  serverConnectTimeoutMs?: number;
  maxReconnectAttempts?: number;
  pollIntervalMs?: number;
  timestampInFilename?: boolean;
  locklessRendezvous?: boolean;
  peerId?: string;
  retainFiles?: boolean;
  unexpectedFiles?: "error" | "warn" | "ignore";
  connectionPerPoll?: boolean;
  writeWithoutRenaming?: boolean;
  unansweredHelloWindowMs?: number | "infinite";
}

/**
 * The document as the browser receives it: the authoring forms' own fields and
 * nothing else. Not an {@link ExchangeSpec} -- it is a projection, so a field
 * added to the shared schema reaches no browser until this states it.
 */
export interface DisclosedExchangeDocument {
  channel: OpenedChannel;
  server?: DisclosedSftpServer;
  /** A webrtc connection's coordination server as the `ws://` or `wss://`
   * address the run dials: its host, port, path and scheme, and not its key
   * or user name. */
  signalingServer?: string;
  /** The TURN urls a webrtc run of the file relays through, as the CLI
   * chooses them: an accepted invitation's relay, else the file's own
   * `turn` entries, each entry's url alone. Absent where it names none. */
  relayTurnUrls?: Array<string>;
  /** A webrtc file's `connection.allowed_relays`, each entry a relay host
   * with an optional port and no credential. Absent where the file states
   * none; empty where it lists none. */
  allowedRelays?: Array<string>;
  /** The run mints a credential for the file's own `turn` entries, which
   * state none, so the relay accepts the run only once it holds the exchange's
   * key. Absent otherwise. */
  relayCredentialMinted?: true;
  options?: DisclosedFileSyncOptions;
  linkageTerms: ExchangeSpec["linkageTerms"];
  metadata?: ExchangeSpec["metadata"];
  standardization?: ExchangeSpec["standardization"];
  expectedPartnerDeduplicate?: boolean;
  includeOwnColumns?: ExchangeSpec["includeOwnColumns"];
  includeMatchingKey?: boolean;
  csvDelimiter?: string;
  retentionDisposition?: string;
  signing?: DisclosedSigning;
  /** The file's `authentication.token_max_age_days`, the one setting of that
   * block a configuration states; the shared secret and its expiry are refused
   * at the load (`assertNoStatedSecret` in `@jobs/configLoad`). */
  tokenMaxAgeDays?: number;
}
