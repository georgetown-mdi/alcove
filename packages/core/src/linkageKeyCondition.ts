// The per-side missing-field condition on a linkage key: the field types it
// admits, the refusals agreed terms are held to, and the rounds a conditioned
// key runs as (docs/spec/PROTOCOL.md#keys-with-a-missing-field-condition).

import { UsageError } from "./errors.js";
import type {
  LinkageField,
  LinkageKey,
  LinkageTerms,
} from "./config/linkageTermsSchema.js";

/** The linkage-field types a missing-field condition may name. */
export type MissingFieldConditionType = "date_of_birth";

/**
 * The lowercase words naming each admitted type in a matched-key name and the
 * consent statement.
 */
export const MISSING_FIELD_CONDITION_TYPE_WORDS: Readonly<
  Record<MissingFieldConditionType, string>
> = Object.freeze({ date_of_birth: "date of birth" });

/** Whether a missing-field condition may name a field of `type`. */
export function admitsMissingFieldConditionType(
  type: LinkageField["type"],
): type is MissingFieldConditionType {
  return Object.hasOwn(MISSING_FIELD_CONDITION_TYPE_WORDS, type);
}

/**
 * The refusal message per rule a key condition breaks. Fixed literals: the
 * issue path locates the key, and no partner text is interpolated.
 */
export const KEY_CONDITION_REFUSALS = Object.freeze({
  undeclared:
    "a linkage key's missing_field condition must name a declared linkage " +
    "field (a name in linkage_fields)",
  fieldType:
    "a linkage key's missing_field condition must name a date_of_birth " +
    "field; no other field type is admitted",
  readsField:
    "a linkage key must not match on the field its missing_field condition " +
    "requires missing. Remove that element or the condition.",
});

/** A rule a key condition breaks. */
export type KeyConditionRule = keyof typeof KEY_CONDITION_REFUSALS;

/** A key-condition refusal: the rule, its message, and the issue path. */
export interface KeyConditionRefusal {
  readonly rule: KeyConditionRule;
  readonly message: string;
  readonly path: ReadonlyArray<string | number>;
}

/**
 * The first rule a document's key conditions break, or `undefined`. The one
 * reading the schema refine and {@link assertKeyConditionsAdmitted} share.
 */
export function keyConditionRefusal(
  terms: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): KeyConditionRefusal | undefined {
  const typeByName = new Map(
    terms.linkageFields.map((field) => [field.name, field.type]),
  );
  for (const [keyIndex, key] of terms.linkageKeys.entries()) {
    const condition = key.condition;
    if (condition === undefined) continue;
    const refused = (rule: KeyConditionRule): KeyConditionRefusal => ({
      rule,
      message: KEY_CONDITION_REFUSALS[rule],
      path: ["linkageKeys", keyIndex, "condition", "missingField"],
    });
    const type = typeByName.get(condition.missingField);
    if (type === undefined) return refused("undeclared");
    if (!admitsMissingFieldConditionType(type)) return refused("fieldType");
    if (
      key.elements.some((element) => element.field === condition.missingField)
    )
      return refused("readsField");
  }
  return undefined;
}

/**
 * Refuse key conditions outside {@link keyConditionRefusal}'s rules, for terms
 * built or mutated without a parse. A {@link UsageError}: on the accept side
 * the terms are the partner's.
 */
export function assertKeyConditionsAdmitted(
  terms: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): void {
  const refusal = keyConditionRefusal(terms);
  if (refusal !== undefined) throw new UsageError(refusal.message);
}

/** The PSI role whose party sends only its records lacking the field. */
export type LackingRole = "receiver" | "sender";

/**
 * One PSI round of a run: the agreed key it builds, that key's position in
 * `linkageKeys`, and for a conditioned key the role filtered in this round.
 */
export interface LinkageRound {
  readonly key: LinkageKey;
  readonly keyIndex: number;
  readonly lackingRole?: LackingRole;
}

/**
 * The rounds a run of `keys` makes, in order: one per key, and two adjacent
 * ones for a key with a missing-field condition, the receiver's half first so
 * a pair both sides lack the field for is claimed where the receiver's own
 * absence is what the round states. Both parties derive it from the agreed
 * terms alone.
 */
export function linkageRounds(keys: ReadonlyArray<LinkageKey>): LinkageRound[] {
  return keys.flatMap((key, keyIndex): LinkageRound[] =>
    key.condition === undefined
      ? [{ key, keyIndex }]
      : [
          { key, keyIndex, lackingRole: "receiver" },
          { key, keyIndex, lackingRole: "sender" },
        ],
  );
}

/** How many rounds {@link linkageRounds} gives `key`. */
export function keyRoundCount(key: LinkageKey): number {
  return linkageRounds([key]).length;
}

/**
 * The field this party builds `round` only for records lacking, or
 * `undefined` where it builds the round for every record.
 */
export function roundRequiresMissingField(
  round: LinkageRound,
  isReceiver: boolean,
): string | undefined {
  if (round.lackingRole === undefined || round.key.condition === undefined)
    return undefined;
  const thisRole: LackingRole = isReceiver ? "receiver" : "sender";
  return round.lackingRole === thisRole
    ? round.key.condition.missingField
    : undefined;
}

/**
 * The name the `matched_on_key` column gives a pair matched in `round`: the
 * key's name, and for a conditioned key's half, whose record lacked the field
 * from this party's side.
 */
export function roundMatchedKeyName(
  round: LinkageRound,
  isReceiver: boolean,
  linkageFields: ReadonlyArray<Pick<LinkageField, "name" | "type">>,
): string {
  const condition = round.key.condition;
  if (round.lackingRole === undefined || condition === undefined)
    return round.key.name;
  const type = linkageFields.find(
    (field) => field.name === condition.missingField,
  )?.type;
  const words =
    type !== undefined && admitsMissingFieldConditionType(type)
      ? MISSING_FIELD_CONDITION_TYPE_WORDS[type]
      : condition.missingField;
  const whose =
    roundRequiresMissingField(round, isReceiver) === undefined
      ? "partner's record"
      : "your record";
  return `${round.key.name} (${whose} has no valid ${words})`;
}
