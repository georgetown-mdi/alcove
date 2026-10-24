// Reader for a review rounds ledger (`scratch/review-rounds/<key>.jsonl`, rows
// in `.claude/commands/review-round.md`, Step 3), shared by the scripts that
// check one so neither imports the other.

/**
 * The ledger's rows as `{rows, unreadable}`. Each row keeps the index of the
 * line it came from so a caller can rewrite that line alone; a line that is
 * not a JSON object lands in `unreadable`.
 */
export function parseLedger(text) {
  const rows = [];
  const unreadable = [];
  text.split("\n").forEach((line, lineIndex) => {
    if (line.trim() === "") return;
    try {
      const row = JSON.parse(line);
      if (row === null || typeof row !== "object" || Array.isArray(row))
        throw new Error("not a JSON object");
      rows.push({ lineIndex, row });
    } catch (error) {
      unreadable.push({ lineNumber: lineIndex + 1, reason: error.message });
    }
  });
  return { rows, unreadable };
}
