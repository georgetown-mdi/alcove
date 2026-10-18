import { defaultStepsForType } from "./defaults/builtInStandardization.js";
import { columnValues, inferDateFormat } from "./utils/date.js";

import type { ColumnMetadata } from "./config/metadata.js";
import type { LinkageTerms } from "./config/linkageTermsSchema.js";
import type { Standardization } from "./config/standardizationSchema.js";
import type { CSVRow } from "./file.js";
import type { PersonColumn } from "./standardization.js";
import type { SemanticType } from "./types.js";

const PERSON_COLUMN_TYPES: ReadonlyArray<SemanticType> = [
  "first_name",
  "date_of_birth",
];

/**
 * This party's own first name and date of birth columns, each with the steps
 * that clean it, from which the shared-value screens count people
 * (docs/spec/DEFAULT_STANDARDIZATION.md, Counting distinct people).
 *
 * Each is the first `role: linkage` column of its type in `metadata`, whether
 * or not `terms` declare a field of the type. Its steps are those of the
 * transformation in `standardization` reading it for a linkage field of that
 * type, else the default pipeline for the type, a date's format inferred from
 * the column. A type with no such column is left out.
 */
export function personColumns(
  standardization: Standardization | undefined,
  metadata: ReadonlyArray<ColumnMetadata>,
  terms: LinkageTerms,
  rawRows: ReadonlyArray<CSVRow>,
): PersonColumn[] {
  return PERSON_COLUMN_TYPES.flatMap(
    (type) => ownColumn(type, standardization, metadata, terms, rawRows) ?? [],
  );
}

/**
 * This party's own last name column with the steps that clean it, from which
 * a transformation's `nullIfLastName` reads the last name
 * (docs/spec/DEFAULT_STANDARDIZATION.md, First name beside a listed last
 * name), chosen and cleaned as {@link personColumns} chooses and cleans a
 * column. `undefined` when `metadata` has no `role: linkage` last name column.
 */
export function lastNameColumn(
  standardization: Standardization | undefined,
  metadata: ReadonlyArray<ColumnMetadata>,
  terms: LinkageTerms,
  rawRows: ReadonlyArray<CSVRow>,
): PersonColumn | undefined {
  return ownColumn("last_name", standardization, metadata, terms, rawRows);
}

function ownColumn(
  type: SemanticType,
  standardization: Standardization | undefined,
  metadata: ReadonlyArray<ColumnMetadata>,
  terms: LinkageTerms,
  rawRows: ReadonlyArray<CSVRow>,
): PersonColumn | undefined {
  const column = metadata.find(
    (candidate) => candidate.type === type && candidate.role === "linkage",
  )?.name;
  if (column === undefined) return undefined;
  const fieldTypes = new Map(
    terms.linkageFields.map((field) => [field.name, field.type]),
  );
  const own = standardization?.find(
    (transformation) =>
      transformation.input === column &&
      fieldTypes.get(transformation.output) === type,
  );
  const steps =
    own !== undefined
      ? (own.steps ?? [])
      : defaultStepsForType(type, {
          dateInputFormat:
            type === "date_of_birth"
              ? inferDateFormat(columnValues(rawRows, column))
              : undefined,
        });
  return steps === undefined ? undefined : { type, column, steps };
}
