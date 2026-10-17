// A cascade round's two position-naming frames -- the receiver's association
// table and the sender's original-index list -- are sent as matched-record
// lists in parts (matchedListParts.ts): each index list is one list, and a
// round that states groupings sends the grouping as one more list after them.
// A grouping the sender omits is a list of no entries whose one part holds
// `null`, so the receiver tells it apart from a present, empty grouping
// (docs/spec/PROTOCOL.md, "A list of matched records is sent in parts").
import { parseOrProtocolError } from "../connection/messageConnection";
import { singleIssueArray } from "../utils/singleIssueArray";
import {
  arraySource,
  receiveMatchedArray,
  receiveMatchedListParts,
  sendMatchedList,
  utf8Length,
} from "./matchedListParts";

import type { MessageConnection } from "../connection/messageConnection";
import type { MatchedListSource } from "./matchedListParts";
import type { RoundGroupingField } from "./roundGrouping";

// Validated in one pass for the reason every linkage-frame array is
// (utils/singleIssueArray.ts): a partner-controlled element count in the
// millions accumulates one issue rather than one per entry. Number.isFinite
// mirrors `z.number()` exactly.
/** @internal exported for the part-schema tests. */
export const numberArrayMessage = singleIssueArray<number>(
  Number.isFinite,
  "must be an array of finite numbers",
);

// The grouping holds either run lengths or an owner list per matched
// position; which of the two a party is required to have sent follows the
// resolved cardinality both parties hold, so the schema bounds the structure
// alone and roundGrouping.ts decides the form. A nested entry is checked by
// the same predicate and never recurses, so a deeply nested part is one
// rejection too.
/** @internal exported for the part-schema tests. */
export const roundGroupingElement = singleIssueArray<number | Array<number>>(
  (value) =>
    Number.isFinite(value) ||
    (Array.isArray(value) && value.every(Number.isFinite)),
  "must be an array of finite numbers or of arrays of finite numbers",
);

/**
 * The most UTF-8 bytes one entry of an index list adds to a part's body, its
 * separator included, when every entry is a whole number below
 * `exclusiveBound`; `undefined` where the bound is not finite.
 *
 * @internal
 */
export function roundIndexEntryBytes(
  exclusiveBound: number,
): number | undefined {
  if (!Number.isFinite(exclusiveBound)) return undefined;
  return String(Math.max(0, exclusiveBound - 1)).length + 1;
}

/** Sends one index list of a round's position-naming frame, in parts. */
export async function sendRoundIndexList(
  conn: MessageConnection,
  indices: ReadonlyArray<number>,
): Promise<void> {
  await sendMatchedList(conn, arraySource(indices));
}

/**
 * Receives one index list sent by {@link sendRoundIndexList}, refusing a list
 * declaring more than `maxEntries` entries and a part longer than its
 * remaining entries can be when each is below `exclusiveBound`. The entries'
 * range itself is checked by the caller against local state.
 */
export async function receiveRoundIndexList(
  conn: MessageConnection,
  participantId: string,
  what: string,
  maxEntries: number,
  exclusiveBound: number,
): Promise<Array<number>> {
  return receiveMatchedArray(
    conn,
    participantId,
    what,
    { entries: maxEntries, entryBytes: roundIndexEntryBytes(exclusiveBound) },
    (value) => parseOrProtocolError(numberArrayMessage, value),
  );
}

function groupingSource(
  field: RoundGroupingField | undefined,
): MatchedListSource {
  if (field === undefined)
    return { entries: 0, entryBytes: () => 0, body: () => null };
  return {
    entries: field.length,
    entryBytes: (index) => utf8Length(JSON.stringify(field[index])) + 1,
    body: (start, end) => field.slice(start, end),
  };
}

/**
 * Sends a round's grouping after the index lists it describes, in parts; an
 * omitted grouping is one part holding `null`.
 */
export async function sendRoundGrouping(
  conn: MessageConnection,
  field: RoundGroupingField | undefined,
): Promise<void> {
  await sendMatchedList(conn, groupingSource(field));
}

/**
 * Receives a grouping sent by {@link sendRoundGrouping}: `undefined` where
 * the sender omitted it, else its entries joined in order. A list declaring
 * more than `maxEntries` entries is refused at its first part.
 */
export async function receiveRoundGrouping(
  conn: MessageConnection,
  participantId: string,
  what: string,
  maxEntries: number,
): Promise<RoundGroupingField | undefined> {
  const parts = await receiveMatchedListParts(
    conn,
    participantId,
    what,
    { entries: maxEntries },
    (value) => {
      if (value === null) return { part: null, entries: 0 };
      const part = parseOrProtocolError(roundGroupingElement, value);
      return { part, entries: part.length };
    },
  );
  if (parts.length === 1) return parts[0] ?? undefined;
  const joined: Array<number | Array<number>> = [];
  for (const part of parts)
    if (part !== null) for (const entry of part) joined.push(entry);
  return joined;
}
