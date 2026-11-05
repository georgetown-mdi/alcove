import fs from "node:fs";

import {
  keepOperatorSuppliedText,
  messageWithOperatorText,
  operatorSuppliedText,
  parseCertificate,
  parseSigningIdentity,
  recordedVersionMatches,
  serializeSigningIdentity,
  SIGNING_IDENTITY_VERSION,
  UsageError,
} from "@alcove/core";
import type { SigningCertificate, SigningIdentity } from "@alcove/core";

import { warnIfFileOverPermissive, writeFileOwnerOnly } from "./fileUtils";
import { parseSensitiveJson } from "./sensitiveFile";
import { firstIssue } from "./util/firstIssue";

// File custody for the long-lived signing identity (private key + self-signed
// certificate), kept separate from the rotating key file (`.alcove.key`):
// the shared secret rotates every exchange; the signing key must stay stable
// so a partner's pinned fingerprint keeps matching.
//
// The path is always the operator's (`signing.identity_file` /
// `--identity-file`); this module resolves no location of its own. Why:
// docs/notes/signing-identity-custody.md, "What a chosen location costs" and
// "The posture".

// The identity file read both loaders share, parsed only as far as JSON. A read
// failure holds only a path and errno (no file content), safe to show. The
// JSON parse can echo a span of the source, and this file holds the P-256
// private key, so it routes through parseSensitiveJson, which reports path-only
// (see sensitiveFile.ts). The wrapper distinguishes an absent file from one
// whose JSON is `null`.
function readIdentityDocument(
  identityPath: string,
): { document: unknown } | undefined {
  let source: string;
  try {
    source = fs.readFileSync(identityPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const message = messageWithOperatorText`signing identity at ${operatorSuppliedText(
      identityPath,
    )} could not be read: ${err instanceof Error ? err.message : String(err)}`;
    throw keepOperatorSuppliedText(new UsageError(message.text), message);
  }
  // Warned about on the read rather than on a successful parse: a file whose
  // JSON or version a loader goes on to reject was still read off disk, and it
  // holds the private key whether or not this process could make sense of it.
  warnIfFileOverPermissive(identityPath, "signing private key");
  const document = parseSensitiveJson(
    source,
    messageWithOperatorText`signing identity at ${operatorSuppliedText(identityPath)}`,
  );
  const otherVersion = otherIdentityFormatVersion(document);
  if (otherVersion !== undefined)
    throw identityFormatVersionError(identityPath, otherVersion);
  return { document };
}

// The identity format's version family, taken from the literal this build
// reads so the two cannot drift apart.
const IDENTITY_VERSION_FAMILY = SIGNING_IDENTITY_VERSION.slice(
  0,
  SIGNING_IDENTITY_VERSION.lastIndexOf("/") + 1,
);

// The label after the family that is named back to the operator. A longer or
// stranger value is not what a release writes, so it takes the shape refusal.
const VERSION_LABEL = /^[A-Za-z0-9._-]{1,32}$/;

/**
 * The version of a document that is a signing identity in another format of
 * this family, or `undefined` for the current format and for anything that is
 * not an identity file. Version numbers are not compared: the format counter
 * can move down as well as up, so neither side is called the older.
 */
function otherIdentityFormatVersion(document: unknown): string | undefined {
  if (document === null || typeof document !== "object") return undefined;
  const version = (document as Record<string, unknown>)["version"];
  if (typeof version !== "string" || version === SIGNING_IDENTITY_VERSION)
    return undefined;
  if (!version.startsWith(IDENTITY_VERSION_FAMILY)) return undefined;
  return VERSION_LABEL.test(version.slice(IDENTITY_VERSION_FAMILY.length))
    ? version
    : undefined;
}

/**
 * A signing identity file another version of Alcove wrote, in a format this
 * build does not read. A usage error, so the CLI exits 64.
 */
export class IdentityFormatVersionError extends UsageError {
  /** The format version the file states. */
  readonly foundVersion: string;

  constructor(message: string, foundVersion: string) {
    super(message);
    this.name = "IdentityFormatVersionError";
    this.foundVersion = foundVersion;
  }
}

function identityFormatVersionError(
  identityPath: string,
  foundVersion: string,
): IdentityFormatVersionError {
  const message = messageWithOperatorText`signing identity at ${operatorSuppliedText(
    identityPath,
  )} was written by another version of Alcove: its format is ${foundVersion}, and this version reads ${SIGNING_IDENTITY_VERSION}. Run 'alcove fingerprint --identity-file ${operatorSuppliedText(
    identityPath,
  )} --force --identity NAME' to replace it, with NAME the identity your agreed terms name (linkage_terms.identity); give --config-file for a configuration that holds it in place of --identity. The replacement is a new identity: a new key with a new fingerprint, which every partner must re-pin before your receipts verify again.`;
  return keepOperatorSuppliedText(
    new IdentityFormatVersionError(message.text, foundVersion),
    message,
  );
}

function malformedIdentity(identityPath: string, err: unknown): UsageError {
  // A schema or signing error names paths and types, never the key value, so it
  // is kept.
  const message = messageWithOperatorText`signing identity at ${operatorSuppliedText(
    identityPath,
  )} is malformed or unsupported: ${firstIssue(err)}`;
  return keepOperatorSuppliedText(new UsageError(message.text), message);
}

/**
 * Load and validate the signing identity at `identityPath`. Resolves
 * `undefined` if the file does not exist (so a caller can lazily create it).
 * Rejects with a {@link UsageError} on a malformed, unreadable, or inconsistent
 * file -- the same exit-64 classification a malformed key file gets -- and
 * with its {@link IdentityFormatVersionError} subclass on a file another
 * version of Alcove wrote in a different format. Warns
 * (advisory) if the file is readable by other users. Validation reaches
 * `crypto.subtle`, so the load is asynchronous; the file read itself is not.
 *
 * For a caller that will SIGN with the identity. One that only needs to know
 * whose certificate the file holds takes {@link loadSigningCertificate}, which
 * never imports the private key.
 */
export async function loadSigningIdentity(
  identityPath: string,
): Promise<SigningIdentity | undefined> {
  const read = readIdentityDocument(identityPath);
  if (read === undefined) return undefined;
  let identity: SigningIdentity;
  try {
    identity = await parseSigningIdentity(read.document);
  } catch (err: unknown) {
    throw malformedIdentity(identityPath, err);
  }
  return identity;
}

/**
 * Load the CERTIFICATE half of the signing identity at `identityPath`: the
 * file's format version and its certificate (key encoding and self-signature)
 * are checked, the private key stored beside it is neither imported nor
 * compared against the certificate. The whole document is read and parsed
 * either way, so this is a narrower USE of the file, not a narrower read of it.
 * Resolves `undefined` if the file does not exist; rejects and warns on the
 * same terms as {@link loadSigningIdentity}, the permission warning included --
 * the file holds the private key whichever half was taken from it.
 *
 * For a caller that only needs to know WHOSE certificate the file holds -- a
 * fingerprint to compare, an identity to name -- rather than to sign with it.
 * A caller that will sign takes {@link loadSigningIdentity}, whose consistency
 * check is what refuses a private key that no longer matches its certificate.
 *
 * The console asks the same question of the same file before a run it launches,
 * through a reader of its own, so the two are driven over one set of documents
 * (`@alcove/core/testing`, this leg
 * `apps/cli/test/unit/boundIdentityParity.test.ts`): tightening what this
 * accepts fails that set until the console's reader follows.
 */
export async function loadSigningCertificate(
  identityPath: string,
): Promise<SigningCertificate | undefined> {
  const read = readIdentityDocument(identityPath);
  if (read === undefined) return undefined;
  // The certificate holds its own version literal, but the document around it
  // does not have to be an identity file at all; checking it keeps an
  // unrecognized identity format from being mined for a certificate here while
  // loadSigningIdentity refuses it.
  if (!recordedVersionMatches(read.document, SIGNING_IDENTITY_VERSION))
    throw malformedIdentity(
      identityPath,
      new Error(
        `expected version ${SIGNING_IDENTITY_VERSION}; this is not a signing ` +
          "identity file of a recognized format",
      ),
    );
  let certificate: SigningCertificate;
  try {
    certificate = await parseCertificate(
      (read.document as Record<string, unknown>)["certificate"],
    );
  } catch (err: unknown) {
    throw malformedIdentity(identityPath, err);
  }
  return certificate;
}

/**
 * Write `identity` to `identityPath` owner-read-only, via the shared atomic
 * owner-only write path (`0600` on Unix, a restricted ACL on Windows). Creates
 * parent directories as needed. Pass `exclusive` when first creating the
 * identity so a concurrent creator cannot silently overwrite it (a regenerate
 * overwrites by design and omits it).
 */
export function saveSigningIdentity(
  identityPath: string,
  identity: SigningIdentity,
  options: { exclusive?: boolean } = {},
): void {
  writeFileOwnerOnly(identityPath, serializeSigningIdentity(identity), options);
}
