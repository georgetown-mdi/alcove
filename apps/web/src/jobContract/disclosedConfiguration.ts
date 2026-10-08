/**
 * The mounted configuration as `GET /api/jobs/config` states it to the browser:
 * an explicitly mapped projection of the settings the authoring forms edit.
 */

import type { ExchangeSpec, SigningConfig } from "@alcove/core";

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
 * path, so it is not disclosed: the response names it where the file states it
 * (`signingPathSettings` in `@jobs/configLoad`). */
export interface DisclosedSigning {
  mode: SigningConfig["mode"];
  partnerFingerprint?: string;
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
}

/**
 * The document as the browser receives it: the authoring forms' own fields and
 * nothing else. Not an {@link ExchangeSpec} -- it is a projection, so a field
 * added to the shared schema reaches no browser until this states it.
 */
export interface DisclosedExchangeDocument {
  channel: OpenedChannel;
  server?: DisclosedSftpServer;
  options?: DisclosedFileSyncOptions;
  linkageTerms: ExchangeSpec["linkageTerms"];
  metadata?: ExchangeSpec["metadata"];
  standardization?: ExchangeSpec["standardization"];
  expectedPartnerDeduplicate?: boolean;
  includeOwnColumns?: ExchangeSpec["includeOwnColumns"];
  csvDelimiter?: string;
  retentionDisposition?: string;
  signing?: DisclosedSigning;
  /** The file's `authentication.token_max_age_days`, the one setting of that
   * block a configuration states; the shared secret and its expiry are refused
   * at the load (`assertNoStatedSecret` in `@jobs/configLoad`). */
  tokenMaxAgeDays?: number;
}
