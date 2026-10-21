/**
 * The expert key editor's missing-field control: its copy, the fields it
 * offers, the edit it makes, and the Generate message for a refused
 * condition. No React. The rules a condition is held to are core's
 * (`keyConditionRefusal`), and so is the refusal text.
 */

import {
  admitsMissingFieldConditionType,
  sanitizeForDisplay,
} from "@alcove/core";

import { SEMANTIC_TYPE_LABELS } from "../metadataEditing";

import type {
  LinkageField,
  LinkageKey,
  keyConditionRefusal,
} from "@alcove/core";

/** The control's label, description and empty-choice placeholder. */
export const KEY_CONDITION_CONTROL = {
  label: "Match only where a field is missing",
  description:
    "Use this key only for pairs where one side's record has no valid value " +
    "for the field you choose. A match through it tells whoever receives the " +
    "result which record had none.",
  placeholder: "Every record",
} as const;

/**
 * The fields the control offers for `key`: each declared field of a type a
 * condition admits that none of the key's elements reads, plus the key's
 * current choice, so a choice an edit has since made invalid stays visible
 * beside the message that refuses it.
 */
export function keyConditionOptions(
  declaredFields: ReadonlyArray<LinkageField>,
  key: LinkageKey,
): Array<{ value: string; label: string }> {
  const read = new Set(key.elements.map((element) => element.field));
  const current = key.condition?.missingField;
  const options = declaredFields
    .filter(
      (field) =>
        admitsMissingFieldConditionType(field.type) &&
        (!read.has(field.name) || field.name === current),
    )
    .map((field) => ({
      value: field.name,
      label:
        field.name === field.type
          ? SEMANTIC_TYPE_LABELS[field.type]
          : `${SEMANTIC_TYPE_LABELS[field.type]} (${sanitizeForDisplay(field.name)})`,
    }));
  if (
    current !== undefined &&
    !options.some((option) => option.value === current)
  )
    options.push({ value: current, label: sanitizeForDisplay(current) });
  return options;
}

/**
 * `key` with its condition set to require `missingField` missing, or with no
 * condition for `null`. The property is removed rather than set to
 * `undefined`, which the rule-set comparison and the canonical encoding treat
 * as a difference.
 */
export function withKeyCondition(
  key: LinkageKey,
  missingField: string | null,
): LinkageKey {
  const { condition: _, ...rest } = key;
  return missingField === null
    ? rest
    : { ...rest, condition: { missingField } };
}

/**
 * The Generate message for a key condition core refuses: core's own refusal
 * text, opened with a capital since it stands alone here. A fixed literal per
 * rule, so it names no key or field from an imported document.
 */
export function keyConditionRefusalMessage(
  refusal: NonNullable<ReturnType<typeof keyConditionRefusal>>,
): string {
  return refusal.message.charAt(0).toUpperCase() + refusal.message.slice(1);
}
