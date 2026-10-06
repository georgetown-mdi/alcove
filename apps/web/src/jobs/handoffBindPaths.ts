/**
 * The paths a scheduled container run of a configuration mounts at their own
 * path, and the log it appends to: shared by the console's recurring-run
 * hand-off and the managed exchange's command-line export, which the
 * browser composes, so this module imports nothing from Node.
 */

import type { ExchangeSpec } from "@alcove/core";

import type { JobSftpServerEntry } from "./sftpServer";

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
 * The absolute paths `handoffSpec` names outside the folder the run starts in
 * (`JobHandoff.bindPaths` in `./handoff`): each sftp credential `@path`, each
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
