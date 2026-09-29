/**
 * How a partner's changed linkage terms are shown, in the order and under the
 * labels every front end uses: the command line's exchange and the web app's
 * console and recurring runs read the same sections from one {@link TermsDelta}.
 */

import type {
  PayloadColumnsChange,
  TermsDelta,
} from "./linkageTermsNegotiation";

/**
 * One part of how a partner's terms differ from this party's. `label` is
 * fixed text. `columns` and `differences` are the partner's column names and
 * the diagnostics naming its values, raw: the display sink escapes them.
 */
export type TermsDeltaSection =
  | { kind: "columns"; label: string; columns: string[] }
  | {
      kind: "partnerDeduplicate";
      label: string;
      expected: boolean;
      presented: boolean;
    }
  | { kind: "otherTerms"; label: string; differences: string[] };

const COLUMN_LABELS = {
  received: {
    added: "columns your partner now sends you",
    removed: "columns your partner no longer sends you",
  },
  sent: {
    added: "columns you now send your partner (your partner decides on these)",
    removed:
      "columns you no longer send your partner (your partner decides on this)",
  },
} as const;

function columnSections(
  change: PayloadColumnsChange | undefined,
  labels: { added: string; removed: string },
): TermsDeltaSection[] {
  if (change === undefined) return [];
  const sections: TermsDeltaSection[] = [];
  if (change.added.length > 0)
    sections.push({
      kind: "columns",
      label: labels.added,
      columns: change.added,
    });
  if (change.removed.length > 0)
    sections.push({
      kind: "columns",
      label: labels.removed,
      columns: change.removed,
    });
  return sections;
}

/**
 * The sections showing `delta`: the columns the partner sends, then the
 * columns this party sends, the partner's `deduplicate`, and each other term.
 * A part that does not differ has no section.
 */
export function termsDeltaSections(delta: TermsDelta): TermsDeltaSection[] {
  const sections = [
    ...columnSections(delta.received, COLUMN_LABELS.received),
    ...columnSections(delta.sent, COLUMN_LABELS.sent),
  ];
  if (delta.partnerDeduplicate !== undefined)
    sections.push({
      kind: "partnerDeduplicate",
      label: "your partner's deduplicate",
      expected: delta.partnerDeduplicate.expected,
      presented: delta.partnerDeduplicate.presented,
    });
  if (delta.otherTerms.length > 0)
    sections.push({
      kind: "otherTerms",
      label: "other terms that differ",
      differences: delta.otherTerms,
    });
  return sections;
}
