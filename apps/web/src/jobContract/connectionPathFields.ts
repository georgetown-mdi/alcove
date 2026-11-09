/**
 * The connection fields whose values name a file or folder on the host the
 * exchange runs on: the SFTP credential `@path` references and the filedrop
 * folders. Imports nothing from Node: the browser's command-line export reads
 * it too.
 */

import type { ExchangeSpec } from "@alcove/core";

import type { JobSftpServerEntry } from "./sftpConnection";

/** The SFTP connection fields whose values are `@path` credential file
 * references. */
export const CREDENTIAL_FILE_FIELDS = [
  "password",
  "privateKey",
  "privateKeyPassphrase",
] as const satisfies ReadonlyArray<keyof JobSftpServerEntry>;

/** One of {@link CREDENTIAL_FILE_FIELDS}. */
export type CredentialFileField = (typeof CREDENTIAL_FILE_FIELDS)[number];

/** The path a credential field's `@path` reference names, or undefined when the
 * value is absent or an inline value rather than a reference. */
export function credentialFileReference(
  value: string | undefined,
): string | undefined {
  return value?.startsWith("@") === true ? value.slice(1) : undefined;
}

/** The placeholder a container-internal credential `@path` is shown as. The
 * operator replaces it with the path to their own credential file. */
export const HANDOFF_CREDENTIAL_PATH_PLACEHOLDER =
  "@/path/to/your/credential-file";

/** The placeholder a container-internal private-key passphrase `@path` is shown
 * as, kept distinct from the primary credential so the two files read clearly. */
export const HANDOFF_PASSPHRASE_PATH_PLACEHOLDER =
  "@/path/to/your/passphrase-file";

/** How a credential field is spelled where the console writes it out. */
export interface CredentialFileFieldSpelling {
  /** The zero-setup command's flag, given as `<flag>=<@path>`. */
  flag: string;
  /** The field's path in `alcove.yaml`. */
  yamlPath: string;
  /** The `@path` a hand-off template states in place of the console's own. */
  placeholder: string;
}

/** Each credential field's spellings. */
export const CREDENTIAL_FILE_FIELD_SPELLINGS: Readonly<
  Record<CredentialFileField, CredentialFileFieldSpelling>
> = {
  password: {
    flag: "--server-password",
    yamlPath: "connection.server.password",
    placeholder: HANDOFF_CREDENTIAL_PATH_PLACEHOLDER,
  },
  privateKey: {
    flag: "--server-private-key",
    yamlPath: "connection.server.private_key",
    placeholder: HANDOFF_CREDENTIAL_PATH_PLACEHOLDER,
  },
  privateKeyPassphrase: {
    flag: "--server-private-key-passphrase",
    yamlPath: "connection.server.private_key_passphrase",
    placeholder: HANDOFF_PASSPHRASE_PATH_PLACEHOLDER,
  },
};

/**
 * The credential fields a composition of `server` states, with their values,
 * in order: the primary credential, `password` where the entry has one and
 * `privateKey` otherwise, at most one as core's server schema admits, then the
 * passphrase.
 */
export function composedCredentialFields(
  server: Pick<JobSftpServerEntry, CredentialFileField>,
): Array<{ field: CredentialFileField; value: string }> {
  const { password, privateKey, privateKeyPassphrase } = server;
  return [
    ...(password !== undefined
      ? [{ field: "password" as const, value: password }]
      : privateKey !== undefined
        ? [{ field: "privateKey" as const, value: privateKey }]
        : []),
    ...(privateKeyPassphrase !== undefined
      ? [
          {
            field: "privateKeyPassphrase" as const,
            value: privateKeyPassphrase,
          },
        ]
      : []),
  ];
}

/** A filedrop connection, as core's spec types it. */
export type FiledropConnection = Extract<
  ExchangeSpec["connection"],
  { channel: "filedrop" }
>;

/** The filedrop connection fields that name a shared folder: the single
 * `path` or the split inbound/outbound pair. */
export const FILEDROP_FOLDER_FIELDS = [
  "path",
  "inboundPath",
  "outboundPath",
] as const satisfies ReadonlyArray<keyof FiledropConnection>;

/** One of {@link FILEDROP_FOLDER_FIELDS}. */
export type FiledropFolderField = (typeof FILEDROP_FOLDER_FIELDS)[number];
