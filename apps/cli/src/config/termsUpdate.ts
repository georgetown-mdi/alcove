import fs from "node:fs";

import type { LinkageTerms } from "@alcove/core";
import { parseExchangeSpec, snakeizeKey, snakeizeKeys } from "@alcove/core";

import { writeFileOwnerOnly } from "../fileUtils";
import {
  parseSensitiveYaml,
  editSensitiveYamlDocument,
} from "../sensitiveFile";

import { describeConfigSchemaError, type SchemaIssue } from "./loaders";
import {
  configFileLabel,
  configFileRefusal,
  normalizeKeyPathSpelling,
} from "./persist";
import { configWithNamedRuleSetRules } from "./ruleSetCitation";

/**
 * The fields {@link persistTermsUpdate} writes. `expectedPartnerDeduplicate`
 * is `"unchanged"` where the configuration's record is left as it stands.
 */
export interface TermsUpdateWrite {
  linkageTerms: LinkageTerms;
  expectedPartnerDeduplicate: boolean | "unchanged";
}

/**
 * Replace `linkage_terms` in an existing `alcove.yaml` and refresh the record
 * that follows from it -- `expected_partner_deduplicate` -- in one write, so
 * the record does not state a commitment the new terms do not back. Every
 * other key, the connection block included, keeps its values and its key
 * order, and a line the write does not change keeps its bytes as
 * {@link editSensitiveYamlDocument} allows.
 *
 * The edited document is read back through the same schema `alcove
 * exchange` loads it with before it is written; a document that would not
 * load is refused and the file is left unchanged.
 *
 * Rewritten with the same owner-only permissions, and the same atomic rename,
 * {@link saveConfig} uses.
 *
 * @throws {UsageError} if the edited document would not load.
 */
export function persistTermsUpdate(
  configPath: string,
  write: TermsUpdateWrite,
): void {
  const serialized = termsUpdateDocument(configPath, write);
  const loadError = termsUpdateLoadError(configPath, serialized);
  if (loadError !== undefined)
    throw configFileRefusal(
      configPath,
      "was left unchanged: with the update applied it would not load " +
        `(${describeConfigSchemaError(loadError)}).`,
    );
  writeFileOwnerOnly(configPath, serialized);
}

/**
 * The term of the configuration at `configPath` that {@link persistTermsUpdate}
 * would refuse `write` on, without writing anything: the top-level key, and
 * under `linkage_terms` the field of the linkage terms, of the first schema
 * issue. Undefined where the edited document loads.
 *
 * The top-level key is the operator's own or one this write sets, and the
 * field is named only from a fixed list, so no partner-chosen text is named.
 */
export function termsUpdateInvalidTerm(
  configPath: string,
  write: TermsUpdateWrite,
): string | undefined {
  const loadError = termsUpdateLoadError(
    configPath,
    termsUpdateDocument(configPath, write),
  );
  if (loadError === undefined) return undefined;
  const issues =
    loadError !== null && typeof loadError === "object" && "issues" in loadError
      ? (loadError as { issues?: ReadonlyArray<SchemaIssue> }).issues
      : undefined;
  const [top, field] = (issues?.[0]?.path ?? []).map((segment) =>
    typeof segment === "string" ? snakeizeKey(segment) : undefined,
  );
  if (top === undefined) return "linkage_terms";
  return top === "linkage_terms" &&
    field !== undefined &&
    (NAMED_LINKAGE_TERMS_FIELDS as ReadonlyArray<string>).includes(field)
    ? `${top}.${field}`
    : top;
}

const NAMED_LINKAGE_TERMS_FIELDS = [
  "version",
  "identity",
  "date",
  "algorithm",
  "linkage_strategy",
  "output",
  "deduplicate",
  "linkage_fields",
  "linkage_keys",
  "linkage_rule_set",
  "payload",
  "legal_agreement",
] as const;

function termsUpdateDocument(
  configPath: string,
  write: TermsUpdateWrite,
): string {
  return editSensitiveYamlDocument(
    fs.readFileSync(configPath, "utf8"),
    configFileLabel(configPath),
    (doc) => {
      for (const record of ["linkage_terms", "expected_partner_deduplicate"])
        normalizeKeyPathSpelling(configPath, doc, [record]);
      doc.setIn(
        ["linkage_terms"],
        doc.createNode(snakeizeKeys(write.linkageTerms)),
      );
      if (write.expectedPartnerDeduplicate !== "unchanged")
        doc.setIn(
          ["expected_partner_deduplicate"],
          write.expectedPartnerDeduplicate,
        );
    },
  );
}

function termsUpdateLoadError(configPath: string, serialized: string): unknown {
  try {
    parseExchangeSpec(
      configWithNamedRuleSetRules(
        parseSensitiveYaml(serialized, configFileLabel(configPath)),
        configPath,
      ),
    );
    return undefined;
  } catch (err) {
    return err;
  }
}
