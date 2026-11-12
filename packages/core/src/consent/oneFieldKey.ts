import { fieldSourceColumnTypes } from "../standardization.js";
import type { LinkageField, LinkageKey } from "../config/linkageTermsSchema.js";

/**
 * Whether the elements of `key` could all read one input column under the
 * default binding (`resolveFieldColumns` with no authored standardization), so
 * the key matches on one field: every element names the same field, or one
 * semantic type is among `fieldSourceColumnTypes` of every element's field as
 * `fields` declares it -- two fields of one type, or a field and one derived
 * from its type. An element whose field `fields` does not declare is compared
 * by its name. A partner can fill its input with guessed values of that column
 * and learn which of them the other party's file holds (docs/SECURITY_DESIGN.md,
 * Threat model). A party's own standardization can bind two such fields to
 * different columns, and the key is still marked. Every surface that marks
 * keys reads this one test, with `ONE_FIELD_KEY_COPY` (consentFacts.ts); the
 * mark warns and never refuses a key.
 */
export function linkageKeyUsesOneField(
  key: Pick<LinkageKey, "elements">,
  fields: ReadonlyArray<Pick<LinkageField, "name" | "type">>,
): boolean {
  const typeByName = new Map(fields.map((field) => [field.name, field.type]));
  const columnsEachCouldRead = key.elements.map((element) => {
    const type = typeByName.get(element.field);
    return type === undefined
      ? [`field:${element.field}`]
      : fieldSourceColumnTypes(type).map((columnType) => `type:${columnType}`);
  });
  const [first = [], ...rest] = columnsEachCouldRead;
  return first.some((column) =>
    rest.every((candidates) => candidates.includes(column)),
  );
}
