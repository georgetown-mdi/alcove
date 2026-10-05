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

// Each direction's sections in display order, keyed by the PayloadColumnsChange
// field each shows. Adopting the partner's terms takes the partner's list in
// both directions: in `received` its send list, so `added` is what it now
// sends; in `sent` its receive list, so `removed` -- a column it receives that
// this party does not send -- is what this party now sends.
const RECEIVED_SECTIONS = [
  { field: "added", label: "columns your partner now sends you" },
  { field: "removed", label: "columns your partner no longer sends you" },
] as const;
const SENT_SECTIONS = [
  {
    field: "removed",
    label: "columns you now send your partner (your partner decides on these)",
  },
  {
    field: "added",
    label:
      "columns you no longer send your partner (your partner decides on this)",
  },
] as const;

function columnSections(
  change: PayloadColumnsChange | undefined,
  shown: ReadonlyArray<{ field: keyof PayloadColumnsChange; label: string }>,
): TermsDeltaSection[] {
  if (change === undefined) return [];
  return shown
    .filter(({ field }) => change[field].length > 0)
    .map(({ field, label }) => ({
      kind: "columns",
      label,
      columns: change[field],
    }));
}

/**
 * The sections showing `delta`: the columns the partner sends, then the
 * columns this party sends, the partner's `deduplicate`, and each other term.
 * A part that does not differ has no section.
 */
export function termsDeltaSections(delta: TermsDelta): TermsDeltaSection[] {
  const sections = [
    ...columnSections(delta.received, RECEIVED_SECTIONS),
    ...columnSections(delta.sent, SENT_SECTIONS),
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
