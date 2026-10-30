/**
 * The expert key editor's missing-field control: its copy, the fields it
 * offers, the edit it makes, and the Generate message for a refused
 * condition. No React. The rules a condition is held to are core's
 * (`keyConditionRefusal`); the refusal text is this app's own.
 */

import {
  admitsMissingFieldConditionType,
  sanitizeForDisplay,
} from "@alcove/core";

import { MATCHING_METHOD_LABEL, MATCHING_METHOD_LABELS } from "../formatting";

import { linkageFieldLabel } from "./linkageFieldLabel";

import type {
  KeyConditionRule,
  LinkageField,
  LinkageKey,
  keyConditionRefusal,
} from "@alcove/core";
import type { DraftKey } from "./advancedInviteTypes";

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
    .map((field) => ({ value: field.name, label: linkageFieldLabel(field) }));
  if (
    current !== undefined &&
    !options.some((option) => option.value === current)
  ) {
    const declared = declaredFields.find((field) => field.name === current);
    options.push({
      value: current,
      label:
        declared === undefined
          ? sanitizeForDisplay(current)
          : linkageFieldLabel(declared),
    });
  }
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

/** The way out every count-only message offers besides fixing the setting it
 * names: the other matching method, quoted as the control labels it, and the
 * step that holds the control. */
export const REVEAL_IDENTIFIERS_INSTEAD =
  `set ${MATCHING_METHOD_LABEL} to "${MATCHING_METHOD_LABELS.psi}" on ` +
  "Matching & sharing.";

const OPEN_THE_KEY = "Open that key";

/**
 * The Generate message per rule core refuses a key condition under, worded
 * for this app: core's text names schema keys a user never sees. `key` is
 * the refused key's position label ("Key 2"), or `undefined` where the
 * refusal does not locate it; no key or field text from an imported
 * document is named.
 */
const KEY_CONDITION_REFUSAL_MESSAGES: Readonly<
  Record<KeyConditionRule, (key: string | undefined) => string>
> = {
  undeclared: (key) =>
    `${key ?? "A linkage key"} is set to "${KEY_CONDITION_CONTROL.label}" ` +
    "for a field that is not one of this exchange's linkage fields. " +
    `${OPEN_THE_KEY} and choose another field, or clear the choice.`,
  fieldType: (key) =>
    `${key ?? "A linkage key"} is set to "${KEY_CONDITION_CONTROL.label}" ` +
    "for a field other than a date of birth, which Alcove does not support. " +
    `${OPEN_THE_KEY} and clear the choice.`,
  readsField: (key) =>
    `${key ?? "A linkage key"} matches on a date of birth and is also set ` +
    "to match only where that date of birth is missing, so it can never " +
    `match. ${OPEN_THE_KEY} and remove the date of birth element, or clear ` +
    "the choice.",
};

/**
 * A key's label as the Keys step's key list numbers it ("Key 2", counting
 * every key, on or off), from its index into the draft's keys, for a Generate
 * message to name it by.
 */
export function keyPositionLabel(draftIndex: number): string {
  return `Key ${draftIndex + 1}`;
}

/**
 * The refused key's {@link keyPositionLabel}, from the refusal's index into
 * the built terms' keys, which hold only the keys that are on.
 */
function refusedKeyLabel(
  refusal: NonNullable<ReturnType<typeof keyConditionRefusal>>,
  draftKeys: ReadonlyArray<DraftKey>,
): string | undefined {
  const termsIndex = refusal.path[1];
  if (typeof termsIndex !== "number") return undefined;
  const draftIndex = draftKeys
    .flatMap((entry, index) => (entry.enabled ? [index] : []))
    .at(termsIndex);
  return draftIndex === undefined ? undefined : keyPositionLabel(draftIndex);
}

/**
 * The Generate message for a key condition core refuses in the terms built
 * from `draftKeys`, naming the refused key.
 */
export function keyConditionRefusalMessage(
  refusal: NonNullable<ReturnType<typeof keyConditionRefusal>>,
  draftKeys: ReadonlyArray<DraftKey>,
): string {
  return KEY_CONDITION_REFUSAL_MESSAGES[refusal.rule](
    refusedKeyLabel(refusal, draftKeys),
  );
}
