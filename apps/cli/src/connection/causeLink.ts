import {
  clipToRenderedCost,
  DEFAULT_MAX_DISPLAY_LENGTH,
  redactPrivateKeyMaterial,
  renderedDisplayCost,
} from "@alcove/core";

/**
 * The labelled cause link the bounded-transport refusal builders share
 * ({@link ./frameSizeGuard}, {@link ./listingGuard}, {@link ./sftpLivenessGuard}),
 * so the order of its two transforms is fixed in one place.
 */

/**
 * What one labelled cause link, label and fragment together, may render to: the
 * per-value display budget, well under the renderer's per-link cap
 * (`COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH`), so the clip only bites an anomalous
 * fragment (transportRefusalBudget.test.ts).
 */
const CAUSE_LINK_VALUE_BUDGET = DEFAULT_MAX_DISPLAY_LENGTH;

/**
 * Compose one labelled cause link, `fragment` redacted and then fitted to
 * {@link CAUSE_LINK_VALUE_BUDGET} with the label's cost included. Bounded here
 * because nothing upstream bounds it (a peer or configured path, server text). Redact before
 * clipping, or a kept `BEGIN` marker meets {@link clipToRenderedCost}'s
 * fail-closed dangling rule. The result stays raw, escaped once where rendered.
 */
export function fittedCauseLink(label: string, fragment: string): string {
  return `${label}${clipToRenderedCost(
    redactPrivateKeyMaterial(fragment),
    CAUSE_LINK_VALUE_BUDGET - renderedDisplayCost(label),
  )}`;
}
