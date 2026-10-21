import { sanitizeForDisplay } from "@alcove/core";

import { SEMANTIC_TYPE_LABELS } from "../metadataEditing";

import type { LinkageField } from "@alcove/core";

/**
 * The label a linkage field takes in the expert key editor's field choices:
 * its type label, qualified by its name only when the two differ (an imported
 * custom-named field). The name is sanitized, as it may not be a safe type
 * token.
 */
export function linkageFieldLabel(field: LinkageField): string {
  return field.name === field.type
    ? SEMANTIC_TYPE_LABELS[field.type]
    : `${SEMANTIC_TYPE_LABELS[field.type]} (${sanitizeForDisplay(field.name)})`;
}
