/**
 * The SFTP connection as the job API states it: the authored server block, the
 * `PUT /api/jobs/sftp` body, and the `GET /api/jobs/sftp` projection.
 * Contract: docs/spec/SERVER_JOB_API.md, "The authored SFTP connection" and
 * "Authoring the SFTP connection".
 */

import type { ZeroSetupSftpRefusalReason } from "./jobCreateRefusal";

/**
 * The authored SFTP connection the server contributes to a composed sftp job
 * config. Credential fields contain only `@path` references, which the CLI
 * resolves; `hostKeyFingerprint` is required.
 */
export interface JobSftpServerEntry {
  host: string;
  port?: number;
  username?: string;
  path?: string;
  /** The peer-written directory of a split pair; set with
   * {@link outboundPath}, never with {@link path}. */
  inboundPath?: string;
  /** The self-written directory of a split pair. */
  outboundPath?: string;
  password?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
  keyboardInteractive?: boolean;
  hostKeyFingerprint: string | Array<string>;
}

/** Which SFTP primary auth method a credential feeds. */
export type SftpCredType = "password" | "private_key";

/** A credential given as a typed `@path`, for a file outside any listable mount. */
export interface AuthoredCredentialRef {
  kind: "ref";
  ref: string;
  credType: SftpCredType;
}

/**
 * A credential file picked in the credential browser: `secrets`
 * (`JOB_SECRETS_DIR`) or `folder` (`JOB_DATA_ROOT`) and the path under it. The
 * server resolves it to an `@path`, so no container path reaches the browser.
 */
export interface AuthoredMountRefCredential {
  kind: "mountRef";
  mount: "secrets" | "folder";
  subPath: Array<string>;
  credType: SftpCredType;
}

/**
 * A pasted credential value, for one that is not a file on the console. The
 * server writes it to a server-owned 0600 file and uses that `@path`
 * (docs/spec/SERVER_JOB_API.md, "Materializing a pasted credential").
 */
export interface AuthoredRawCredential {
  kind: "raw";
  value: string;
  credType: SftpCredType;
}

/** The credential in an authoring request; every form resolves to an `@path`. */
export type AuthoredCredential =
  AuthoredCredentialRef | AuthoredMountRefCredential | AuthoredRawCredential;

/**
 * The `PUT /api/jobs/sftp` authoring body. `privateKeyPassphrase` is always an
 * `@path`. The directory fields are optional siblings as in core's
 * `SFTPServer`, which owns the rules over them.
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
 * The credential-free projection `GET /api/jobs/sftp` serves. Built field by
 * field from the entry, never by spreading it, so no credential reference or
 * new field leaks into it.
 */
export interface SftpConnectionProjection {
  host: string;
  port?: number;
  path?: string;
  /** The peer-written directory of a split pair; present with
   * {@link outboundPath}, never with {@link path}. */
  inboundPath?: string;
  /** The self-written directory of a split pair. */
  outboundPath?: string;
  credentialWarnings?: Array<string>;
  /** Why job create would refuse a zero-setup run of this connection; absent
   * when it would run. */
  zeroSetupRefusal?: ZeroSetupSftpRefusalReason;
}
