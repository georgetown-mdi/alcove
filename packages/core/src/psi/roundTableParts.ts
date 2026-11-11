// A cascade round's two position-naming frames -- the receiver's association
// table and the sender's original-index list -- are sent as matched-record
// lists in parts (matchedListParts.ts) of 32-bit words (uint32ListParts.ts):
// each index list is one list, and a round that states groupings sends the
// grouping as one more list after them. A grouping the sender omits is a list
// of no entries in a layout of its own, so the receiver tells it apart from a
// present, empty grouping (docs/spec/PROTOCOL.md, "A list of matched records
// is sent in parts").
import {
  MATCHED_LIST_PART_HEADER_BYTES,
  WORD_LIST_BODY_PREFIX_BYTES,
  sendMatchedList,
  sendMatchedListWithin,
} from "./matchedListParts";
import { statedFrameBound } from "./psiSetParts";
import {
  INDEX_LIST_LAYOUT,
  OMITTED_GROUPING_LAYOUT,
  OWNER_LISTS_LAYOUT,
  RUN_LENGTHS_LAYOUT,
  receiveWordList,
  wordListEntryBytes,
  wordListSource,
} from "./uint32ListParts";

import type { MessageConnection } from "../connection/messageConnection";
import type { MatchedListBound, BinaryListSource } from "./matchedListParts";
import type { RoundGroupingBounds, RoundGroupingField } from "./roundGrouping";

/** Sends one index list of a round's position-naming frame, in parts. */
export async function sendRoundIndexList(
  conn: MessageConnection,
  indices: ArrayLike<number>,
): Promise<void> {
  await sendMatchedList(
    conn,
    wordListSource(INDEX_LIST_LAYOUT, {
      entries: indices.length,
      column: (_column, index) => indices[index],
    }),
  );
}

/**
 * Receives one index list sent by {@link sendRoundIndexList}, refusing a list
 * declaring more than `maxEntries` entries. The entries' range is checked by
 * the caller against local state.
 */
export async function receiveRoundIndexList(
  conn: MessageConnection,
  participantId: string,
  what: string,
  maxEntries: number,
): Promise<Array<number>> {
  const list = await receiveWordList(
    conn,
    participantId,
    what,
    { entries: maxEntries, entryBytes: wordListEntryBytes(INDEX_LIST_LAYOUT) },
    [INDEX_LIST_LAYOUT],
  );
  return Array.from(list.columns[0]);
}

/** @internal exported for the part tests, which send a grouping in many parts. */
export function roundGroupingSource(
  field: RoundGroupingField | undefined,
): BinaryListSource {
  if (field === undefined)
    return wordListSource(OMITTED_GROUPING_LAYOUT, {
      entries: 0,
      column: () => 0,
    });
  if (field.form === "run-lengths") {
    const { runLengths } = field;
    return wordListSource(RUN_LENGTHS_LAYOUT, {
      entries: runLengths.length,
      column: (_column, index) => runLengths[index],
    });
  }
  const { ownerCounts, owners } = field;
  const from = new Float64Array(ownerCounts.length);
  for (let t = 1; t < ownerCounts.length; t++)
    from[t] = from[t - 1] + ownerCounts[t - 1];
  return wordListSource(OWNER_LISTS_LAYOUT, {
    entries: ownerCounts.length,
    column: () => 0,
    ragged: (index) =>
      Array.prototype.slice.call(
        owners,
        from[index],
        from[index] + ownerCounts[index],
      ) as Array<number>,
  });
}

/**
 * Sends a round's grouping after the index lists it describes, in parts; an
 * omitted grouping is one part of no entries. A grouping whose parts total
 * more than the connection's stated frame bound, which the receiver holds it
 * to, sends no part: the partner is sent an abort and a `UsageError` tagged
 * with the `matches-over-limit` cause is thrown.
 */
export async function sendRoundGrouping(
  conn: MessageConnection,
  field: RoundGroupingField | undefined,
): Promise<void> {
  await sendMatchedListWithin(
    conn,
    roundGroupingSource(field),
    statedFrameBound(conn),
    { kind: "matches-over-limit", list: "grouping" },
  );
}

// A part's header and its body's layout tag and entry count, charged for each
// part the list declares; the receiver holds that count to one part per entry.
const GROUPING_PART_OVERHEAD_BYTES =
  MATCHED_LIST_PART_HEADER_BYTES + WORD_LIST_BODY_PREFIX_BYTES;

/** What a received grouping's size is derived from, all of it locally held. */
export type RoundGroupingSizeBounds = Pick<
  RoundGroupingBounds,
  "maxPositionsPerRecord" | "partnerRecordCount" | "ownerLists"
>;

/**
 * What this party admits of a partner's grouping over `matchedPositions`
 * positions: at most that many entries, and bodies no longer than the longest
 * grouping `readPartnerRoundGrouping` accepts. Run lengths: one word per
 * record, at most `min(matchedPositions, partnerRecordCount)`. Owner lists: a
 * count word per position and an ordinal word per owner, each ordinal on at
 * most `maxPositionsPerRecord` lists. Each part the list declares adds its
 * header, layout tag and entry count. Every byte of every part counts against
 * the total, which is at most `frameBound`, the bound a grouping was held to
 * in one frame, and at least the one part of an omitted grouping.
 *
 * @internal
 */
export function roundGroupingBound(
  matchedPositions: number,
  bounds: RoundGroupingSizeBounds,
  frameBound: number,
): MatchedListBound {
  const { maxPositionsPerRecord, partnerRecordCount } = bounds;
  let entryBytes: number;
  if (bounds.ownerLists) {
    const ordinals = Math.min(
      partnerRecordCount * maxPositionsPerRecord,
      partnerRecordCount * matchedPositions,
    );
    entryBytes = 4 * matchedPositions + 4 * ordinals;
  } else {
    entryBytes = 4 * Math.min(matchedPositions, partnerRecordCount);
  }
  return {
    entries: matchedPositions,
    listBytes: (declaredParts) =>
      Math.max(
        GROUPING_PART_OVERHEAD_BYTES,
        Math.min(
          entryBytes + GROUPING_PART_OVERHEAD_BYTES * declaredParts,
          frameBound,
        ),
      ),
  };
}

/**
 * Receives a grouping sent by {@link sendRoundGrouping}: `undefined` where
 * the sender omitted it, else its entries joined in order. A list declaring
 * more entries than `matchedPositions` is refused at its first part, and a
 * part past the bytes {@link roundGroupingBound} admits, every part's header
 * included and at most the connection's stated frame bound in all, before
 * its body is read.
 */
export async function receiveRoundGrouping(
  conn: MessageConnection,
  participantId: string,
  what: string,
  matchedPositions: number,
  bounds: RoundGroupingSizeBounds,
): Promise<RoundGroupingField | undefined> {
  const list = await receiveWordList(
    conn,
    participantId,
    what,
    roundGroupingBound(matchedPositions, bounds, statedFrameBound(conn)),
    [OMITTED_GROUPING_LAYOUT, RUN_LENGTHS_LAYOUT, OWNER_LISTS_LAYOUT],
  );
  if (list.layout === OMITTED_GROUPING_LAYOUT) return undefined;
  if (list.layout === RUN_LENGTHS_LAYOUT)
    return { form: "run-lengths", runLengths: list.columns[0] };
  return {
    form: "owner-lists",
    ownerCounts: list.counts,
    owners: list.values,
  };
}
