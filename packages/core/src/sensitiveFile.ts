import YAML, { type Document, type ErrorCode, YAMLParseError } from "yaml";

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
// message, log, or stderr; only a caller-supplied path-only label may, with
// the line, column and kind of a YAML syntax error.
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
//      The caught error is never interpolated; only a YAMLParseError's `code`
//      and `linePos` are read.
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

/**
 * Where a YAML syntax error is and what kind it is, taken from the parser's
 * `code` and `linePos` fields, never its source-bearing `message`.
 */
export interface YamlSyntaxPosition {
  /** The 1-based line the parser reported. */
  readonly line: number;
  /** The 1-based column the parser reported. */
  readonly column: number;
  /** The kind of error in plain words, such as "a duplicate key". */
  readonly kind: string;
}

const YAML_SYNTAX_ERROR_KINDS: ReadonlyMap<ErrorCode, string> = new Map([
  ["DUPLICATE_KEY", "a duplicate key"],
  ["TAB_AS_INDENT", "a tab used for indentation"],
  ["BAD_INDENT", "bad indentation or an unclosed bracket"],
  ["BLOCK_AS_IMPLICIT_KEY", "a key nested on one line or bad indentation"],
  ["MULTILINE_IMPLICIT_KEY", "a missing colon or a key split across lines"],
  ["MISSING_CHAR", "an unclosed quote or bracket"],
  ["UNEXPECTED_TOKEN", "an unexpected character"],
  ["MULTIPLE_DOCS", "more than one document"],
  ["BAD_SCALAR_START", "a value starting with a reserved character"],
  ["BLOCK_IN_FLOW", "a malformed list or map inside brackets or braces"],
  ["BAD_DQ_ESCAPE", "a bad escape sequence in a double-quoted value"],
  ["KEY_OVER_1024_CHARS", "a key longer than 1024 characters"],
]);

const GENERIC_YAML_SYNTAX_ERROR_KIND = "a YAML syntax error";

/**
 * The position of a {@link YAMLParseError}, or `undefined` for any other
 * error (an unresolved alias or the alias cap throws a ReferenceError with
 * no position).
 */
function yamlSyntaxPositionOf(error: unknown): YamlSyntaxPosition | undefined {
  if (!(error instanceof YAMLParseError)) return undefined;
  const start = error.linePos?.[0];
  if (
    start === undefined ||
    !Number.isSafeInteger(start.line) ||
    !Number.isSafeInteger(start.col) ||
    start.line < 1 ||
    start.col < 1
  )
    return undefined;
  return {
    line: start.line,
    column: start.col,
    kind:
      YAML_SYNTAX_ERROR_KINDS.get(error.code) ?? GENERIC_YAML_SYNTAX_ERROR_KIND,
  };
}

/** `position` as a user reads it: "a duplicate key at line 3, column 1". */
export function describeYamlSyntaxPosition(
  position: YamlSyntaxPosition,
): string {
  return `${position.kind} at line ${position.line}, column ${position.column}`;
}

/**
 * The {@link UsageError} a sensitive YAML parse throws, with the parser's
 * {@link YamlSyntaxPosition} where it reported one.
 */
export class SensitiveYamlParseError extends UsageError {
  /** Where the parser stopped, or `undefined` when it reported no position. */
  readonly position: YamlSyntaxPosition | undefined;

  constructor(message: string, position: YamlSyntaxPosition | undefined) {
    super(message);
    this.name = "SensitiveYamlParseError";
    this.position = position;
  }
}

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

function yamlParseFailure(
  fileLabel: SensitiveFileLabel,
  parserError: unknown,
): SensitiveYamlParseError {
  const position = yamlSyntaxPositionOf(parserError);
  const reason =
    position === undefined
      ? "could not be parsed as YAML"
      : `could not be parsed as YAML: ${describeYamlSyntaxPosition(position)}`;
  const message = messageWithOperatorText`${fileLabel} ${reason}`;
  return keepOperatorSuppliedText(
    new SensitiveYamlParseError(message.text, position),
    message,
  );
}

/**
 * Parse YAML that may contain secrets. On any failure throws a
 * {@link SensitiveYamlParseError} naming `fileLabel` and, for a syntax error,
 * its line, column and kind.
 */
export function parseSensitiveYaml(
  source: string,
  fileLabel: SensitiveFileLabel,
): unknown {
  try {
    return YAML.parse(source, SAFE_YAML_OPTIONS);
  } catch (parserError) {
    throw yamlParseFailure(fileLabel, parserError);
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
  } catch (parserError) {
    throw yamlParseFailure(fileLabel, parserError);
  }
  if (doc.errors.length > 0) throw yamlParseFailure(fileLabel, doc.errors[0]);
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
