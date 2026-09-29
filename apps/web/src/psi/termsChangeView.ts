import {
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  sanitizeForDisplay,
  termsDeltaSections,
} from "@alcove/core";

import type { TermsDelta } from "@alcove/core";

/** One labelled part of a partner terms change, ready to render. */
export interface TermsChangeViewSection {
  /** Fixed text, sentence-cased. */
  label: string;
  /** The entries under the label, each display-safe; a single line where the
   * part is one value. */
  entries: Array<string>;
}

function sentenceCased(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * How the web app shows a partner terms change: core's sections
 * (`termsDeltaSections`), the order and labels the command line shows them
 * in. `delta` holds partner-chosen names and diagnostics; `escaped` says
 * whether they arrived already escaped -- a console run's, which the CLI and
 * the relay escaped -- or raw from this browser's own run, which are escaped
 * here as the command line escapes them.
 */
export function termsChangeView(
  delta: TermsDelta,
  escaped: boolean,
): Array<TermsChangeViewSection> {
  const shown = (text: string, maxLength?: number): string =>
    escaped
      ? text
      : sanitizeForDisplay(text, maxLength !== undefined ? { maxLength } : {});
  return termsDeltaSections(delta).map((section) => {
    switch (section.kind) {
      case "columns":
        return {
          label: sentenceCased(section.label),
          entries: section.columns.map((column) => shown(column)),
        };
      case "partnerDeduplicate":
        return {
          label: sentenceCased(section.label),
          entries: [
            `${String(section.expected)} -> ${String(section.presented)}`,
          ],
        };
      case "otherTerms":
        return {
          label: sentenceCased(section.label),
          entries: section.differences.map((difference) =>
            shown(difference, WARNING_MESSAGE_MAX_DISPLAY_LENGTH),
          ),
        };
    }
  });
}
