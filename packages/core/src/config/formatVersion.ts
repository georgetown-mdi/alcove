/**
 * Format versions of the files that pass between parties or are authored for
 * the CLI: how a writer picks the lowest version its content needs, and how a
 * reader refuses a file a newer Alcove made, naming the field
 * (docs/spec/EXCHANGE_FILE.md, "Versioning and compatibility policy").
 */

import { z } from "zod";

import { fittedPathSegment } from "../utils/describeDecodeError.js";
import { unreadKeyIssues, unrecognizedKeysAsWritten } from "./unreadKeys.js";

/** A field a format version after the first introduced. */
export interface FormatFeature {
  /** Where the field sits in the document, as camelCase keys. */
  readonly path: ReadonlyArray<string>;
  /** The field as the file spells it, for a message. */
  readonly name: string;
  /** The first version that has the field. */
  readonly version: number;
  /**
   * The value an older reader takes the absent field to mean. A writer omits
   * a field holding it, so the file stays readable by that reader.
   */
  readonly oldDefault?: unknown;
}

/** One format's versions: the newest this build reads, and what each added. */
export interface FormatVersionPolicy {
  /** The newest version this build reads and writes. */
  readonly current: number;
  /** Every field a version after 1 introduced. */
  readonly features: ReadonlyArray<FormatFeature>;
}

/** The policy of a format whose every field is in its first version. */
export const FIRST_FORMAT_VERSION_POLICY: FormatVersionPolicy = Object.freeze({
  current: 1,
  features: Object.freeze([]),
});

/**
 * The informational block of an invitation, a minted exchange file, or a terms
 * update: notes about the file that no reader acts on. A reader of any version
 * skips every member, a member it does not know included, and a writer holds
 * the block as the file states it, key spelling included. Alcove's names for
 * the mint time, the minting build, a label, a comment and a form hint are
 * `mintedAt`, `mintedBy`, `label`, `comment` and `formHint` in the invitation
 * and the terms update, and `minted_at`, `minted_by`, `label`, `comment` and
 * `form_hint` in the exchange file.
 */
export type FormatInfoBlock = Record<string, unknown>;

/** Reads a {@link FormatInfoBlock}: any object, every member skipped. */
export const FormatInfoBlockSchema: z.ZodType<FormatInfoBlock> = z.record(
  z.string(),
  z.unknown(),
);

function valueAtPath(
  document: unknown,
  path: ReadonlyArray<string>,
): { present: boolean; value?: unknown } {
  let node: unknown = document;
  for (const segment of path) {
    if (typeof node !== "object" || node === null || Array.isArray(node))
      return { present: false };
    if (!Object.hasOwn(node, segment)) return { present: false };
    node = (node as Record<string, unknown>)[segment];
  }
  return node === undefined
    ? { present: false }
    : { present: true, value: node };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The lowest version `document` can be written at, and the field that needs
 * it where that is above 1. A field present at any value counts.
 */
export function formatVersionNeeded(
  document: unknown,
  policy: FormatVersionPolicy,
): { version: number; feature?: FormatFeature } {
  let needed: { version: number; feature?: FormatFeature } = { version: 1 };
  for (const feature of policy.features) {
    if (feature.version <= needed.version) continue;
    if (valueAtPath(document, feature.path).present)
      needed = { version: feature.version, feature };
  }
  return needed;
}

/**
 * A copy of `document` without each field that holds its
 * {@link FormatFeature.oldDefault}, so it is written at the lowest version.
 */
export function withoutOldDefaults<T>(
  document: T,
  policy: FormatVersionPolicy,
): T {
  const copy = structuredClone(document);
  for (const feature of policy.features) {
    if (!Object.hasOwn(feature, "oldDefault")) continue;
    const found = valueAtPath(copy, feature.path);
    if (!found.present || !sameValue(found.value, feature.oldDefault)) continue;
    const parent = valueAtPath(copy, feature.path.slice(0, -1)).value;
    delete (parent as Record<string, unknown>)[feature.path.at(-1) as string];
  }
  return copy;
}

/**
 * A declared version as a number: a positive integer, or the decimal string of
 * one. `undefined` for anything else.
 */
export function declaredFormatVersion(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (typeof value === "string" && /^[1-9][0-9]{0,8}$/.test(value))
    return Number(value);
  return undefined;
}

/**
 * The refusal of a file declaring a version above `current`. Names the
 * versions only.
 */
export function newerFormatVersionMessage(
  fileName: string,
  declared: number,
  current: number,
  remedy: string,
): string {
  return (
    `${fileName} is format version ${declared}, made by a newer version of ` +
    `Alcove than this one, which reads up to version ${current}. ${remedy}`
  );
}

/**
 * The refusal of members this build does not read. Each name comes from the
 * file and is composed raw, fitted to one value's budget; the display sink
 * escapes it (CONTRIBUTING.md, Operator-facing escaping).
 */
export function newerFormatMemberMessage(
  fileName: string,
  names: ReadonlyArray<string>,
  remedy: string,
): string {
  const quoted = names.map((name) => `"${fittedPathSegment(name)}"`);
  const fields =
    quoted.length === 1
      ? `the field ${quoted.join("")}, which this version of Alcove does not`
      : `the fields ${quoted.join(", ")}, which this version of Alcove does not`;
  return (
    `${fileName} has ${fields} read: it was made by a newer version of ` +
    `Alcove. ${remedy}`
  );
}

/** The refusal of a field used under a declared version that predates it. */
export function formatVersionBelowNeededMessage(
  fileName: string,
  versionField: string,
  feature: FormatFeature,
  declared: number,
): string {
  return (
    `${fileName} declares format version ${declared}, but its field ` +
    `"${feature.name}" needs version ${feature.version}. Set ` +
    `${versionField} to ${feature.version}, or remove the field.`
  );
}

/**
 * The issue a document whose declared version is below what its fields need
 * raises, at the field's path; empty where the declaration covers them.
 * `stated` is the document as the file holds it, before a schema fills its
 * defaults, so a default counts as no field stated.
 */
export function formatVersionBelowNeededIssues(
  fileName: string,
  versionField: string,
  stated: unknown,
  declared: number,
  policy: FormatVersionPolicy,
): Array<z.core.$ZodIssue> {
  const needed = formatVersionNeeded(stated, policy);
  if (needed.feature === undefined || needed.version <= declared) return [];
  return [
    {
      code: "custom",
      path: [...needed.feature.path],
      message: formatVersionBelowNeededMessage(
        fileName,
        versionField,
        needed.feature,
        declared,
      ),
    },
  ];
}

/**
 * Each member of a nested document its parse dropped, as one issue per
 * member stating that a newer Alcove made the file. The member is named as
 * the raw document spells it, its path prefixed by `prefix`.
 */
export function droppedMemberIssues(
  fileName: string,
  remedy: string,
  prefix: ReadonlyArray<PropertyKey>,
  raw: unknown,
  camelized: unknown,
  parsed: unknown,
): Array<z.core.$ZodIssue> {
  return unrecognizedKeysAsWritten(raw, unreadKeyIssues(camelized, parsed))
    .filter((issue) => issue.code === "unrecognized_keys")
    .map((issue): z.core.$ZodIssue => ({
      code: "custom",
      path: [...prefix, ...issue.path],
      message: newerFormatMemberMessage(fileName, issue.keys, remedy),
    }));
}

/**
 * An error map refusing a strict object's unknown members as made by a newer
 * Alcove; Zod's own message for every other issue.
 */
export function newerFormatMemberErrorMap(
  fileName: string,
  remedy: string,
): z.core.$ZodErrorMap {
  return (issue) =>
    issue.code === "unrecognized_keys"
      ? newerFormatMemberMessage(fileName, issue.keys, remedy)
      : undefined;
}
