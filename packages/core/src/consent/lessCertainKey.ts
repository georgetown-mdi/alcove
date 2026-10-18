import type { LinkageField, LinkageKey } from "../config/linkageTermsSchema.js";

/**
 * The field types a key built from nothing else is marked less certain over:
 * the names and the date of birth. Different people share these more often
 * the more people the two files cover, while any other identifying field in
 * the key narrows the match past that.
 */
const NAME_AND_DATE_OF_BIRTH_FIELD_TYPES: ReadonlySet<LinkageField["type"]> =
  new Set(["first_name", "last_name", "date_of_birth"]);

/**
 * Whether `key` is marked less certain: it has at least one element, and every
 * element reads a field `fields` types as a first name, last name or date of
 * birth. Read from the field types alone, never the key's name or a rule-set
 * citation, so a key written by hand or loaded from a document is marked as a
 * built-in one is. An element whose field `fields` does not declare leaves the
 * key unmarked.
 */
export function linkageKeyIsLessCertain(
  key: Pick<LinkageKey, "elements">,
  fields: ReadonlyArray<Pick<LinkageField, "name" | "type">>,
): boolean {
  if (key.elements.length === 0) return false;
  const typeByName = new Map(fields.map((field) => [field.name, field.type]));
  return key.elements.every((element) => {
    const type = typeByName.get(element.field);
    return type !== undefined && NAME_AND_DATE_OF_BIRTH_FIELD_TYPES.has(type);
  });
}
