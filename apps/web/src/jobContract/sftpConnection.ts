/**
 * The SFTP connection as the job API states it: the operator-authored server
 * block, the `PUT /api/jobs/sftp` authoring body, and the credential-free
 * projection `GET /api/jobs/sftp` answers with.
 */

import type { ZeroSetupSftpRefusalReason } from "./jobCreateRefusal";

/**
 * The operator-authored SFTP connection: the connection block the server -- never
 * the client -- contributes to a composed sftp job config. Credential fields
 * (`password`, `privateKey`, `privateKeyPassphrase`) hold only `@path` file
 * references; validation rejects inline values, so no secret byte ever lives in
 * server memory -- the reference is resolved by the CLI child at exchange time.
 * `hostKeyFingerprint` is mandatory: a console-driven SFTP connection always
 * pins the server host key.
 */
export interface JobSftpServerEntry {
  host: string;
  port?: number;
  username?: string;
  path?: string;
  /** The inbound (peer-written) remote directory of a split-directory
   * connection; set together with {@link outboundPath} and never alongside
   * {@link path}. */
  inboundPath?: string;
  /** The outbound (self-written) remote directory of a split-directory
   * connection; the companion to {@link inboundPath}. */
  outboundPath?: string;
  password?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
  keyboardInteractive?: boolean;
  hostKeyFingerprint: string | Array<string>;
}

/** Which SFTP primary auth method a credential feeds. */
export type SftpCredType = "password" | "private_key";

/**
 * A file-reference credential given as a typed `@path` (never an inline value):
 * the documented exception for a credential that lives outside any listable
 * mount. Tagged with which primary auth method it feeds.
 */
export interface AuthoredCredentialRef {
  kind: "ref";
  ref: string;
  credType: SftpCredType;
}

/**
 * A file-reference credential given as a locator the operator picked in the
 * credential browser: the mount id and the path segments under it. `secrets` is
 * the separate secrets directory (`JOB_SECRETS_DIR`); `folder` is the working
 * folder (`JOB_DATA_ROOT`), browsed when no secrets directory is mounted. The
 * server -- not the browser -- resolves it to an absolute `@path`, so no
 * container-absolute path ever transits the browser. Tagged with which primary
 * auth method it feeds.
 */
export interface AuthoredMountRefCredential {
  kind: "mountRef";
  mount: "secrets" | "folder";
  subPath: Array<string>;
  credType: SftpCredType;
}

/**
 * A pasted credential value: the de-emphasized fallback for a credential that
 * exists nowhere on the console as a file. Under the single-party-console
 * trust model (a loopback-only browser on the operator's own machine) the value
 * crossing loopback is on-host, so this is acceptable -- but the server never
 * composes it as a value: it materializes it ONCE to a server-owned 0600 file at
 * the container-internal scratch path, rewrites it to an `@path`, and runs the
 * SAME containment chain the file-reference forms do. Tagged with which primary
 * auth method it feeds.
 */
export interface AuthoredRawCredential {
  kind: "raw";
  value: string;
  credType: SftpCredType;
}

/**
 * The credential an authoring request holds: a typed `@path` reference, a
 * secrets-mount locator, or a pasted value. All resolve to an `@path` reference
 * (the pasted value only after materialization to a server-owned file) validated
 * by the authoring containment chain; no inline value ever reaches a composed
 * job file.
 */
export type AuthoredCredential =
  AuthoredCredentialRef | AuthoredMountRefCredential | AuthoredRawCredential;

/**
 * The `PUT /api/jobs/sftp` authoring body. The credential arrives tagged -- a
 * typed `@path`, a secrets-mount locator, or a pasted value the server
 * materializes to a file -- rather than as a bare field, and the fingerprint is
 * mandatory and literal. `private_key_passphrase` is always an `@path`
 * reference, never a pasted value.
 *
 * The remote directory arrives in one of the two forms core's connection config
 * holds: the single shared `path`, or the split `inboundPath`/`outboundPath`
 * pair for a server with distinct drop and pickup folders. The three are
 * modelled as optional siblings, exactly as core's `SFTPServer` models them, so
 * the body stays a strict allowlist and the coherence rules over them stay
 * core's single statement rather than a second one here.
 */
export interface AuthoredSftpServerRequest {
  host: string;
  port?: number;
  username?: string;
  path?: string;
  inboundPath?: string;
  outboundPath?: string;
  hostKeyFingerprint: string | Array<string>;
  credential: AuthoredCredential;
  privateKeyPassphrase?: string;
  keyboardInteractive?: boolean;
}

/**
 * The public, credential-free projection of the authored SFTP connection
 * served by `GET /api/jobs/sftp`: the locator fields plus any non-blocking
 * credential warnings (each naming a field and a directory only, never a
 * secret), and the refusal a direct run would raise over it. Constructed
 * field-by-field from the entry -- never by spreading it -- so no credential
 * reference, fingerprint, or future field can ride along.
 */
export interface SftpConnectionProjection {
  host: string;
  port?: number;
  path?: string;
  /** The inbound (peer-written) remote directory of a split-directory
   * connection; present only as a pair with {@link outboundPath}, and never
   * alongside {@link path}. */
  inboundPath?: string;
  /** The outbound (self-written) remote directory of a split-directory
   * connection. */
  outboundPath?: string;
  credentialWarnings?: Array<string>;
  /** The token job create refuses a direct (zero-setup) run of this connection
   * with, absent when it would run. An exchange-mode run is not refused over
   * it. */
  zeroSetupRefusal?: ZeroSetupSftpRefusalReason;
}
