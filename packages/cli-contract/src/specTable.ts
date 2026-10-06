/** One body row of a spec table: its code-span key and its description. */
export interface SpecTableRow {
  source: string;
  description: string;
}

/**
 * The body rows of the first markdown table under `heading`, keyed on the code
 * span in the first cell. Rows start past the alignment separator and stop at
 * the next heading.
 */
export function warningSourceRows(
  markdown: string,
  heading: string,
): Array<SpecTableRow> {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) throw new Error(`no "${heading}" heading`);
  const rows: Array<SpecTableRow> = [];
  let inBody = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("#")) break;
    if (!line.trimStart().startsWith("|")) continue;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
      inBody = true;
      continue;
    }
    if (!inBody) continue;
    const [, first = "", ...rest] = line.split("|");
    const key = /^\s*`([^`]+)`\s*$/.exec(first);
    if (key === null) throw new Error(`a row without a code-span key: ${line}`);
    rows.push({ source: key[1], description: rest.join("|").trim() });
  }
  return rows;
}
