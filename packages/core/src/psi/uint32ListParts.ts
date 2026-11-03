// The body of each part of a matched-record list other than the payload rows:
// unsigned 32-bit words, little-endian. A body opens with its layout's tag and
// the part's entry count, then holds each fixed column in turn, one word per
// entry, and, for a layout with a list per entry, one count word per entry and
// then the values those counts add up to. A body is read only once the words
// its counts state are exactly the words it holds, so nothing is allocated
// for entries the part does not hold (docs/spec/PROTOCOL.md, "The part body").
import { InternalConsistencyError } from "../errors";
import {
  receiveListParts,
  WORD_LIST_BODY_PREFIX_BYTES,
  type ListPartContext,
  type MatchedListBound,
  type WordListSource,
} from "./matchedListParts";

import type { MessageConnection } from "../connection/messageConnection";

/** The shape of a word list's entries. */
export interface WordListLayout {
  /** The first word of every part's body. */
  readonly tag: number;
  /** The words each entry holds in the fixed columns. */
  readonly columns: number;
  /** Whether each entry also holds a list of values, after its count. */
  readonly ragged: boolean;
}

/** A round's index list: one position per entry. */
export const INDEX_LIST_LAYOUT: WordListLayout = {
  tag: 1,
  columns: 1,
  ragged: false,
};

/** A grouping the sender omits: one part of no entries. */
export const OMITTED_GROUPING_LAYOUT: WordListLayout = {
  tag: 2,
  columns: 0,
  ragged: false,
};

/** A grouping's run lengths: one run length per entry. */
export const RUN_LENGTHS_LAYOUT: WordListLayout = {
  tag: 3,
  columns: 1,
  ragged: false,
};

/** A grouping's owner lists: one list of ordinals per entry. */
export const OWNER_LISTS_LAYOUT: WordListLayout = {
  tag: 4,
  columns: 0,
  ragged: true,
};

/** A mapped-element list: a round, then a list of positions, per entry. */
export const MAPPED_ELEMENT_LAYOUT: WordListLayout = {
  tag: 5,
  columns: 1,
  ragged: true,
};

/** The returned mapped-element list: one row per entry. */
export const RETURNED_ELEMENT_LAYOUT: WordListLayout = {
  tag: 6,
  columns: 1,
  ragged: false,
};

/**
 * The single-pass resolved table: the sender's row, then the receiver's, per
 * entry.
 */
export const RESOLVED_TABLE_LAYOUT: WordListLayout = {
  tag: 7,
  columns: 2,
  ragged: false,
};

/** A word list as read. */
export interface WordList {
  readonly layout: WordListLayout;
  readonly entries: number;
  /** The fixed columns, each one word per entry. */
  readonly columns: ReadonlyArray<Uint32Array>;
  /** For a ragged layout, how many values each entry holds; else empty. */
  readonly counts: Uint32Array;
  /** For a ragged layout, every entry's values in entry order; else empty. */
  readonly values: Uint32Array;
}

/** The entries of a word list to send, read one at a time. */
export interface WordListEntries {
  readonly entries: number;
  /** The word fixed column `column` holds for entry `index`. */
  column(column: number, index: number): number;
  /** The values entry `index` holds, for a ragged layout. */
  ragged?(index: number): ArrayLike<number>;
}

const MAX_WORD = 0xffff_ffff;
const NO_VALUES: ArrayLike<number> = [];

/**
 * The refusal of a body whose length is not the one its counts state: a count
 * past the words it holds, words past its counts, or an entry cut short.
 */
export const WORD_LIST_LENGTH_REFUSAL =
  "is not the length its entry counts state";

function word(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_WORD)
    throw new InternalConsistencyError(
      `a list entry of ${value} is not an unsigned 32-bit whole number`,
    );
  return value;
}

/**
 * The most bytes one entry of `layout` adds to a part's body, where a ragged
 * entry holds at most `maxValues` values.
 */
export function wordListEntryBytes(
  layout: WordListLayout,
  maxValues = 0,
): number {
  return 4 * layout.columns + (layout.ragged ? 4 + 4 * maxValues : 0);
}

/**
 * `list` as a {@link WordListSource} of `layout`. A value that is not an
 * unsigned 32-bit whole number is refused before the first part is built.
 */
export function wordListSource(
  layout: WordListLayout,
  list: WordListEntries,
): WordListSource {
  const valuesOf = (index: number): ArrayLike<number> =>
    layout.ragged ? (list.ragged?.(index) ?? NO_VALUES) : NO_VALUES;
  return {
    entries: list.entries,
    // The sender measures every entry before it builds the first part, so
    // each value is checked here and a list holding a bad one sends nothing.
    entryBytes: (index) => {
      for (let column = 0; column < layout.columns; column++)
        word(list.column(column, index));
      const values = valuesOf(index);
      for (let k = 0; k < values.length; k++) word(values[k]);
      return wordListEntryBytes(layout, values.length);
    },
    writeBody(start, end, body) {
      body.setUint32(0, layout.tag, true);
      body.setUint32(4, end - start, true);
      let at = WORD_LIST_BODY_PREFIX_BYTES;
      const put = (value: number): void => {
        body.setUint32(at, word(value), true);
        at += 4;
      };
      for (let column = 0; column < layout.columns; column++)
        for (let index = start; index < end; index++)
          put(list.column(column, index));
      if (!layout.ragged) return;
      for (let index = start; index < end; index++) put(valuesOf(index).length);
      for (let index = start; index < end; index++) {
        const values = valuesOf(index);
        for (let k = 0; k < values.length; k++) put(values[k]);
      }
    },
  };
}

/**
 * Reads one part's body as a list of one of `layouts`, chosen by its tag. The
 * entry count is checked against the entries the list has still to send, and
 * the body's length against the words its counts state, before any array is
 * allocated.
 */
export function readWordListBody(
  body: Uint8Array,
  layouts: ReadonlyArray<WordListLayout>,
  part: ListPartContext,
): WordList {
  if (body.byteLength < WORD_LIST_BODY_PREFIX_BYTES)
    throw part.refuse(WORD_LIST_LENGTH_REFUSAL);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const tag = view.getUint32(0, true);
  const layout = layouts.find((candidate) => candidate.tag === tag);
  if (layout === undefined)
    throw part.refuse("is not a list of the kind awaited");
  const entries = view.getUint32(4, true);
  if (entries > part.remainingEntries)
    throw part.refuse("runs past the list's declared entries");
  const entryWords = layout.columns + (layout.ragged ? 1 : 0);
  const heldWords = body.byteLength / 4;
  if (entryWords === 0 && entries > 0)
    throw part.refuse(WORD_LIST_LENGTH_REFUSAL);
  let statedWords = 2 + entryWords * entries;
  const countsAt = 2 + layout.columns * entries;
  if (layout.ragged)
    for (let index = 0; index < entries && statedWords <= heldWords; index++)
      statedWords += view.getUint32(4 * (countsAt + index), true);
  if (statedWords !== heldWords) throw part.refuse(WORD_LIST_LENGTH_REFUSAL);

  const read = (from: number, length: number): Uint32Array => {
    const words = new Uint32Array(length);
    for (let k = 0; k < length; k++)
      words[k] = view.getUint32(4 * (from + k), true);
    return words;
  };
  const columns: Array<Uint32Array> = [];
  for (let column = 0; column < layout.columns; column++)
    columns.push(read(2 + column * entries, entries));
  return {
    layout,
    entries,
    columns,
    counts: read(countsAt, layout.ragged ? entries : 0),
    values: layout.ragged
      ? read(countsAt + entries, statedWords - countsAt - entries)
      : new Uint32Array(0),
  };
}

function joinWords(arrays: ReadonlyArray<Uint32Array>): Uint32Array {
  let length = 0;
  for (const array of arrays) length += array.length;
  const joined = new Uint32Array(length);
  let at = 0;
  for (const array of arrays) {
    joined.set(array, at);
    at += array.length;
  }
  return joined;
}

/** Joins the parts of one word list, read in order and of one layout. */
export function joinWordListParts(parts: ReadonlyArray<WordList>): WordList {
  if (parts.length === 1) return parts[0];
  const { layout } = parts[0];
  const columns: Array<Uint32Array> = [];
  for (let column = 0; column < layout.columns; column++)
    columns.push(joinWords(parts.map((part) => part.columns[column])));
  return {
    layout,
    entries: parts.reduce((sum, part) => sum + part.entries, 0),
    columns,
    counts: joinWords(parts.map((part) => part.counts)),
    values: joinWords(parts.map((part) => part.values)),
  };
}

/**
 * Receives a word list sent by `sendMatchedList` over
 * {@link wordListSource}: `receiveListParts`, each part read by
 * {@link readWordListBody} as one of `layouts`, every part after the first
 * held to the first's layout, the parts joined in order.
 */
export async function receiveWordList(
  conn: MessageConnection,
  participantId: string,
  what: string,
  bound: MatchedListBound,
  layouts: ReadonlyArray<WordListLayout>,
): Promise<WordList> {
  let first: WordListLayout | undefined;
  const parts = await receiveListParts(
    conn,
    participantId,
    what,
    bound,
    (body, part) => {
      const list = readWordListBody(body, first ? [first] : layouts, part);
      first = list.layout;
      return { part: list, entries: list.entries };
    },
  );
  return joinWordListParts(parts);
}
