import fs from "node:fs";
import path from "node:path";

import {
  CREDENTIAL_FILE_FIELDS,
  credentialFileReference,
} from "@jobContract/connectionPathFields";

import type { CredentialFileField } from "@jobContract/connectionPathFields";
import type { ExchangeSpec } from "@alcove/core";
import type { JobSftpServerEntry } from "@jobContract/sftpConnection";

/**
 * The files holding a secret that the console's current connection and opened
 * configuration point at, as realpaths: the SFTP password, private key and
 * passphrase files, and the configuration's signing identity file. The input
 * listing leaves these out, so a credential kept in the folder is never offered
 * as a file to profile.
 *
 * A credential `@path` that is relative is taken against `dataRoot`, the folder
 * the configuration sits in, which is where a command-line run of it starts. A
 * reference that names no file, or is an inline value rather than a path, adds
 * nothing.
 */
export function referencedCredentialPaths(
  dataRoot: string,
  authoredServer: JobSftpServerEntry | undefined,
  openedDocument: ExchangeSpec | undefined,
): Set<string> {
  const references: Array<string> = [];
  const addCredentials = (
    server: Pick<JobSftpServerEntry, CredentialFileField>,
  ): void => {
    for (const field of CREDENTIAL_FILE_FIELDS) {
      const reference = credentialFileReference(server[field]);
      if (reference !== undefined) references.push(reference);
    }
  };
  if (authoredServer !== undefined) addCredentials(authoredServer);
  if (openedDocument !== undefined) {
    const { connection, signing } = openedDocument;
    if (connection.channel === "sftp") addCredentials(connection.server);
    if (signing?.identityFile !== undefined)
      references.push(signing.identityFile);
  }
  const realpaths = new Set<string>();
  for (const reference of references) {
    if (reference === "") continue;
    try {
      realpaths.add(fs.realpathSync(path.resolve(dataRoot, reference)));
    } catch {
      continue;
    }
  }
  return realpaths;
}
