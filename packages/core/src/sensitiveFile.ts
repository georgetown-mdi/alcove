import YAML, { type Document } from "yaml";

import { UsageError } from "./errors.js";
import {
  JsonStructureBoundError,
  parseBoundedJson,
} from "./utils/boundedJson.js";
import { mergeUntouchedLines } from "./utils/mergeUntouchedLines.js";
import {
  keepOperatorSuppliedText,
  messageWithOperatorText,
  type MessageWithOperatorText,
} from "./utils/operatorSuppliedText.js";

// The single chokepoint for parsing documents that may hold secrets: the
// operator's alcove.yaml (inline SFTP credentials), the .alcove.key shared
// secret, the signing identity's private key, and a linkage-terms document the
// web app imports. The content of such a document must never reach an error
// message, log, or stderr; only a caller-supplied path-only label may.
//
// Browser-safe and shared by both apps. An ESLint ban forbids the raw parsers
// across packages/core/src (this module exempt), apps/web/src, apps/cli/src
// (outside the CLI's re-export of this module), and
// packages/peerjs-broker/src. The filesystem read stays with each CLI caller:
// an errno contains only a path and code.
//
// The parsers leak through four channels:
//
//   1. YAML.parse throws a YAMLParseError on a syntax error and a
//      ReferenceError on an unresolved alias, both embedding a source snippet.
//      The caught error is never interpolated.
//   2. YAML.parseDocument collects syntax errors in doc.errors, and an
//      unresolved alias throws only when the document is materialized
//      (toString / toJS). Both are guarded here.
//   3. Non-fatal warnings (an unresolved custom tag, a bad !!int cast) contain
//      the source line and go to process.emitWarning under Node or
//      console.warn in a browser. logLevel "error" suppresses both while still
//      throwing on fatal errors; "silent" would also swallow the throw.
//   4. JSON.parse throws a SyntaxError that can echo a leading span of the
//      source.
//
// Zod validation of the parsed value is a separate layer: its messages name
// the field and rule, never the value.

/**
 * Suppresses non-fatal warnings (channel 3) and caps alias expansion against
 * an alias bomb; `maxAliasCount: 100` pins the library default explicitly.
 */
const SAFE_YAML_OPTIONS = { logLevel: "error", maxAliasCount: 100 } as const;

/**
 * The path-only descriptor a caller names the document by, such as
 * `` `config file ${path}` ``. A label naming the operator's own path is
 * composed with {@link ./utils/operatorSuppliedText.messageWithOperatorText}
 * so the failure renders it unescaped; a plain string keeps the escape.
 */
export type SensitiveFileLabel = string | MessageWithOperatorText;

/** Reason appended after the caller's path-only label; never the parser message. */
function labelledFailure(
  fileLabel: SensitiveFileLabel,
  reason: string,
  options?: ErrorOptions,
): UsageError {
  const message = messageWithOperatorText`${fileLabel} ${reason}`;
  return keepOperatorSuppliedText(
    new UsageError(message.text, options),
    message,
  );
}

function yamlParseFailure(fileLabel: SensitiveFileLabel): UsageError {
  return labelledFailure(fileLabel, "could not be parsed as YAML");
}

/**
 * Parse YAML that may contain secrets. On any failure throws a
 * {@link UsageError} naming `fileLabel` only.
 */
export function parseSensitiveYaml(
  source: string,
  fileLabel: SensitiveFileLabel,
): unknown {
  try {
    return YAML.parse(source, SAFE_YAML_OPTIONS);
  } catch {
    throw yamlParseFailure(fileLabel);
  }
}

/**
 * Parse, edit, and re-serialize a YAML {@link Document} in one step, keeping
 * comments, key order and, where {@link keepUntouchedSourceLines} can, the
 * bytes of unchanged lines. The {@link Document} never leaves this module:
 * `edit` mutates it and returns nothing, since a method call on a Document is
 * a leak the ESLint ban cannot see. Guards channel 2 on both sides of the
 * edit; an error `edit` throws propagates unchanged.
 */
export function editSensitiveYamlDocument(
  source: string,
  fileLabel: SensitiveFileLabel,
  edit: (doc: Document) => void,
): string {
  let doc: Document;
  try {
    doc = YAML.parseDocument(source, SAFE_YAML_OPTIONS);
  } catch {
    throw yamlParseFailure(fileLabel);
  }
  if (doc.errors.length > 0) throw yamlParseFailure(fileLabel);
  edit(doc);
  let edited: string;
  try {
    edited = doc.toString();
  } catch {
    throw labelledFailure(fileLabel, "could not be serialized as YAML");
  }
  return keepUntouchedSourceLines(source, edited);
}

/**
 * `edited` with every line the edit left unchanged restored to its bytes in
 * `source` ({@link mergeUntouchedLines}), where the result parses and renders
 * back to exactly `edited`; otherwise `edited` unchanged. A failure here only
 * gives up the restoration, so it is not reported.
 */
function keepUntouchedSourceLines(source: string, edited: string): string {
  try {
    const roundTrip = YAML.parseDocument(source, SAFE_YAML_OPTIONS).toString();
    const merged = mergeUntouchedLines(source, roundTrip, edited);
    if (merged === undefined) return edited;
    const check = YAML.parseDocument(merged, SAFE_YAML_OPTIONS);
    return check.errors.length === 0 && check.toString() === edited
      ? merged
      : edited;
  } catch {
    return edited;
  }
}

/**
 * Parse JSON that may contain secrets, under {@link parseBoundedJson}'s
 * structural bound. On any failure throws a {@link UsageError} naming
 * `fileLabel` only (channel 4); a {@link JsonStructureBoundError}, which
 * contains no source bytes, is kept as its `cause`.
 */
export function parseSensitiveJson(
  source: string,
  fileLabel: SensitiveFileLabel,
): unknown {
  try {
    return parseBoundedJson(source);
  } catch (err) {
    throw labelledFailure(
      fileLabel,
      "could not be parsed as JSON",
      err instanceof JsonStructureBoundError ? { cause: err } : undefined,
    );
  }
}
