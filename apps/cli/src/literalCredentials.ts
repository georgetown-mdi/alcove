import type { HttpAuth } from "@alcove/core";
import {
  getLogger,
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
  UsageError,
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

/** The credential flags every bootstrap command defines. */
export const BOOTSTRAP_CREDENTIAL_FLAGS: readonly string[] =
  CREDENTIAL_FIELDS.map((field) => field.flag);

/** The credentials a command line holds as typed. */
export interface CommandLineLiteralCredentials {
  /** Where each one was given: a flag, or `the URL`. */
  sources: string[];
  /** How to give them from a file instead, in a form this command takes. */
  remedy: string;
}

function joinedList(items: readonly string[]): string {
  return items.length === 1
    ? items[0]
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function urlPassword(url: URL | undefined): string | undefined {
  if (url === undefined || url.password === "") return undefined;
  try {
    return decodeUrlComponent(url.password, url);
  } catch {
    return url.password;
  }
}

/** `url` as typed less its password, for an example to copy. */
function urlWithoutPassword(url: URL): string {
  const copy = new URL(url.href);
  copy.password = "";
  return redactAndRenderOperatorSuppliedText(operatorSuppliedText(copy.href));
}

/**
 * The credentials the command line holds as typed: those of `definedFlags`
 * (the credential flags the command defines) given a value not beginning with
 * `@`, and the password of `url`. Undefined when it holds none.
 */
export function commandLineLiteralCredentials(
  argv: Readonly<Record<string, unknown>>,
  url: URL | undefined,
  definedFlags: readonly string[],
): CommandLineLiteralCredentials | undefined {
  const fromFlags = CREDENTIAL_FIELDS.filter((field) => {
    if (!definedFlags.includes(field.flag)) return false;
    const value = argv[field.flag.slice(2)];
    return typeof value === "string" && !value.startsWith("@");
  });
  const password = urlPassword(url);
  const inUrl = password !== undefined && !password.startsWith("@");
  if (fromFlags.length === 0 && !inUrl) return undefined;
  const sources = [
    ...(inUrl ? ["the URL"] : []),
    ...fromFlags.map((field) => field.flag),
  ];
  const passwordField = CREDENTIAL_FIELDS[0];
  if (fromFlags.length === 0 && !definedFlags.includes(passwordField.flag))
    return {
      sources,
      remedy:
        "Put the password in a file of its own, give the URL without the " +
        "password, and set the file's path with a leading @ in " +
        "connection.server of the written configuration, e.g. " +
        `${passwordField.configExample}.`,
    };
  const example =
    fromFlags.length > 0
      ? fromFlags[0].flagExample
      : `${urlWithoutPassword(url as URL)} ${passwordField.flagExample}`;
  return {
    sources,
    remedy:
      "Put each value in a file of its own and pass its path with a leading @" +
      (inUrl ? ", leaving the password out of the URL" : "") +
      `, e.g. ${example}.`,
  };
}

/** The notice a command line holding `found` gets. */
export function commandLineLiteralCredentialNotice(
  found: CommandLineLiteralCredentials,
): string {
  return (
    `the command line holds ${found.sources.length === 1 ? "a credential" : "credentials"} as typed in ${joinedList(found.sources)}, ` +
    "which other users of this machine can see while the command runs and " +
    `your shell may keep in its history. ${found.remedy}`
  );
}

/**
 * Warn when the command line holds a credential as typed. Called when the
 * arguments are parsed, before the command contacts anything, so a run that
 * fails or is interrupted still states it.
 */
export function warnIfCommandLineHoldsLiteralCredential(
  found: CommandLineLiteralCredentials | undefined,
  log: { warn: (message: string) => void },
): void {
  if (found !== undefined) log.warn(commandLineLiteralCredentialNotice(found));
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
  const shownPath = redactAndRenderOperatorSuppliedText(
    operatorSuppliedText(configPath),
  );
  const fields = found.map((field) => field.configField);
  const which = `${fields.length === 1 ? "a credential" : "credentials"} as typed in ${joinedList(fields)}`;
  return (
    `the configuration saved to ${shownPath} holds ${which}, and anyone ` +
    "with a copy of the file can use it. Before you commit or share the " +
    "file, put the value in a file of its own and write its path with a " +
    `leading @ in its place, e.g. ${found[0].configExample}.`
  );
}

/** Where a saved-configuration warning goes. */
export interface SavedConfigWarningOptions {
  /** Defaults to the `config` logger. */
  log?: { warn: (message: string) => void };
}

/**
 * Warn when the configuration just written to `configPath` holds a
 * credential as typed.
 */
export function warnIfSavedConfigHoldsLiteralCredential(
  configPath: string,
  connection: ConnectionCredentialFields | undefined,
  options: SavedConfigWarningOptions = {},
): void {
  const warning = savedLiteralCredentialWarning(configPath, connection);
  if (warning !== undefined) (options.log ?? getLogger("config")).warn(warning);
}

/**
 * Whether the password of `url` begins with `@`: a configuration file reads
 * such a value as the path of a file holding the password, so it cannot be
 * stored there as typed.
 */
export function urlPasswordIsNotStorable(url: URL | undefined): boolean {
  return urlPassword(url)?.startsWith("@") === true;
}

/**
 * Refuse a URL whose password a configuration file cannot hold, before a
 * command that saves one does anything else. `remedy` names how this command
 * takes the password from a file instead.
 *
 * @throws {UsageError} when {@link urlPasswordIsNotStorable}.
 */
export function assertUrlPasswordStorable(
  url: URL | undefined,
  remedy: string,
): void {
  if (urlPasswordIsNotStorable(url))
    throw new UsageError(
      "the password in the URL begins with @, so it cannot be stored in the " +
        "configuration file, which reads a value beginning with @ as the " +
        "path of a file. Put the password in a file of its own, leave it out " +
        `of the URL, and ${remedy}`,
    );
}

/**
 * {@link assertUrlPasswordStorable} for a bootstrap command, where
 * `--server-password` replaces the URL's password when given.
 */
export function assertBootstrapUrlPasswordStorable(
  argv: Readonly<Record<string, unknown>>,
  url: URL | undefined,
): void {
  if (argv["server-password"] !== undefined) return;
  assertUrlPasswordStorable(
    url,
    "pass its path with a leading @, e.g. --server-password @./sftp-password.txt.",
  );
}
