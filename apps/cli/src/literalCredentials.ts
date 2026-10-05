import type { HttpAuth } from "@alcove/core";
import {
  getLogger,
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
} from "@alcove/core";

import { decodeUrlComponent } from "./util/connectionUrl";

/**
 * The credential fields a connection's `server` block and the matching
 * command-line flags share. Any one may hold an `@path` reference instead of
 * the secret itself.
 */
export interface CredentialFields {
  password?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
  provision?: { auth?: HttpAuth };
}

/** One credential field holding a secret as typed rather than an `@path`. */
export interface LiteralCredential {
  /** The field's path in the configuration file, snake_case. */
  configField: string;
  /** The `@path` form of the field, as a configuration line. */
  configExample: string;
  /** The flag that sets the same field from the command line. */
  flag: string;
  /** The `@path` form of the flag. */
  flagExample: string;
}

const CREDENTIAL_FIELDS: ReadonlyArray<
  LiteralCredential & { read: (fields: CredentialFields) => unknown }
> = [
  {
    read: (fields) => fields.password,
    configField: "connection.server.password",
    configExample: 'password: "@./sftp-password.txt"',
    flag: "--server-password",
    flagExample: "--server-password @./sftp-password.txt",
  },
  {
    read: (fields) => fields.privateKey,
    configField: "connection.server.private_key",
    configExample: 'private_key: "@~/.ssh/id_alcove"',
    flag: "--server-private-key",
    flagExample: "--server-private-key @~/.ssh/id_alcove",
  },
  {
    read: (fields) => fields.privateKeyPassphrase,
    configField: "connection.server.private_key_passphrase",
    configExample: 'private_key_passphrase: "@./sftp-key-passphrase.txt"',
    flag: "--server-private-key-passphrase",
    flagExample: "--server-private-key-passphrase @./sftp-key-passphrase.txt",
  },
  {
    read: (fields) => fields.provision?.auth?.bearer,
    configField: "connection.server.provision.auth.bearer",
    configExample: 'bearer: "@./provision-token.txt"',
    flag: "--server-provision-bearer",
    flagExample: "--server-provision-bearer @./provision-token.txt",
  },
  {
    read: (fields) => fields.provision?.auth?.password,
    configField: "connection.server.provision.auth.password",
    configExample: 'password: "@./provision-password.txt"',
    flag: "--server-provision-password",
    flagExample: "--server-provision-password @./provision-password.txt",
  },
];

/**
 * The credential fields of `fields` that hold a secret as typed: a string
 * value not beginning with `@`, the prefix that makes a value a reference to
 * the file holding it.
 */
export function literalCredentials(
  fields: CredentialFields | undefined,
): LiteralCredential[] {
  if (fields === undefined) return [];
  return CREDENTIAL_FIELDS.filter((field) => {
    const value = field.read(fields);
    return typeof value === "string" && !value.startsWith("@");
  }).map(({ configField, configExample, flag, flagExample }) => ({
    configField,
    configExample,
    flag,
    flagExample,
  }));
}

/**
 * A connection block as far as the credential check reads it: the `server`
 * block, on the channels that have one.
 */
export interface ConnectionCredentialFields {
  channel: string;
  server?: CredentialFields;
}

/**
 * The warning a configuration written with a credential as typed gets, or
 * undefined when it holds none.
 */
export function savedLiteralCredentialWarning(
  configPath: string,
  connection: ConnectionCredentialFields | undefined,
): string | undefined {
  const found = literalCredentials(connection?.server);
  if (found.length === 0) return undefined;
  const fields = found.map((field) => field.configField);
  const shownPath = redactAndRenderOperatorSuppliedText(
    operatorSuppliedText(configPath),
  );
  const which =
    fields.length === 1
      ? `a credential as typed in ${fields[0]}`
      : `credentials as typed in ${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}`;
  return (
    `the configuration saved to ${shownPath} holds ${which}, and anyone ` +
    "with a copy of the file can use it. Before you commit or share the " +
    "file, put the value in a file of its own and write its path with a " +
    `leading @ in its place, e.g. ${found[0].configExample}.`
  );
}

/**
 * Warn when the configuration just written to `configPath` holds a
 * credential as typed. Every writer of a new configuration calls it once the
 * file is in place.
 */
export function warnIfSavedConfigHoldsLiteralCredential(
  configPath: string,
  connection: ConnectionCredentialFields | undefined,
  log: { warn: (message: string) => void } = getLogger("config"),
): void {
  const warning = savedLiteralCredentialWarning(configPath, connection);
  if (warning !== undefined) log.warn(warning);
}

/** The single-value string a credential flag was given, if any. */
function flagValue(
  argv: Readonly<Record<string, unknown>>,
  flag: string,
): string | undefined {
  const value = argv[flag];
  return typeof value === "string" ? value : undefined;
}

/**
 * The notice a run gets when its command line holds a credential as typed --
 * in a credential flag or in the password of `url` -- or undefined when it
 * holds none.
 */
export function commandLineLiteralCredentialNotice(
  argv: Readonly<Record<string, unknown>>,
  url: URL | undefined,
): string | undefined {
  const bearer = flagValue(argv, "server-provision-bearer");
  const provisionPassword = flagValue(argv, "server-provision-password");
  const fromFlags = literalCredentials({
    password: flagValue(argv, "server-password"),
    privateKey: flagValue(argv, "server-private-key"),
    privateKeyPassphrase: flagValue(argv, "server-private-key-passphrase"),
    provision: {
      auth: {
        ...(bearer !== undefined ? { bearer } : {}),
        ...(provisionPassword !== undefined
          ? { password: provisionPassword }
          : {}),
      },
    },
  });
  let urlPassword: string | undefined;
  if (url !== undefined && url.password !== "") {
    try {
      urlPassword = decodeUrlComponent(url.password, url);
    } catch {
      urlPassword = url.password;
    }
  }
  const inUrl = literalCredentials({ password: urlPassword }).length > 0;
  if (fromFlags.length === 0 && !inUrl) return undefined;

  const sources = [
    ...(inUrl ? ["the URL"] : []),
    ...fromFlags.map((field) => field.flag),
  ];
  const named =
    sources.length === 1
      ? sources[0]
      : `${sources.slice(0, -1).join(", ")} and ${sources[sources.length - 1]}`;
  const example =
    fromFlags[0]?.flagExample ?? "--server-password @./sftp-password.txt";
  return (
    `the command line holds ${sources.length === 1 ? "a credential" : "credentials"} as typed in ${named}, ` +
    "which other users of this machine can see while the command runs and " +
    "your shell may keep in its history. Put each value in a file of its " +
    "own and pass its path with a leading @" +
    (inUrl ? ", leaving the password out of the URL" : "") +
    `, e.g. ${example}.`
  );
}

/**
 * Warn when the command line holds a credential as typed. See
 * {@link commandLineLiteralCredentialNotice}.
 */
export function warnIfCommandLineHoldsLiteralCredential(
  argv: Readonly<Record<string, unknown>>,
  url: URL | undefined,
  log: { warn: (message: string) => void },
): void {
  const notice = commandLineLiteralCredentialNotice(argv, url);
  if (notice !== undefined) log.warn(notice);
}
