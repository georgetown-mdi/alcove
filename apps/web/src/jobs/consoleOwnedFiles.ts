import fs from "node:fs";
import path from "node:path";

import { parseSensitiveJson } from "@alcove/core";

import {
  JOB_FILE_NAMES,
  PREVIOUS_CONFIGURATION_FILE_NAME,
  SIGNING_IDENTITY_FILE_NAME,
} from "./intentSchemas";
import { SIGNING_CERTIFICATE_FILE_NAME } from "./signingIdentity";
import { isPathWithin } from "./pathContainment";
import { isValidJobId } from "./workdir";
import { readBoundedMountedFile } from "./boundedMountedFile";

/** The names the console writes into the working folder itself, none of them
 * an input, each with how a refusal names it to the operator. */
const CONSOLE_WRITTEN_FILES: Readonly<Record<string, string>> = {
  [JOB_FILE_NAMES.config]: "the exchange configuration, alcove.yaml",
  [PREVIOUS_CONFIGURATION_FILE_NAME]:
    "the saved copy of the exchange configuration",
  [SIGNING_CERTIFICATE_FILE_NAME]: "your signing certificate",
  [SIGNING_IDENTITY_FILE_NAME]:
    "your signing identity, which holds the private key that signs your receipts",
};

/** The names the console writes into the working folder itself: the
 * configuration, the copy kept by saving it back, and the signing identity and
 * its exported certificate. */
export const CONSOLE_WRITTEN_NAMES: ReadonlySet<string> = new Set(
  Object.keys(CONSOLE_WRITTEN_FILES),
);

/** Whether `name`, a top-level entry of the working folder, belongs to the
 * console: a name it writes, the exchange's key file, or a job working
 * directory. */
export function isConsoleOwnedFolderName(name: string): boolean {
  return (
    CONSOLE_WRITTEN_NAMES.has(name) ||
    name === JOB_FILE_NAMES.key ||
    isValidJobId(name)
  );
}

/** Whether `name`, a top-level entry of the secrets directory, has one of the
 * console's fixed file names. Job folders live only in the working folder, so a
 * job-id-shaped name here is the operator's own. */
export function isConsoleOwnedSecretsName(name: string): boolean {
  return CONSOLE_WRITTEN_NAMES.has(name) || name === JOB_FILE_NAMES.key;
}

/** Which top-level names of a mount belong to the console. */
const CONSOLE_OWNED_NAME_TESTS: Readonly<
  Record<"folder" | "secrets", (name: string) => boolean>
> = { folder: isConsoleOwnedFolderName, secrets: isConsoleOwnedSecretsName };

/** How a refusal names the console-owned top-level entry `name`. */
function consoleOwnedDescription(name: string): string {
  if (name === JOB_FILE_NAMES.key)
    return "the exchange's key file, .alcove.key";
  if (isValidJobId(name)) return "a file in one of the console's run folders";
  return CONSOLE_WRITTEN_FILES[name] ?? "one of the console's own files";
}

/** The refusal for a credential naming a console-owned file: what the file is
 * and what to choose instead, never its path. */
export function consoleOwnedCredentialMessage(
  ownedName: string,
  credentialLabel: string,
): string {
  return (
    `The file you chose is ${consoleOwnedDescription(ownedName)}. It belongs ` +
    "to the console and is not a credential. Choose the file that holds your " +
    `SFTP ${credentialLabel} instead.`
  );
}

/** The console-owned top-level entry of the `mount` at `root` that
 * `candidate` is or is under, else undefined. Both are absolute. */
function consoleOwnedEntryUnder(
  mount: "folder" | "secrets",
  root: string,
  candidate: string,
): string | undefined {
  if (!isPathWithin(root, candidate, "strictly-under")) return undefined;
  const first = path.relative(root, candidate).split(path.sep)[0];
  return CONSOLE_OWNED_NAME_TESTS[mount](first) ? first : undefined;
}

/** `dir` resolved, and its realpath when it exists. */
function rootForms(dir: string): Array<string> {
  const resolved = path.resolve(dir);
  try {
    return [resolved, fs.realpathSync(resolved)];
  } catch {
    return [resolved];
  }
}

/**
 * The console-owned top-level entry a credential file at `filePath` is or is
 * under, in the working folder or at the top of the secrets directory, else
 * undefined. The path as given and its realpath are each checked against both
 * forms of each root, so neither a link to a console file nor a linked mount
 * hides one.
 */
function consoleOwnedCredentialEntry(
  filePath: string,
  roots: { folder: string; secrets?: string },
): string | undefined {
  const candidates = [path.resolve(filePath)];
  try {
    candidates.push(fs.realpathSync(candidates[0]));
  } catch {
    // Checked by the path as given only.
  }
  const rootList = [
    ...rootForms(roots.folder).map((root) => ["folder", root] as const),
    ...(roots.secrets !== undefined
      ? rootForms(roots.secrets).map((root) => ["secrets", root] as const)
      : []),
  ];
  for (const [mount, root] of rootList)
    for (const candidate of candidates) {
      const owned = consoleOwnedEntryUnder(mount, root, candidate);
      if (owned !== undefined) return owned;
    }
  return undefined;
}

/** The console-owned name a credential locator in `mount` resolved to, else
 * undefined: its first path segment under the mount, taken from the locator and
 * from the resolved realpath (so a symlink to one is caught). */
export function consoleOwnedMountPath(
  mount: "folder" | "secrets",
  mountRoot: string,
  subPath: Array<string>,
  resolvedPath: string,
): string | undefined {
  if (subPath.length > 0 && CONSOLE_OWNED_NAME_TESTS[mount](subPath[0]))
    return subPath[0];
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(path.resolve(mountRoot));
  } catch {
    return undefined;
  }
  return consoleOwnedEntryUnder(mount, realRoot, resolvedPath);
}

/** `filePath`'s realpath, or the path resolved when it has none. */
function realpathOrResolved(filePath: string): string {
  try {
    return fs.realpathSync(path.resolve(filePath));
  } catch {
    return path.resolve(filePath);
  }
}

/** Far above any signing identity document the CLI writes; a larger file is
 * not one and is not read. */
const MAX_IDENTITY_SHAPE_READ_BYTES = 16 * 1024;

/** Whether `value` is an object with every key in `keys`. */
function hasKeys(value: unknown, keys: ReadonlyArray<string>): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    keys.every((key) => key in value)
  );
}

/**
 * Whether the file at `filePath` holds a signing identity document, matched on
 * its structure (`version`, a `privateKey` with its `d` component, and a
 * `certificate`) rather than its values, so an identity under another name or
 * a hard link to one is caught. The content is never logged or returned.
 */
function fileHoldsSigningIdentity(filePath: string): boolean {
  const read = readBoundedMountedFile(filePath, MAX_IDENTITY_SHAPE_READ_BYTES);
  if (read.outcome !== "read") return false;
  let document: unknown;
  try {
    document = parseSensitiveJson(read.source, "credential file");
  } catch {
    return false;
  }
  return (
    hasKeys(document, ["version", "privateKey", "certificate"]) &&
    hasKeys((document as Record<string, unknown>)["privateKey"], ["d"]) &&
    hasKeys((document as Record<string, unknown>)["certificate"], [])
  );
}

/** The SFTP connection fields whose values are `@path` credential file
 * references. */
export const CREDENTIAL_FILE_FIELDS = [
  "password",
  "privateKey",
  "privateKeyPassphrase",
] as const;

/** One of {@link CREDENTIAL_FILE_FIELDS}. */
export type CredentialFileField = (typeof CREDENTIAL_FILE_FIELDS)[number];

/**
 * The first credential field whose `@path` reference names one of the
 * console's own files, with the console-owned name it resolved to, else
 * undefined. A file is the console's when it is a console-owned entry of
 * either mount ({@link consoleOwnedCredentialEntry}) or one of
 * `identityPaths`, the signing identity files this console reads, compared
 * through their links, or any file whose content is a signing identity
 * document ({@link fileHoldsSigningIdentity}). A value without the `@` prefix
 * is not a file reference and is skipped.
 */
export function consoleOwnedCredentialField(
  credentials: Readonly<Partial<Record<CredentialFileField, string>>>,
  roots: { folder: string; secrets?: string },
  identityPaths: ReadonlyArray<string> = [],
): { field: CredentialFileField; ownedName: string } | undefined {
  const identityTargets = identityPaths.map(realpathOrResolved);
  for (const field of CREDENTIAL_FILE_FIELDS) {
    const value = credentials[field];
    if (value?.startsWith("@") !== true) continue;
    const filePath = value.slice(1);
    if (identityTargets.includes(realpathOrResolved(filePath)))
      return { field, ownedName: SIGNING_IDENTITY_FILE_NAME };
    const ownedName = consoleOwnedCredentialEntry(filePath, roots);
    if (ownedName !== undefined) return { field, ownedName };
    if (fileHoldsSigningIdentity(filePath))
      return { field, ownedName: SIGNING_IDENTITY_FILE_NAME };
  }
  return undefined;
}
