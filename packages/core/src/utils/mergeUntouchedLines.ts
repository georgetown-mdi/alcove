/** Lines of a base text replaced by `lines`: base lines `[start, end)`, or an
 * insertion before base line `start` when `start === end`. */
interface Hunk {
  start: number;
  end: number;
  lines: Array<string>;
  side: "source" | "edit";
}

/** The largest table the line diff fills; past it no merge is attempted. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * The hunks turning `base` into `other`, from a longest common subsequence of
 * their lines compared by `key`, and for each base line the index of the line
 * of `other` paired with it, or -1. Lines paired by key whose text differs each
 * become a one-line hunk. Undefined when the lines left after trimming the
 * common prefix and suffix would need a table over {@link MAX_DIFF_CELLS}.
 */
function lineHunks(
  base: Array<string>,
  other: Array<string>,
  side: Hunk["side"],
  key: (line: string) => string,
): { hunks: Array<Hunk>; paired: Array<number> } | undefined {
  const baseKeys = base.map(key);
  const otherKeys = other.map(key);
  let prefix = 0;
  while (
    prefix < base.length &&
    prefix < other.length &&
    baseKeys[prefix] === otherKeys[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < base.length - prefix &&
    suffix < other.length - prefix &&
    baseKeys[base.length - 1 - suffix] === otherKeys[other.length - 1 - suffix]
  )
    suffix++;
  const rows = base.length - prefix - suffix;
  const columns = other.length - prefix - suffix;
  if ((rows + 1) * (columns + 1) > MAX_DIFF_CELLS) return undefined;

  // lcs[i * (columns + 1) + j]: common subsequence length of the middle lines
  // of base from i and of other from j.
  const width = columns + 1;
  const lcs = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      lcs[i * width + j] =
        baseKeys[prefix + i] === otherKeys[prefix + j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const hunks: Array<Hunk> = [];
  const paired = base.map(() => -1);
  const pair = (baseIndex: number, otherIndex: number): void => {
    paired[baseIndex] = otherIndex;
    if (base[baseIndex] !== other[otherIndex])
      hunks.push({
        start: baseIndex,
        end: baseIndex + 1,
        lines: [other[otherIndex]],
        side,
      });
  };
  let open: Hunk | undefined;
  // Trailing blank lines become an insertion of their own, so a line the
  // edit adds at the same place goes before them.
  const flush = (): void => {
    if (open === undefined) return;
    let text = open.lines.length;
    while (text > 0 && open.lines[text - 1].trim() === "") text--;
    if (text > 0 || open.end > open.start)
      hunks.push({ ...open, lines: open.lines.slice(0, text) });
    if (text < open.lines.length)
      hunks.push({
        start: open.end,
        end: open.end,
        lines: open.lines.slice(text),
        side,
      });
    open = undefined;
  };
  for (let index = 0; index < prefix; index++) pair(index, index);
  let i = 0;
  let j = 0;
  while (i < rows || j < columns) {
    if (
      i < rows &&
      j < columns &&
      baseKeys[prefix + i] === otherKeys[prefix + j] &&
      lcs[i * width + j] === lcs[(i + 1) * width + j + 1] + 1
    ) {
      flush();
      pair(prefix + i, prefix + j);
      i++;
      j++;
      continue;
    }
    open ??= { start: prefix + i, end: prefix + i, lines: [], side };
    if (
      j < columns &&
      (i === rows || lcs[i * width + j + 1] > lcs[(i + 1) * width + j])
    ) {
      open.lines.push(other[prefix + j]);
      j++;
    } else {
      i++;
      open.end = prefix + i;
    }
  }
  flush();
  for (let offset = suffix; offset > 0; offset--)
    pair(base.length - offset, other.length - offset);
  return { hunks, paired };
}

function indentOf(line: string): number {
  return line.length - line.replace(/^ +/, "").length;
}

/**
 * `lines`, which replace base lines `[start, end)` and are rendered in the
 * serializer's indentation, re-indented to the source's around them: each
 * indentation width maps to the source width of the nearest paired base line
 * with that width -- inside the range first, then outward, above before below
 * at equal distance -- and a width with no such line keeps its offset from the
 * nearest mapped width below it. Comment lines do not inform the mapping, as
 * their indentation is free.
 */
function reindent(
  lines: Array<string>,
  start: number,
  end: number,
  base: Array<string>,
  sourceLines: Array<string>,
  paired: Array<number>,
): Array<string> {
  // Sequence entries map apart from other lines: a source may write a
  // sequence at its parent key's width, which the serializer indents.
  const entryWidths = new Map<number, number>();
  const widths = new Map<number, number>();
  const isEntry = (line: string): boolean => /^ *-( |$)/.test(line);
  const learn = (index: number): void => {
    const text = base[index].trim();
    if (paired[index] === -1 || text === "" || text.startsWith("#")) return;
    const known = isEntry(base[index]) ? entryWidths : widths;
    const width = indentOf(base[index]);
    if (!known.has(width))
      known.set(width, indentOf(sourceLines[paired[index]]));
  };
  for (let index = start; index < end; index++) learn(index);
  for (let distance = 1; distance <= base.length; distance++) {
    if (start - distance >= 0) learn(start - distance);
    if (end - 1 + distance < base.length) learn(end - 1 + distance);
  }
  const sourceWidth = (line: string): number => {
    const width = indentOf(line);
    const entryWidth = isEntry(line) ? entryWidths.get(width) : undefined;
    if (entryWidth !== undefined) return entryWidth;
    let nearest = -1;
    for (const known of widths.keys())
      if (known <= width && known > nearest) nearest = known;
    return nearest === -1
      ? width
      : (widths.get(nearest) ?? nearest) + width - nearest;
  };
  return lines.map((line) =>
    line.trim() === ""
      ? line
      : " ".repeat(sourceWidth(line)) + line.slice(indentOf(line)),
  );
}

/** Whether two hunks from different sides touch the same base lines. Two
 * insertions at one place do not conflict: the edit's lines go first, as the
 * writer appends a new key directly after its mapping's last line. */
function conflict(a: Hunk, b: Hunk): boolean {
  const aEmpty = a.start === a.end;
  const bEmpty = b.start === b.end;
  if (aEmpty && bEmpty) return false;
  if (aEmpty) return b.start < a.start && a.start < b.end;
  if (bEmpty) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

/** Base lines `[start, end)` with the given hunks, sorted and inside that
 * range, applied. */
function applyHunks(
  base: Array<string>,
  start: number,
  end: number,
  hunks: Array<Hunk>,
): Array<string> {
  const out: Array<string> = [];
  let cursor = start;
  for (const hunk of hunks) {
    out.push(...base.slice(cursor, hunk.start), ...hunk.lines);
    cursor = hunk.end;
  }
  out.push(...base.slice(cursor, end));
  return out;
}

/**
 * Apply the line changes an edit made to a serializer's rendering of a text
 * onto the original text, so every line the edit did not change keeps its
 * original bytes. `roundTrip` is the serializer's rendering of `source`
 * unedited and `edited` its rendering after the edit; the difference between
 * `source` and `roundTrip` is formatting the serializer normalizes.
 *
 * Where an edited line and a normalized line overlap, that stretch is taken
 * from `edited`. The result is line-level text surgery and knows nothing of
 * the syntax: a caller confirms it renders to `edited` before using it.
 * Undefined when a diff would exceed {@link MAX_DIFF_CELLS}.
 *
 * A `source` whose every line break is CRLF keeps CRLF throughout; `roundTrip`
 * and `edited` are taken to use LF.
 */
export function mergeUntouchedLines(
  source: string,
  roundTrip: string,
  edited: string,
): string | undefined {
  const crlf = /\r\n/.test(source) && !/(^|[^\r])\n/.test(source);
  const lineBreak = crlf ? "\r\n" : "\n";
  const sourceLines = source.split(lineBreak);
  const base = roundTrip.split("\n");
  const sourceDiff = lineHunks(base, sourceLines, "source", (line) =>
    line.replace(/\s+/g, ""),
  );
  const editDiff = lineHunks(base, edited.split("\n"), "edit", (line) => line);
  if (sourceDiff === undefined || editDiff === undefined) return undefined;

  const all = [...sourceDiff.hunks, ...editDiff.hunks].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  const group = all.map((_, index) => index);
  const root = (index: number): number => {
    while (group[index] !== index) index = group[index] = group[group[index]];
    return index;
  };
  for (const [a, sourceHunk] of all.entries()) {
    if (sourceHunk.side !== "source") continue;
    for (const [b, editHunk] of all.entries()) {
      if (editHunk.side === "edit" && conflict(sourceHunk, editHunk))
        group[root(a)] = root(b);
    }
  }
  const groups = new Map<number, Array<Hunk>>();
  for (const [index, hunk] of all.entries()) {
    const members = groups.get(root(index)) ?? [];
    members.push(hunk);
    groups.set(root(index), members);
  }

  const replacements = [...groups.values()]
    .map((members) => {
      const start = Math.min(...members.map((hunk) => hunk.start));
      const end = Math.max(...members.map((hunk) => hunk.end));
      const edits = members.filter((hunk) => hunk.side === "edit");
      const lines =
        edits.length === 0
          ? members[0].lines
          : reindent(
              applyHunks(base, start, end, edits),
              start,
              end,
              base,
              sourceLines,
              sourceDiff.paired,
            );
      return { start, end, lines, editFirst: edits.length > 0 ? 0 : 1 };
    })
    .sort(
      (a, b) => a.start - b.start || a.end - b.end || a.editFirst - b.editFirst,
    );

  const out: Array<string> = [];
  let cursor = 0;
  for (const replacement of replacements) {
    out.push(...base.slice(cursor, replacement.start), ...replacement.lines);
    cursor = replacement.end;
  }
  out.push(...base.slice(cursor));
  return out.join(lineBreak);
}
