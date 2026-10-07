import type { ConnectionConfig, ServerProvision } from "@alcove/core";
import {
  safeParseConnectionConfig,
  safeParseFileSyncOptions,
  UsageError,
  withRetainModeImplications,
} from "@alcove/core";

/**
 * The server/credential overrides {@link applyConnectionOverrides} writes into a
 * connection's `connection.server` block (host/port/credentials) and its
 * channel directory paths. Paired with the tuning/toggle
 * {@link ConnectionOptionsOverrides}, which lands in `connection.options`,
 * inside {@link ConnectionOverrides}.
 */
export interface ConnectionServerOverrides {
  username?: string;
  password?: string;
  privateKey?: string;
  /**
   * Passphrase for an encrypted `privateKey`; a companion credential, invalid
   * without a private key (from this override or the base config). See
   * {@link applyConnectionOverrides}, which rejects it standalone.
   */
  privateKeyPassphrase?: string;
  /**
   * Answer the server's keyboard-interactive prompts with the password. Requires
   * a password (from this override or the base config); see
   * {@link applyConnectionOverrides}, which rejects it without one. sftp-only.
   */
  keyboardInteractive?: boolean;
  /**
   * Pre-pinned SSH host-key fingerprint (OpenSSH SHA256 format), from
   * `--server-host-key-fingerprint`; already `@file`-resolved and
   * format-validated by {@link hostKeyFingerprintFlag}. Overwrites any
   * fingerprint already on the base config. A wrong value still fails closed
   * at the real connect. sftp-only.
   */
  hostKeyFingerprint?: string;
  /**
   * The start-mode `server.provision` block from `--server-provision`, its auth
   * `@path` references unread. Replaces any block on the base config. Applies
   * on `sftp` and `webrtc`; a `filedrop` connection has no server to start, so
   * {@link applyConnectionOverrides} refuses it there.
   */
  provision?: ServerProvision;
  port?: number;
  /**
   * Outbound (self-written) directory for a split-directory exchange. When set,
   * the connection's single shared directory (the server URL/positional path, or
   * the loaded config's `path`/`server.path`) becomes the inbound (peer-written)
   * directory and this value becomes the outbound; see
   * {@link applyConnectionOverrides}. Requires retain mode and only applies to
   * the file-sync channels (`sftp`, `filedrop`).
   */
  outboundPath?: string;
}

/**
 * The tuning/toggle overrides {@link applyConnectionOverrides} writes into a
 * connection's `connection.options` block: SharedOptions timeouts/reconnect
 * bounds on every channel, and FileSyncOptions poll interval/toggles gated to
 * `sftp`/`filedrop`. `connectionTimeout`/`peerTimeout` are in seconds here and
 * scaled to the schema's milliseconds; `pollIntervalMs` is already in
 * milliseconds and applied verbatim. Paired with
 * {@link ConnectionServerOverrides} inside {@link ConnectionOverrides}.
 */
export interface ConnectionOptionsOverrides {
  connectionTimeout?: number;
  peerTimeout?: number;
  /**
   * The `--polling-frequency` override, already in milliseconds, feeding the
   * connection's `pollIntervalMs`. A FileSyncOptions field, so it is applied only
   * on the file-sync channels (see {@link applyConnectionOverrides}).
   */
  pollIntervalMs?: number;
  maxReconnectAttempts?: number;
  locklessRendezvous?: boolean;
  peerId?: string;
  retainFiles?: boolean;
  timestampInFilename?: boolean;
  /**
   * The `--connection-per-poll` override, feeding the connection's
   * `connectionPerPoll`. SFTP-only (the ephemeral-session mode dials a real SFTP
   * socket), so {@link applyConnectionOverrides} applies it only on `sftp` and
   * drops it on `filedrop`, where the CLI reports it ignored.
   */
  connectionPerPoll?: boolean;
}

/**
 * CLI overrides applied to a base connection by {@link applyConnectionOverrides}:
 * the server/credential set (plus directory paths) that lands in
 * `connection.server` ({@link ConnectionServerOverrides}), and the tuning/toggle
 * set that lands in `connection.options` ({@link ConnectionOptionsOverrides}).
 * Each sub-group is optional and itself sparse; an absent group or field applies
 * no override.
 */
export interface ConnectionOverrides {
  server?: ConnectionServerOverrides;
  options?: ConnectionOptionsOverrides;
}

export function applyConnectionOverrides(
  connection: ConnectionConfig,
  overrides: ConnectionOverrides,
): ConnectionConfig {
  const result = structuredClone(connection);
  // Default each sub-group to empty so an absent group applies no override.
  const { server: serverOverrides = {}, options: optionsOverrides = {} } =
    overrides;

  // Tracks whether any override merged into result.server (or a directory split
  // ran below), so the single connection-wide re-validation near the end runs
  // exactly when an override could have introduced an invalid value -- e.g. an
  // out-of-range --server-port, or a --server-password paired with a privateKey
  // already in the base config -- not on an untouched, already-validated config.
  let serverModified = false;

  if (result.channel === "sftp") {
    const { server } = result;
    if (serverOverrides.username !== undefined)
      server.username = serverOverrides.username;
    if (serverOverrides.password !== undefined) {
      server.password = serverOverrides.password;
      serverModified = true;
    }
    if (serverOverrides.privateKey !== undefined) {
      server.privateKey = serverOverrides.privateKey;
      serverModified = true;
    }
    if (serverOverrides.privateKeyPassphrase !== undefined)
      server.privateKeyPassphrase = serverOverrides.privateKeyPassphrase;
    if (serverOverrides.keyboardInteractive !== undefined)
      server.keyboardInteractive = serverOverrides.keyboardInteractive;
    if (serverOverrides.hostKeyFingerprint !== undefined) {
      // Already @file-resolved and format-validated at the CLI parse boundary
      // (hostKeyFingerprintFlag), so it can be assigned as-is; the
      // re-validation below re-checks it as part of the whole connection.
      server.hostKeyFingerprint = serverOverrides.hostKeyFingerprint;
      serverModified = true;
    }
    if (serverOverrides.port !== undefined) {
      server.port = serverOverrides.port;
      serverModified = true;
    }

    // A passphrase decrypts an encrypted private key and is meaningless
    // without one; reject it up front with a flag-named message rather than
    // the core schema's generic one. The key may come from
    // --server-private-key or the loaded config.
    if (
      server.privateKeyPassphrase !== undefined &&
      server.privateKey === undefined
    )
      throw new UsageError(
        "--server-private-key-passphrase requires --server-private-key (or a " +
          "private_key in the configuration): a passphrase decrypts an " +
          "encrypted private key and has no effect without one.",
      );

    // keyboard-interactive answers the server's prompts with the password, so
    // it is meaningless without one; reject it up front with a flag-named
    // message, since the override is applied after the config was parsed and
    // would otherwise go unchecked. The password may come from
    // --server-password or the loaded config.
    if (server.keyboardInteractive === true && server.password === undefined)
      throw new UsageError(
        "--server-keyboard-interactive requires --server-password (or a " +
          "password in the configuration): it answers the server's " +
          "keyboard-interactive prompts with that password and has no effect " +
          "without one.",
      );
  }

  if (serverOverrides.provision !== undefined) {
    if (result.channel === "filedrop")
      throw new UsageError(
        "--server-provision is only supported on the sftp and webrtc " +
          "channels; a shared folder has no server to start.",
      );
    result.server.provision = structuredClone(serverOverrides.provision);
    serverModified = true;
  }

  // Tracks whether any override merged into result.options, so the single
  // re-validation below runs exactly when an override could have introduced an
  // invalid value -- not on an untouched, already-validated config.
  let optionsModified = false;

  if (
    optionsOverrides.peerTimeout !== undefined ||
    optionsOverrides.connectionTimeout !== undefined ||
    optionsOverrides.maxReconnectAttempts !== undefined
  ) {
    result.options = {
      ...result.options,
      ...(optionsOverrides.peerTimeout !== undefined && {
        peerTimeoutMs: optionsOverrides.peerTimeout * 1000,
      }),
      ...(optionsOverrides.connectionTimeout !== undefined && {
        serverConnectTimeoutMs: optionsOverrides.connectionTimeout * 1000,
      }),
      ...(optionsOverrides.maxReconnectAttempts !== undefined && {
        maxReconnectAttempts: optionsOverrides.maxReconnectAttempts,
      }),
    };
    optionsModified = true;
  }

  // These are FileSyncOptions fields, applied only on channels that use
  // FileSyncConnection; the overrides above are SharedOptions, applying to
  // every channel including webrtc. pollIntervalMs is applied verbatim -- it
  // is already in milliseconds, unlike the seconds-scaled timeout fields.
  if (
    (result.channel === "sftp" || result.channel === "filedrop") &&
    (optionsOverrides.pollIntervalMs !== undefined ||
      optionsOverrides.locklessRendezvous !== undefined ||
      optionsOverrides.peerId !== undefined ||
      optionsOverrides.retainFiles !== undefined ||
      optionsOverrides.timestampInFilename !== undefined)
  ) {
    result.options = withRetainModeImplications({
      ...result.options,
      ...(optionsOverrides.pollIntervalMs !== undefined && {
        pollIntervalMs: optionsOverrides.pollIntervalMs,
      }),
      ...(optionsOverrides.locklessRendezvous !== undefined && {
        locklessRendezvous: optionsOverrides.locklessRendezvous,
      }),
      ...(optionsOverrides.peerId !== undefined && {
        peerId: optionsOverrides.peerId,
      }),
      ...(optionsOverrides.retainFiles !== undefined && {
        retainFiles: optionsOverrides.retainFiles,
      }),
      ...(optionsOverrides.timestampInFilename !== undefined && {
        timestampInFilename: optionsOverrides.timestampInFilename,
      }),
    });

    optionsModified = true;
  }

  // connectionPerPoll is SFTP-only: the ephemeral-session mode dials a real SFTP
  // socket, which filedrop's connectionless client lacks. Apply it only on sftp,
  // so a filedrop config never holds an inert setting; on filedrop it is dropped
  // and warnUnsupportedFileSyncFlags reports it ignored. Unlike the file-sync
  // block above (which spans sftp and filedrop), this is gated to sftp alone.
  if (
    result.channel === "sftp" &&
    optionsOverrides.connectionPerPoll !== undefined
  ) {
    result.options = {
      ...result.options,
      connectionPerPoll: optionsOverrides.connectionPerPoll,
    };
    optionsModified = true;
  }

  // Re-validate the merged options through FileSyncOptionsSchema once, whenever
  // any override touched them, so no override path can bypass a floor the
  // schema enforces (timeout positivity, peer_id constraints, retain_files
  // implications). FileSyncOptionsSchema also safely validates a webrtc
  // SharedOptions object: each FileSyncOptions-only refine is guarded by that
  // field's own presence.
  if (optionsModified) {
    const validation = safeParseFileSyncOptions(result.options);
    if (!validation.success) {
      const message = validation.error.issues
        .map((i: { message: string }) => i.message)
        .join("; ");
      // An invalid option combination (from alcove.yaml or a CLI override) is
      // invalid caller configuration: a UsageError so the CLI exits 64, not 69.
      throw new UsageError(message);
    }
  }

  // --outbound-path splits the single shared directory into separate inbound
  // (peer-written) and outbound (self-written) directories. Applied here, the
  // one chokepoint every bootstrap command routes its connection through.
  // Only the file-sync channels have a directory.
  if (serverOverrides.outboundPath !== undefined) {
    if (result.channel === "sftp") {
      const { server } = result;
      // An already-split config (inbound set) keeps its inbound; a shared config
      // contributes its `path`. The single `path` cannot coexist with the pair.
      server.inboundPath = server.inboundPath ?? server.path;
      server.outboundPath = serverOverrides.outboundPath;
      delete server.path;
      serverModified = true;
    } else if (result.channel === "filedrop") {
      result.inboundPath = result.inboundPath ?? result.path;
      result.outboundPath = serverOverrides.outboundPath;
      delete result.path;
      serverModified = true;
    } else {
      // webrtc has no directory, so the flag is meaningless there: refuse it
      // with a cause naming the channels that do have one, rather than
      // silently dropping it the way the channel-gated overrides above are.
      throw new UsageError(
        "--outbound-path is only supported on the sftp and filedrop channels",
      );
    }

    // Retain mode is a hard precondition for a split directory; fail fast with
    // a flag-named message rather than the core schema's generic one. The
    // else branch above threw for webrtc, so result is a file-sync channel
    // here; the channel test re-narrows for the options read.
    if (
      (result.channel === "sftp" || result.channel === "filedrop") &&
      result.options?.retainFiles !== true
    )
      throw new UsageError(
        "--outbound-path configures a separate outbound directory, which " +
          "requires retain mode; pass --retain-files (or set retain_files: " +
          "true in the configuration).",
      );
  }

  // Re-validate the merged connection through the core schema once, whenever
  // an override touched result.server or its directory paths, so every path
  // that can introduce an invalid value is caught here. The
  // outbound-path-specific rejections come from the same call with the same
  // messages the live connection enforces. A literal `@path` credential ref
  // validates cleanly as a string (resolved later, at live use).
  if (serverModified) {
    const connValidation = safeParseConnectionConfig(result);
    if (!connValidation.success)
      throw new UsageError(
        connValidation.error.issues.map((i) => i.message).join("; "),
      );
  }

  return result;
}
