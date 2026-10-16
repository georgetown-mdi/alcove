import { stringify as stringifyYaml } from "yaml";

import {
  getDefaultLinkageTerms,
  inferMetadataForEveryColumn,
  snakeizeKeys,
} from "@alcove/core";

import type { LinkageTerms, Metadata } from "@alcove/core";
import type { AcquiredCsv } from "@psi/inviterEditor";

/**
 * The fan-out configuration of docs/EXCHANGE_REFERENCE.md, "Data standardizing
 * transformations": its `standardization` block as the reference prints it,
 * `last_name` and its `split_on` variant both cleaned from `LAST_NAME`, under
 * linkage terms declaring all four fields and a key on the variant.
 */

/** The reference's `standardization` block, verbatim. */
export const REFERENCE_STANDARDIZATION_YAML = `standardization:
  - output: last_name      # matches linkage_terms.linkage_fields[].name
    input: LAST_NAME
    steps:
      - function: remove_affixes
      - function: remove_punctuation
      - function: to_upper_case

  - output: date_of_birth
    input: DOB
    steps:
      - function: parse_date
        params:
          input_format: "MM/DD/YYYY"
          output_format: "YYYYMMDD"

  - output: ssn
    input: SSN_RAW
    steps:
      - function: remove_dashes
      - function: null_if
        params:
          values: ["000000000", "123456789", "111111111"]

  - output: last_name_variants   # fan-out: one row -> multiple PSI entries (see Fan-out below)
    input: LAST_NAME
    steps:
      - function: to_upper_case
      - function: split_on
        params:
          delimiter: "[-\\\\s]"
          include_original: true  # keep "SMITH-JONES" as well as "SMITH", "JONES"
`;

/** The input file's headers: the record identifier and the three inputs the
 * block names. */
export const REFERENCE_COLUMNS = ["CLIENT_ID", "LAST_NAME", "DOB", "SSN_RAW"];

/** The file the configuration runs over. */
export function referenceCsv(): AcquiredCsv {
  return {
    fileName: "clients.csv",
    sizeBytes: 2048,
    rawRows: [
      {
        CLIENT_ID: "1",
        LAST_NAME: "Smith-Jones",
        DOB: "01/02/1990",
        SSN_RAW: "123-45-6789",
      },
    ],
    columns: REFERENCE_COLUMNS,
    rowCount: 1,
  };
}

/** The columns as the operator sets them: inference roles every header but
 * `SSN_RAW`, which it does not recognize, so that one is set to a matched
 * Social Security number column. */
export function referenceMetadata(): Metadata {
  return inferMetadataForEveryColumn(REFERENCE_COLUMNS, []).map((column) =>
    column.name === "SSN_RAW"
      ? { ...column, type: "ssn" as const, role: "linkage" as const }
      : column,
  );
}

/** The terms the configuration wraps: the default fields and keys over these
 * columns, plus `last_name_variants` and a key matching on it. The block
 * cleans no `ssn4`, and an authored standardization derives none from the SSN
 * column, so the default `ssn4` field and its keys are left out. */
export function referenceTerms(): LinkageTerms {
  const { linkageRuleSet: _cited, ...terms } = getDefaultLinkageTerms(
    "County Health",
    referenceMetadata(),
  );
  const lastName = terms.linkageFields.find(
    (field) => field.name === "last_name",
  );
  if (lastName === undefined)
    throw new Error("expected the default terms to declare last_name");
  return {
    ...terms,
    linkageFields: [
      ...terms.linkageFields.filter((field) => field.name !== "ssn4"),
      { ...lastName, name: "last_name_variants" },
    ],
    linkageKeys: [
      ...terms.linkageKeys.filter((key) =>
        key.elements.every((element) => element.field !== "ssn4"),
      ),
      {
        name: "LN variants + DOB",
        elements: [{ field: "last_name_variants" }, { field: "date_of_birth" }],
      },
    ],
  };
}

/** The whole `alcove.yaml` as pasted: the terms, then the reference block. */
export function referenceConfigurationYaml(): string {
  return `${stringifyYaml({ linkage_terms: snakeizeKeys(referenceTerms()) })}${REFERENCE_STANDARDIZATION_YAML}`;
}
