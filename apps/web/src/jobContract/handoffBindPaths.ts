/**
 * The paths a scheduled container run of a configuration mounts at their own
 * path, and the log it appends to: shared by the console's recurring-run
 * hand-off and the managed exchange's command-line export, which the
 * browser composes, so this module imports nothing from Node.
 */

import type { ExchangeSpec } from "@alcove/core";

import type { JobSftpServerEntry } from "./sftpConnection";

/** A host path the scheduled container run mounts at the same path. */
export interface HandoffBindPath {
  path: string;
  /** Whether the run only reads it: a credential or signing identity file. */
  readOnly: boolean;
}

/** The log a scheduled run appends to in the folder it runs in, so an
 * unattended failure leaves its cause on disk. */
export const HANDOFF_LOG_FILE_NAME = "exchange.log";

/**
 * The placeholder the signing identity file is shown as in the exchange
 * config's `signing.identity_file`.
 *
 * The identity is a real file on the operator's host, but the console loads
 * it by the CONTAINER's path, which their host does not have -- whether that
 * is the mounted data root's default or the secrets-mount file the operator
 * chose, since the console resolves either to a container path. The template
 * names the file rather than the location, and the panel says which file to
 * point it at.
 */
export const HANDOFF_SIGNING_IDENTITY_PLACEHOLDER =
  "/path/to/your/signing-identity.json";

/** The placeholder a container-internal credential `@path` is shown as. The
 * operator replaces it with the path to their own credential file. */
export const HANDOFF_CREDENTIAL_PATH_PLACEHOLDER =
  "@/path/to/your/credential-file";

/** The placeholder a container-internal private-key passphrase `@path` is shown
 * as, kept distinct from the primary credential so the two files read clearly. */
export const HANDOFF_PASSPHRASE_PATH_PLACEHOLDER =
  "@/path/to/your/passphrase-file";

/** The placeholder the filedrop shared folder is shown as in the exchange
 * config's `connection.path`. */
export const HANDOFF_SHARED_DIRECTORY_PLACEHOLDER =
  "/path/to/your/shared-directory";

/** The placeholder a split console's INBOUND (peer-written) rendezvous mount is
 * shown as, in the exchange config's `connection.inbound_path`. Named for the
 * direction rather than "shared": the two folders are not one. */
export const HANDOFF_INBOUND_DIRECTORY_PLACEHOLDER =
  "/path/to/your/inbound-directory";

/** The placeholder a split console's OUTBOUND (self-written) rendezvous mount is
 * shown as, in `connection.outbound_path` and on `--outbound-path`. */
export const HANDOFF_OUTBOUND_DIRECTORY_PLACEHOLDER =
  "/path/to/your/outbound-directory";

/** The host paths a hand-off names as placeholders, which the operator
 * replaces with paths on the scheduling machine: each bind path the
 * composition writes in place of a path of its own. */
export const HANDOFF_PATH_PLACEHOLDERS: ReadonlyArray<string> = [
  HANDOFF_SIGNING_IDENTITY_PLACEHOLDER,
  HANDOFF_CREDENTIAL_PATH_PLACEHOLDER.slice(1),
  HANDOFF_PASSPHRASE_PATH_PLACEHOLDER.slice(1),
  HANDOFF_SHARED_DIRECTORY_PLACEHOLDER,
  HANDOFF_INBOUND_DIRECTORY_PLACEHOLDER,
  HANDOFF_OUTBOUND_DIRECTORY_PLACEHOLDER,
];

/**
 * The absolute paths `handoffSpec` names outside the folder the run starts in
 * (`JobHandoff.bindPaths` in `./jobHandoff`): each sftp credential `@path`, each
 * filedrop folder, and the signing identity.
 */
export function bindPathsIn(handoffSpec: ExchangeSpec): Array<HandoffBindPath> {
  const { connection, signing } = handoffSpec;
  const folders =
    connection.channel === "filedrop"
      ? [connection.path, connection.inboundPath, connection.outboundPath]
      : [];
  return uniqueAbsoluteBindPaths([
    ...(connection.channel === "sftp"
      ? credentialBindPaths(connection.server)
      : []),
    ...folders.map((path) => ({ path, readOnly: false })),
    { path: signing?.identityFile, readOnly: true },
  ]);
}

/** The files a server's credential `@path` references name, read-only. */
export function credentialBindPaths(
  server: Pick<
    JobSftpServerEntry,
    "password" | "privateKey" | "privateKeyPassphrase"
  >,
): Array<{ path: string; readOnly: boolean }> {
  return [
    server.password,
    server.privateKey,
    server.privateKeyPassphrase,
  ].flatMap((value) =>
    value?.startsWith("@") === true
      ? [{ path: value.slice(1), readOnly: true }]
      : [],
  );
}

/** The stated absolute paths, each once, read-write where any use writes it. */
export function uniqueAbsoluteBindPaths(
  candidates: ReadonlyArray<{ path: string | undefined; readOnly: boolean }>,
): Array<HandoffBindPath> {
  const byPath = new Map<string, boolean>();
  for (const { path, readOnly } of candidates) {
    if (path === undefined || !path.startsWith("/")) continue;
    byPath.set(path, (byPath.get(path) ?? true) && readOnly);
  }
  return [...byPath].map(([path, readOnly]) => ({ path, readOnly }));
}
