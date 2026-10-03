import fs from "node:fs";
import path from "node:path";

import type { ExchangeSpec } from "@alcove/core";
import type { JobSftpServerEntry } from "./sftpServer";

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
  const addCredential = (value: string | undefined): void => {
    if (value?.startsWith("@") === true) references.push(value.slice(1));
  };
  if (authoredServer !== undefined) {
    addCredential(authoredServer.password);
    addCredential(authoredServer.privateKey);
    addCredential(authoredServer.privateKeyPassphrase);
  }
  if (openedDocument !== undefined) {
    const { connection, signing } = openedDocument;
    if (connection.channel === "sftp") {
      addCredential(connection.server.password);
      addCredential(connection.server.privateKey);
      addCredential(connection.server.privateKeyPassphrase);
    }
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
