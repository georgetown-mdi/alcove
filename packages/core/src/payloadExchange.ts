import * as z from "zod";

import type { HandshakeRole, AssociationTable } from "./types.js";
import type { Metadata, OwnColumnSelection } from "./config/metadata.js";
import {
  isDisclosedToPartner,
  disclosedColumnNames,
  inferMetadata,
  overlongDisclosedColumnPositions,
  ownResultColumnNames,
} from "./config/metadata.js";
import type {
  LinkageTerms,
  Output,
  Payload,
  PayloadColumn,
} from "./config/linkageTermsSchema.js";
import { MAX_NAME_LENGTH } from "./config/linkageTermsSchema.js";
import type { CompatibilityMessageFragment } from "./config/compatibilityMessage.js";
import {
  compatibilityMessage,
  quoteTermsValueList,
} from "./config/compatibilityMessage.js";
import { DEFAULT_CSV_DELIMITER, isCsvDelimiter } from "./csvDelimiter.js";
import { readRowColumn } from "./file.js";
import type { CSVRow } from "./file.js";
import type { CommittedPayload } from "./records/exchangeRecord.js";
import type { MessageConnection } from "./connection/messageConnection.js";
import {
  ConnectionError,
  parseOrProtocolError,
} from "./connection/messageConnection.js";
import {
  parseMatchedListParts,
  receiveMatchedListParts,
  sendMatchedList,
  utf8Length,
} from "./psi/matchedListParts.js";
import type { MatchedListSource } from "./psi/matchedListParts.js";
import { ShardedMap } from "./psi/shardedMap.js";
import { redactPrivateKeyMaterial } from "./utils/sanitizeErrorForDisplay.js";
import { singleIssueArray } from "./utils/singleIssueArray.js";
import { loneSurrogateIndex } from "./utils/wellFormedString.js";
import {
  InternalConsistencyError,
  ProtocolRefusalError,
  UsageError,
  isTransportPublishIndeterminate,
} from "./errors.js";

/** The payload received from the exchange partner after PSI linkage. */
export interface PartnerPayload {
  /**
   * All payload column names from the partner. Empty when partner had no data.
   */
  columns: string[];
  /**
   * The sender's original row indices, one per entry in {@link rows}.
   * `rowIndices[i]` is the sender's row index for the record in `rows[i]`. As a
   * lookup key, these values correspond to element `[1]` of the receiver's
   * local {@link AssociationTable} (the partner indices stored there are the
   * sender's row indices). Distinct: one entry addresses one of the sender's
   * rows, so a received message repeating an index is refused at parse.
   * Several of the receiver's association entries may address ONE of these --
   * what a deduplicating cardinality groups -- and the receiver joins them all
   * back to the single row it was sent. Empty when partner had no data.
   */
  rowIndices: number[];
  /**
   * Payload rows, one per DISTINCT matched record of the sender. Positional
   * against {@link columns}: `rows[i][j]` is the value the column named at
   * `columns[j]` contributed, so every row has exactly one cell per column
   * and a received message whose rows do not is refused at parse. Empty when
   * partner had no data.
   */
  rows: Array<Array<string | null>>;
}

// `rows` is a 2-D partner-controlled collection, bounded as ONE single-issue
// validator (utils/singleIssueArray.ts) over the whole structure rather than
// `z.array(z.array(z.string().nullable()))`. It is exposed to BOTH Zod
// RangeError classes on Zod 4.5.4: a single row of hundreds of thousands of
// invalid inner cells overflows the call stack spreading one issue per cell up
// through the inner-array and outer-`rows` frames (`Maximum call stack size
// exceeded`, ~300k), and a payload of millions of invalid ROWS throws `Invalid
// string length` building the error string from one issue per row (~3.3M).
// `isPayloadRow` validates a whole row (is-array, every cell string-or-null)
// INSIDE the outer single-issue `every`, so the entire structure yields at
// most one issue regardless of row OR cell count. A `.max()` is unsafe on
// either axis: a real exchange has one row per matched record, each as wide as
// the payload, both legitimately in the millions (MAX_FRAME_SIZE_BYTES bounds
// them). Each predicate stands in for the element schema it replaces --
// `z.string().nullable()` for a cell, the inner `z.array(...)` for a row --
// and the differential in test/payloadExchange.test.ts holds the two to the
// same accepted set.
// A received cell and column name go verbatim into the CommittedPayload the
// receipt MAC and the record commitments are canonically encoded over
// (toCommittedPayload), and that encoder terminates on an unpaired UTF-16
// surrogate -- which JSON escapes on the way out and restores on the way in,
// so one crosses the wire intact. Both are held to the shared well-formedness
// rule here, at the parse, rather than at an encode that runs after the
// exchange has disclosed. See docs/spec/CANONICAL_ENCODING.md, "Strings".
const isPayloadCell = (cell: unknown): boolean =>
  cell === null || (typeof cell === "string" && loneSurrogateIndex(cell) < 0);
const isPayloadRow = (row: unknown): boolean =>
  Array.isArray(row) && row.every(isPayloadCell);

// `rowIndices` is the lookup key the receiver reads the message by: each entry
// names one of the sender's rows and pairs it with the row of `rows` at the
// same position, so a repeat names two payload rows for one record and the
// message does not say which is the record's. A structural property of the
// frame, refused here alongside every other malformed shape rather than
// downstream. The scan runs only on a frame that already passed length parity,
// stops at the first repeat, and its map is sized by the entries the frame
// already materialized, not by any bound the partner names.
const hasDistinctRowIndices = (rowIndices: ReadonlyArray<number>): boolean => {
  const seen = new ShardedMap<number, true>();
  for (const rowIndex of rowIndices)
    if (seen.setIfAbsent(rowIndex, true) !== undefined) return false;
  return true;
};

// A payload row is positional against `columns`: its cell at each offset is
// the value of the column named at that offset, so a row of any other width
// has a value no column names or leaves a named column without one -- and
// a frame naming NO column while holding rows is the whole of one row's
// values against none. The record commits the column names and the row
// VALUES together (toCommittedPayload) while its readable governance list is
// the names alone, so the two halves of one exchange record describe the same
// disclosure only while the widths agree. A structural property of the frame,
// refused here alongside every other malformed shape rather than at the
// record or output stage that reads it. preparePayload emits exactly one cell
// per transmitted column, so no honest frame is narrowed by this. The scan
// reads only the row lengths the frame already materialized and stops at the
// first offender.
//
// Each row is held to being an array before its width is read: a string
// has a `length` of its own, so one spelling the declared count would
// pass a width comparison alone and hand out its characters as the row's
// cells. The wire schema refuses a non-array row at parse, but this guard
// also stands behind an exported entry point whose PartnerPayload argument no
// type ties to a parsed frame.
const hasOneCellPerColumn = (
  columnCount: number,
  rows: ReadonlyArray<ReadonlyArray<string | null>>,
): boolean =>
  rows.every((row) => Array.isArray(row) && row.length === columnCount);

const payloadWireSchema = z.discriminatedUnion("hasData", [
  z.object({ hasData: z.literal(false) }),
  z
    .object({
      hasData: z.literal(true),
      // `columns` and `rowIndices` are flat arrays one object-frame below this
      // object, so a pathological count cannot drive the ~130k STACK overflow
      // `rows` faces -- but a far larger count (~millions of invalid elements,
      // within the frame cap) makes Zod throw a DIFFERENT RangeError ("Invalid
      // string length", ~3.3M on Zod 4.5.4) building its error string from one
      // issue per element. receiveParsed reports that as a clean
      // ConnectionError("protocol"); on 4.5.4 the ZodError's message is built
      // lazily, so the wrap sees only the ZodError, and the RangeError, if it
      // fires at all, does so later when something reads the cause's message.
      // The single-issue validators below cap issue accumulation at one
      // regardless of count
      // (utils/singleIssueArray.ts), which payloadExchange.test.ts drives at a
      // count that would otherwise build that string. A count `.max()` is
      // wrong for `rowIndices` (one per matched record, legitimately in the
      // millions like `rows`) and unnecessary for `columns`; both predicates
      // stand in for the element schema they replace -- typeof-string for
      // `z.string()`, Number.isSafeInteger and `>= 0` for
      // `z.number().int().nonnegative()` -- under the same differential that
      // covers the `rows` predicates.
      //
      // `columns` additionally bounds each NAME's LENGTH to the same
      // MAX_NAME_LENGTH ceiling the operator's own `terms.payload.receive`
      // names have: a received column name flows verbatim into this party's
      // local exchange-record file (via governance.payloadReceived), so it
      // has the same bound those names do. Both the `.min(1)` floor and
      // the MAX_NAME_LENGTH ceiling are enforced here, as a per-ELEMENT length
      // check folded into the same single `every` pass (not a count `.max()`),
      // so it caps accumulation at one issue regardless of element count. The
      // floor is safe against an honest sender: inferMetadata rejects an empty
      // name at intake, so an honest sender never emits a `""` column (e.g.
      // from a trailing-comma CSV header); it instead refuses a partner who
      // hand-crafts `[""]` to suppress this party's record (the
      // exchange-record `.min(1)` remains the on-disk safety check). The
      // well-formedness scan stated at `isPayloadCell` rides in the same pass,
      // a name being committed exactly as a cell is.
      columns: singleIssueArray<string>(
        (value) =>
          typeof value === "string" &&
          value.length >= 1 &&
          value.length <= MAX_NAME_LENGTH &&
          loneSurrogateIndex(value) < 0,
        `each column name must be a string of 1 to ${MAX_NAME_LENGTH} characters with no unpaired UTF-16 surrogate`,
      ),
      rowIndices: singleIssueArray<number>(
        (value) => Number.isSafeInteger(value) && (value as number) >= 0,
        "each row index must be a non-negative integer",
      ),
      rows: singleIssueArray<Array<string | null>>(
        isPayloadRow,
        "each payload row must be an array of strings or nulls with no unpaired UTF-16 surrogate",
      ),
    })
    .superRefine((v, ctx) => {
      // Ordered by cost, so a frame refused on one check never pays the next:
      // parity is a length comparison, the width scan reads lengths and allocates
      // nothing, and only the distinctness scan builds a Set over the entries.
      if (v.rowIndices.length !== v.rows.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "rowIndices and rows must have the same length",
        });
        return;
      }
      if (!hasOneCellPerColumn(v.columns.length, v.rows)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "each payload row must have one value per declared column",
        });
        return;
      }
      if (!hasDistinctRowIndices(v.rowIndices)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "rowIndices must not repeat a row index",
        });
      }
    }),
]);

/**
 * Wire format sent over the connection during payload exchange.
 *
 * Exported only because it is the return type of {@link preparePayload};
 * callers should use type inference rather than naming this type directly. Do
 * not widen this to a documented public API type.
 *
 * @internal
 */
export type PayloadWireMessage = z.infer<typeof payloadWireSchema>;

/**
 * The local rows a payload frame holds for a matched table: each distinct
 * matched row once, in first-occurrence order.
 *
 * A payload row is addressed by the SENDER's own row index, so a frame
 * holds one row per matched RECORD however many pairs that record stands
 * in. Under a deduplicating cardinality the local half of the association
 * table repeats a row -- several of the partner's records link to one of this
 * party's (see {@link AssociationTable}) -- and emitting one payload row per
 * PAIR would repeat an index, which the receiver's parse refuses as a
 * malformed frame, and would put one record's values in the committed
 * payload several times.
 *
 * The re-supply path reproduces this same selection from the retained result
 * file (`reconstructCommittedData`, recordVerification.ts), so a sender
 * reopens its own payload commitment from its own retained files; both sides
 * read this one definition rather than restating it.
 */
export function distinctMatchedRows(
  matchedRows: ReadonlyArray<number>,
): number[] {
  const seen = new ShardedMap<number, true>();
  const distinct: number[] = [];
  for (const row of matchedRows)
    if (seen.setIfAbsent(row, true) === undefined) distinct.push(row);
  return distinct;
}

/**
 * Prepares the payload message to send after PSI linkage.
 *
 * Gathers all `isPayload` columns from the matched rows -- each row
 * `associationTable[0]` names, once ({@link distinctMatchedRows}) -- and packages
 * them for transmission. A `role: ignored` column is never transmitted,
 * regardless of its `isPayload` value -- the role is the explicit "use this
 * column for nothing" opt-out, so it wins over any `isPayload: true` left on the
 * column. Returns a no-data message when the dataset has no transmittable payload
 * columns or no matched rows.
 */
export function preparePayload(
  rawRows: Array<CSVRow>,
  metadata: Metadata,
  associationTable: AssociationTable,
): PayloadWireMessage {
  const payloadCols = metadata.filter(isDisclosedToPartner);
  if (payloadCols.length === 0 || associationTable[0].length === 0) {
    return { hasData: false };
  }

  const columns = payloadCols.map((col) => col.name);
  const rowIndices = distinctMatchedRows(associationTable[0]);
  const rows = rowIndices.map((idx) => {
    const row = rawRows[idx];
    return columns.map((col) =>
      row ? (readRowColumn(row, col) ?? null) : null,
    );
  });

  return { hasData: true, columns, rowIndices, rows };
}

/**
 * `terms` as this party states them to the partner at the terms exchange:
 * `payload.send` is stated as the columns `metadata` discloses
 * (`isDisclosedToPartner`), so the partner's `payload.receive` is compared
 * against, or filled from, the set this party sends. A present `send` naming
 * exactly those columns is kept as authored, descriptions and order included;
 * one naming any other set is replaced by the disclosed columns, each keeping
 * the description the authored list gave it, and the partner sees the change
 * at the terms exchange. Terms under which no payload moves to the partner
 * state nothing: a count-only (`psi-c`) document, or `output.shareWithPartner`
 * false.
 */
export function termsStatingDeclaredPayloadSend(
  terms: LinkageTerms,
  metadata: Metadata,
): LinkageTerms {
  if (!payloadSendStatedFromMetadata(terms)) return terms;
  const disclosed = disclosedColumnNames(metadata);
  const authored = terms.payload?.send;
  if (
    authored !== undefined &&
    authored.length === disclosed.length &&
    new Set([...authored.map(({ name }) => name), ...disclosed]).size ===
      disclosed.length
  )
    return terms;
  const authoredByName = new Map(
    (authored ?? []).map((column) => [column.name, column]),
  );
  return {
    ...terms,
    payload: {
      ...terms.payload,
      send: disclosed.map((name) => authoredByName.get(name) ?? { name }),
    },
  };
}

/** Whether the terms exchange states `terms`' send set from the metadata
 * ({@link termsStatingDeclaredPayloadSend}) rather than sending it as written. */
function payloadSendStatedFromMetadata(terms: LinkageTerms): boolean {
  return terms.algorithm !== "psi-c" && terms.output.shareWithPartner;
}

/**
 * This party's terms as a run under them stated them at the terms exchange,
 * for a verifier recomputing the agreed-terms hash from a configuration after
 * the fact: `payload.send` is stated from the configuration's `metadata`
 * ({@link termsStatingDeclaredPayloadSend}), or, where it holds none, from the
 * metadata the run inferred from its input header, as `resolveExchangeInputs`
 * infers it. With neither, a present `send` is taken as the run stated it,
 * and `sendSetUnknown` is true for an unset one: the terms are then returned
 * as written and a hash recomputed from them does not match the run's.
 */
export function termsAsTheRunStatedThem(
  terms: LinkageTerms,
  source: {
    metadata?: Metadata;
    inputHeader?: {
      columns: Array<string>;
      sanitizedColumnPositions: ReadonlyArray<number>;
    };
  },
): { terms: LinkageTerms; sendSetUnknown: boolean } {
  if (!payloadSendStatedFromMetadata(terms))
    return { terms, sendSetUnknown: false };
  const metadata =
    source.metadata ??
    (source.inputHeader === undefined
      ? undefined
      : inferMetadata(
          source.inputHeader.columns,
          source.inputHeader.sanitizedColumnPositions,
        ));
  if (metadata === undefined)
    return { terms, sendSetUnknown: terms.payload?.send === undefined };
  return {
    terms: termsStatingDeclaredPayloadSend(terms, metadata),
    sendSetUnknown: false,
  };
}

/**
 * Reject a PRESENT `payload.send` data dictionary that does not name EXACTLY
 * the columns this party transmits.
 *
 * `payload.send` is the operator-authored data dictionary: exchanged with the
 * partner, shown on the consent screen, written into the exchange record's
 * `payloadSent`, and mirrored into the partner's `payload.receive`. What
 * actually leaves the machine is decided
 * independently by each column's metadata via {@link isDisclosedToPartner}
 * (`isPayload && role !== "ignored"`), the set {@link preparePayload}
 * transmits -- so a dictionary can drift from what metadata sends in either
 * direction: OVER-declaration (a name metadata does not transmit) claims more
 * than was sent; UNDER-declaration (a column metadata transmits but the
 * dictionary omits) claims less.
 *
 * An ABSENT `payload.send` is not checked: the guided and default paths author
 * no dictionary while metadata still transmits, and the terms exchange states
 * it from that same metadata ({@link termsStatingDeclaredPayloadSend}). A
 * PRESENT-but-empty dictionary IS checked: it is an explicit "I disclose
 * nothing," so any disclosed column is an under-declaration -- except when
 * `output.shareWithPartner` is false, since `runExchange` then sends nothing
 * regardless of what metadata discloses and there is nothing left to control.
 * The non-empty case is never gated on `output`: the dictionary is exchanged,
 * shown for consent, and recorded whatever the output direction, so it is held
 * to the disclosed set even when the columns never move. `payload.receive` is
 * out of scope: metadata gates sending, not receiving; `validateCompatibility`
 * cross-checks it instead.
 *
 * Enforced at the web app's first mint (`generateInvitation`), against terms
 * its own editor composed. Every other mint, like an exchange, does not refuse
 * the drift: it states the disclosed set
 * ({@link termsStatingDeclaredPayloadSend}), and a partner holding the earlier
 * set sees the change at the terms exchange.
 * Offending names are partner-controlled on the accept side, so the messages
 * below compose through {@link compatibilityMessage}
 * (`config/compatibilityMessage.ts`), as `validateCompatibility`'s
 * payload-mismatch messages do: each name stands in its own delimited run, so
 * none can forge the bracketed list's partition or a clause of Alcove's own,
 * and the display escape still runs once where the error is rendered.
 *
 * @param output This party's own output declaration, from the same
 *   {@link LinkageTerms} the `payload` comes from. Required so every call
 *   site states the direction and the `shareWithPartner` reading lives here
 *   alone.
 * @throws {UsageError} when a present `payload.send` does not name exactly the
 *   columns metadata discloses. A {@link UsageError} so the CLI classifies it as a
 *   configuration error (exit 64), not a transport failure.
 */
export function assertPayloadSendDisclosed(
  payload: Payload | undefined,
  metadata: Metadata,
  output: Output,
): void {
  const send = payload?.send;
  if (send === undefined) return;
  if (send.length === 0 && !output.shareWithPartner) return;
  const sendNames = send.map((column) => column.name);
  const disclosed = disclosedColumnNames(metadata);
  const disclosedSet = new Set(disclosed);
  const sendSet = new Set(sendNames);
  const overDeclared = sendNames.filter((name) => !disclosedSet.has(name));
  const underDeclared = disclosed.filter((name) => !sendSet.has(name));
  if (overDeclared.length === 0 && underDeclared.length === 0) return;
  const problems: CompatibilityMessageFragment[] = [];
  const remedies: CompatibilityMessageFragment[] = [];
  if (overDeclared.length > 0) {
    const shown = quoteTermsValueList(overDeclared);
    const plural = overDeclared.length > 1;
    problems.push(
      plural
        ? compatibilityMessage`names columns metadata does not transmit ([${shown}])`
        : compatibilityMessage`names a column metadata does not transmit ([${shown}])`,
    );
    remedies.push(
      plural
        ? compatibilityMessage`Remove [${shown}] from payload.send, or set their metadata to transmit (is_payload: true and role not ignored).`
        : compatibilityMessage`Remove [${shown}] from payload.send, or set its metadata to transmit (is_payload: true and role not ignored).`,
    );
  }
  if (underDeclared.length > 0) {
    const shown = quoteTermsValueList(underDeclared);
    const plural = underDeclared.length > 1;
    problems.push(
      plural
        ? compatibilityMessage`omits columns metadata does transmit ([${shown}])`
        : compatibilityMessage`omits a column metadata does transmit ([${shown}])`,
    );
    // An EMPTY send gets a different remedy: "add them to payload.send" is wrong
    // advice there. On an accepted invitation the empty send is the mirror of the
    // inviter's `payload.receive: []` -- the partner declared it will take nothing
    // -- so widening the declaration locally would not make the disclosure agreed,
    // and the next acceptance would overwrite it. Narrowing what is transmitted,
    // or getting a corrected invitation, are the remedies that exist.
    if (sendNames.length === 0)
      remedies.push(
        compatibilityMessage`Set the metadata for [${shown}] not to transmit (is_payload: false or role ignored). An empty payload.send declares that this party discloses nothing; on an accepted invitation it mirrors the partner's payload.receive, so disclosing these columns instead takes a corrected invitation, not a local edit.`,
      );
    else
      remedies.push(
        plural
          ? compatibilityMessage`Add [${shown}] to payload.send, or set their metadata not to transmit (is_payload: false or role ignored).`
          : compatibilityMessage`Add [${shown}] to payload.send, or set its metadata not to transmit (is_payload: false or role ignored).`,
      );
  }
  // Folded through the tag rather than joined: `join` yields a plain `string`, so
  // the brand -- and with it the compiler's guarantee that nothing partner-chosen
  // entered the clause structure raw -- would be gone before the throw. Both
  // lists are non-empty by the early return above, so the seedless fold is total.
  const problem = problems.reduce(
    (left, right) => compatibilityMessage`${left} and ${right}`,
  );
  const remedy = remedies.reduce(
    (left, right) => compatibilityMessage`${left} ${right}`,
  );
  throw new UsageError(
    compatibilityMessage`payload.send must name exactly the columns this party's metadata discloses, but it ${problem}. ${remedy}`,
  );
}

/**
 * Reject a disclosed column whose NAME is longer than {@link MAX_NAME_LENGTH},
 * before any credential, terms, or data are sent.
 *
 * The name of a transmitted column is carried, not just used: it rides the
 * payload frame's `columns` list to the partner, whose parse refuses a
 * longer one, and it is written into this party's own exchange record, whose
 * `name` bound refuses it too. Metadata inferred from a CSV header
 * (`inferMetadata`) passes through no schema, so an oversized header reaches
 * here unbounded; without this check the partner's parse would be the first
 * enforcement, reached only after the frame has been sent.
 *
 * Scoped to the disclosed set ({@link overlongDisclosedColumnPositions}): a
 * column that is never sent carries its name nowhere.
 *
 * Gated on `output`, as {@link assertPayloadSendDisclosed} gates its empty
 * case: `runExchange` builds this party's payload only when the PARTNER is
 * entitled to the result, so with `output.shareWithPartner` false no column
 * leaves the machine and there is no carried name to bound.
 * `validateCompatibility` holds this party's `shareWithPartner` equal to the
 * partner's `expectsOutput`, so the transmission gate cannot disagree.
 *
 * The offending name is not echoed -- it broke a length bound, so it is
 * longer than a readable message -- the error names the input column
 * positions instead, as {@link inferMetadata}'s empty-name refusal does;
 * disclosedNameBound.test.ts holds the refusal to positions, never the name.
 *
 * @param output This party's own output declaration, from the same
 *   {@link LinkageTerms} the metadata is prepared against. Required so every
 *   call site states the direction.
 * @throws {UsageError} when a disclosed column's name exceeds
 *   {@link MAX_NAME_LENGTH} UTF-16 code units. A {@link UsageError} so the CLI
 *   classifies it as a configuration error (exit 64), not a transport failure.
 */
export function assertDisclosedNamesCarriable(
  metadata: Metadata,
  output: Output,
): void {
  if (!output.shareWithPartner) return;
  const positions = overlongDisclosedColumnPositions(metadata);
  if (positions.length === 0) return;
  const plural = positions.length > 1;
  throw new UsageError(
    `metadata column${plural ? "s" : ""} ${positions.join(", ")} ` +
      `(counted in the metadata's own order, which is the file's header order ` +
      `when the metadata was inferred) ` +
      `${plural ? "are" : "is"} sent to the partner, but ` +
      `${plural ? "their names are" : "its name is"} longer than the ` +
      `${MAX_NAME_LENGTH}-character limit on a column name (counted in UTF-16 ` +
      `code units, so a character outside the Basic Multilingual Plane counts as ` +
      `two). A payload column's name travels with its values: the partner's parse ` +
      `of the payload frame refuses a longer name, as does the exchange record ` +
      `this party writes, so the exchange could not complete. Shorten the ` +
      `column name${plural ? "s" : ""}, or set the metadata not to transmit ` +
      `${plural ? "them" : "it"} (is_payload: false or role ignored).`,
  );
}

/**
 * Refuse a received payload that names any column, for a party that receives
 * no payload: a count-only run, or a party whose terms entitle it to no
 * result. The send gate keeps a conforming partner from sending either one a
 * column, so this is the fail-closed safety check against one that does. An
 * empty received set passes.
 *
 * @throws {ConnectionError} of kind `"protocol"` when the received set names a
 *   column: the partner broke the agreed terms. The names are
 *   partner-controlled and interpolated raw, escaped once where the error is
 *   rendered -- and redacted of private-key material where they are
 *   composed, since the message states its cause behind them and the
 *   dangling-BEGIN rule reaches to the end of the rendered link.
 */
export function assertNoPayloadReceived(received: PartnerPayload): void {
  if (received.columns.length === 0) return;
  const gotShown = [...received.columns]
    .sort()
    .map(redactPrivateKeyMaterial)
    .join(", ");
  throw new ConnectionError(
    `payload disclosure mismatch: the partner transmitted columns ` +
      `[${gotShown}] but this party expected to receive no payload at all. ` +
      `The exchange is aborted because the payload received does not match what ` +
      `was consented to.`,
    "protocol",
  );
}

/**
 * Refuse a received payload whose column set differs from the partner's
 * agreed `payload.send`, for a party that receives payload: a column the
 * terms do not list, or a listed column left out. Compared as a sorted list
 * by exact name, so a repeated name is refused even beside every agreed one.
 * A run in which no partner row matched receives no payload frame data, so
 * an empty received set passes there.
 *
 * @throws {ConnectionError} of kind `"protocol"` when the two differ. The
 *   message names no column and no value; the terminated record still
 *   commits the payload as received, column names included.
 */
export function assertPayloadMatchesAgreedSend(
  received: PartnerPayload,
  agreedSend: ReadonlyArray<PayloadColumn> | undefined,
  partnerRowsMatched: number,
): void {
  if (received.columns.length === 0 && partnerRowsMatched === 0) return;
  const receivedNames = [...received.columns].sort();
  const agreedNames = (agreedSend ?? []).map(({ name }) => name).sort();
  if (
    receivedNames.length === agreedNames.length &&
    receivedNames.every((name, i) => name === agreedNames[i])
  )
    return;
  throw new ConnectionError(
    "payload disclosure mismatch: the columns the partner sent differ from " +
      "the columns the agreed linkage terms state it sends. The exchange is " +
      "aborted because the payload received does not match what was " +
      "consented to.",
    "protocol",
  );
}

function toPartnerPayload(msg: PayloadWireMessage): PartnerPayload {
  if (!msg.hasData) return { columns: [], rowIndices: [], rows: [] };
  return { columns: msg.columns, rowIndices: msg.rowIndices, rows: msg.rows };
}

/**
 * Map either payload representation -- the wire message this party sent, or
 * the {@link PartnerPayload} it received -- into the record's canonical
 * {@link CommittedPayload} form.
 *
 * Routing both sides through this one normalizer is what makes a sender's
 * `localPayloadSent` commitment and the receiver's `partnerPayloadReceived`
 * commitment cover byte-identical data for the same logical payload: the
 * transport-only `hasData` discriminant is dropped, and the no-data case
 * maps to empty arrays on both sides. The wire `rowIndices` are dropped too
 * -- the committed payload binds the column names and the row VALUES only,
 * not the sender's row numbers, so a receiver (which retains the received
 * values but not the partner's row numbers) can reopen its own
 * `partnerPayloadReceived` commitment from its retained result; the pairing
 * is bound separately by the association-table commitment (see
 * {@link CommittedPayload} and docs/spec/EXCHANGE_RECORD.md). The committed
 * shape is owned by the record module (`CommittedPayload`), not this
 * wire/transport layer; the explicit field-by-field construction here means
 * a future change to `PartnerPayload` or the wire schema cannot silently
 * alter the on-disk record format.
 */
export function toCommittedPayload(
  payload: PayloadWireMessage | PartnerPayload,
): CommittedPayload {
  if ("hasData" in payload && !payload.hasData)
    return { columns: [], rows: [] };
  return {
    columns: payload.columns,
    rows: payload.rows,
  };
}

/**
 * Exchanges payload datasets over an open {@link MessageConnection} after PSI
 * linkage.
 *
 * Initiator sends first; responder receives first then sends. The returned
 * {@link PartnerPayload} rows are in the SENDER's matched-row order, one per
 * distinct row it matched, and are joined to this party's association
 * entries by the row indices that ride with them ({@link buildOutputTable}).
 * Every failure mode (transport error, malformed message, send rejection)
 * surfaces as a rejection of the awaited call, so no listener registration,
 * error buffering, or per-path cleanup is needed.
 *
 * Each payload goes as a list of its rows, in parts
 * (docs/spec/PROTOCOL.md, A list of matched records is sent in parts), and
 * the partner's is refused at its first part when it declares more than
 * `maxPartnerRows` rows.
 *
 * `onLocalPayloadSent` is the step's partial progress, and the part of it a
 * caller cannot recover from a rejection: this party's payload crosses before
 * the initiator's receive, and the throw that follows carries no state saying
 * so. It runs once every part's send has RESOLVED -- the transport has taken
 * the frame (docs/COMMUNICATION.md) -- and also for a send rejected after an
 * earlier part was taken, or rejected as indeterminate, which the transport
 * can neither confirm nor retract, so a payload file may already be in the
 * partner's directory. It does not run for a first part rejected any other
 * way. A caller that owes a record of what it disclosed opens that obligation
 * there (docs/spec/EXCHANGE_RECORD.md, When a record is owed).
 *
 * The responder holds the partner's payload before its own send, and an
 * indeterminate rejection discards this function's return value, so its report
 * hands over what it received; the initiator, which sends first, has received
 * nothing to hand over.
 */
export async function exchangePayloads(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  localPayload: PayloadWireMessage,
  maxPartnerRows: number,
  onLocalPayloadSent?: (partnerPayload?: PartnerPayload) => void,
): Promise<PartnerPayload> {
  if (handshakeRole === "initiator") {
    await sendPayloadReportingHandOff(conn, localPayload, onLocalPayloadSent);
    return receivePayload(conn, maxPartnerRows);
  }
  const partnerPayload = await receivePayload(conn, maxPartnerRows);
  // This is the exchange's terminal frame on an unsigned run; on a signing
  // run the receipt swap follows it. On a buffering transport (WebRTC)
  // it looks racy: the responder's last act is a fire-and-forget send
  // (resolves on local hand-off, not peer delivery) right before the caller
  // tears the connection down. It is safe because the transport delivery
  // contract guarantees the final frame survives a clean close -- the send is
  // durable (file-sync writes the file before send resolves) and the clean
  // close drains it (waits for the peer to consume the last written file
  // before cleanup deletes it), or the clean close flushes buffered frames
  // before teardown (WebRTC). See the send/close contract in types.ts /
  // messageConnection.ts and docs/COMMUNICATION.md. Do not "fix" this by
  // assuming send has delivered.
  await sendPayloadReportingHandOff(conn, localPayload, (): void => {
    onLocalPayloadSent?.(partnerPayload);
  });
  return partnerPayload;
}

const PAYLOAD_WHAT = "payload";

// The payload message as a list of its rows: each part holds the columns and
// the rows and row indices of its slice, so a part is a payload message of its
// own and a list of one part is the whole message.
function payloadSource(payload: PayloadWireMessage): MatchedListSource {
  if (!payload.hasData)
    return { entries: 0, entryBytes: () => 0, body: () => payload };
  const { columns, rowIndices, rows } = payload;
  return {
    entries: rows.length,
    entryBytes: (index) =>
      utf8Length(String(rowIndices[index])) +
      utf8Length(JSON.stringify(rows[index])) +
      2,
    body: (start, end) => ({
      hasData: true,
      columns,
      rowIndices: rowIndices.slice(start, end),
      rows: rows.slice(start, end),
    }),
  };
}

// Receives the partner's payload parts, each a payload message of its own.
async function receivePayload(
  conn: MessageConnection,
  maxPartnerRows: number,
): Promise<PartnerPayload> {
  const participantId = "";
  const parts = parseMatchedListParts(
    await receiveMatchedListParts(
      conn,
      participantId,
      PAYLOAD_WHAT,
      maxPartnerRows,
    ),
    participantId,
    PAYLOAD_WHAT,
    (value) => {
      const part = parseOrProtocolError(payloadWireSchema, value);
      return { part, entries: part.hasData ? part.rows.length : 0 };
    },
  );
  return joinPayloadParts(parts);
}

// Joins the partner's parsed payload parts: every part after the first names
// the first part's columns, the row indices stay distinct across parts, and a
// list of several parts holds rows in every part.
/** @internal */
export function joinPayloadParts(
  parts: ReadonlyArray<PayloadWireMessage>,
): PartnerPayload {
  if (parts.length === 1) return toPartnerPayload(parts[0]);
  const joined: PartnerPayload = { columns: [], rowIndices: [], rows: [] };
  parts.forEach((part, index) => {
    if (!part.hasData)
      throw new ConnectionError(
        `protocol error: inbound ${PAYLOAD_WHAT} part ${index} holds no rows`,
        "protocol",
      );
    if (index === 0) joined.columns = part.columns;
    else if (
      part.columns.length !== joined.columns.length ||
      part.columns.some((column, i) => column !== joined.columns[i])
    )
      throw new ConnectionError(
        `protocol error: inbound ${PAYLOAD_WHAT} part ${index} names ` +
          "different columns than part 0",
        "protocol",
      );
    for (let i = 0; i < part.rows.length; i++) {
      joined.rowIndices.push(part.rowIndices[i]);
      joined.rows.push(part.rows[i]);
    }
  });
  if (!hasDistinctRowIndices(joined.rowIndices))
    throw new ConnectionError(
      `protocol error: inbound ${PAYLOAD_WHAT} repeats a row index across ` +
        "its parts",
      "protocol",
    );
  return joined;
}

/**
 * Send this party's payload in parts, reporting the send through `report` once
 * any part's send has resolved or a part's send was rejected as
 * indeterminate, and rethrowing every rejection unchanged.
 *
 * A part the transport took is a disclosure whatever becomes of the parts
 * after it, and an indeterminate rejection is a hand-off the transport could
 * neither confirm nor retract -- the part's file may already sit in the
 * partner's directory -- so either way the disclosure a record attests may
 * have occurred, and the report is what opens the caller's obligation to write
 * one (docs/spec/EXCHANGE_RECORD.md, When a record is owed). It stays a
 * rejection: the run fails, and the record its `outcome` marks as terminated
 * is the accounting entry for a disclosure that cannot be ruled out, never a
 * claim of delivery.
 */
async function sendPayloadReportingHandOff(
  conn: MessageConnection,
  localPayload: PayloadWireMessage,
  report: (() => void) | undefined,
): Promise<void> {
  let partSent = false;
  try {
    await sendMatchedList(conn, payloadSource(localPayload), () => {
      partSent = true;
    });
  } catch (error) {
    if (partSent || isTransportPublishIndeterminate(error)) report?.();
    throw error;
  }
  report?.();
}

// Quote a field the writer joins with `delimiter`: RFC 4180 escaping against
// the delimiter this file is actually written with, not against the comma
// alone, so a value holding the chosen delimiter stays one field when the file
// is read back through it.
function quoteCsvField(value: string, delimiter: string): string {
  return value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r")
    ? '"' + value.replace(/"/g, '""') + '"'
    : value;
}

// Pick a column name not already taken, starting from `base` and falling back to
// a prefixed (then numbered) variant. Every result header goes through here
// against the headers already assigned, so no two columns of the file share a
// name. The prefix is a collision fallback, not a whose-column label: it renames
// the column assigned LATER and leaves the earlier one's name intact, so a
// partner column literally named own_x or their_x keeps that name unless a
// later column collides with it.
function uniqueColumnName(
  base: string,
  taken: ReadonlySet<string>,
  prefix = "their_",
): string {
  if (!taken.has(base)) return base;
  const prefixed = `${prefix}${base}`;
  if (!taken.has(prefixed)) return prefixed;
  let n = 2;
  while (taken.has(`${prefixed}_${n}`)) n++;
  return `${prefixed}_${n}`;
}

/**
 * Formats an exchange result into header and row arrays suitable for CSV
 * output.
 *
 * One result row per association PAIR. Under a deduplicating cardinality a
 * row index repeats on one side of the table -- several of our records
 * against one of the partner's, or the reverse -- and each such pair is its
 * own result row: our identifier repeats down the column where the
 * multiplicity is ours, and one partner payload row is written against each
 * of our records where it is the partner's. The partner's payload holds
 * one row per distinct record IT matched ({@link distinctMatchedRows}), so
 * the join below addresses that row once per pair rather than expecting one
 * payload row per pair.
 *
 * The first column identifies our matched records, headed by our identifier
 * column name (or `row_id` when no identifier column exists). The second
 * holds the partner's 0-based row index for each matched record, headed
 * `row_id` (disambiguated to `their_row_id`, then `their_row_id_2`, ... on
 * collision). It is emitted in every result -- not only when the partner sent
 * no payload -- so the result stays self-sufficient for later verification:
 * it is the partner side of the association table the record's commitments
 * bind, and (once the payload commitment stopped binding the partner's row
 * indices) it is not otherwise recoverable from the payload values. Then come
 * the partner's payload columns, each using its original name. All values are
 * RFC 4180 escaped against `delimiter`, the field delimiter the caller joins
 * them with (comma by default): a value holding that delimiter, a double quote,
 * CR or LF is quoted and its own quotes doubled, so the file the caller writes
 * reads back through the same delimiter. Null cells in the
 * partner's payload are emitted as empty strings; a payload collection that
 * is not an array, a row that is not an array or whose width disagrees with
 * the declared columns, and a cell that is neither a string nor null, are
 * each refused.
 *
 * `includeOwnColumns` adds this party's own input columns after the
 * partner's, valued from the matched record each result row addresses and
 * repeating with it under a deduplicating cardinality. It selects them
 * rather than listing them ({@link ownResultColumnNames}); undefined adds
 * none, and the file is then the one the partner's values alone compose.
 * `undeclaredColumns` are the undeclared input columns `all` writes after
 * the declared ones, which `undeclaredColumnsForOwnResult` gives: every one
 * when the metadata is inferred, none for an authored metadata block.
 * These columns are local: no frame, consent display, or commitment holds
 * them, and the partner's own result is untouched by them.
 *
 * Every header is assigned against those already taken, so no two share a
 * name: our first column takes its name first, then the own columns keep
 * their input names, then each partner payload column takes its own name
 * unless something already holds it, and last the partner row-index column.
 * A name already taken falls back to a prefixed then numbered variant --
 * `their_` for one of the partner's columns, `own_` for one of ours.
 */
export function buildOutputTable(
  associationTable: AssociationTable,
  rawRows: Array<CSVRow>,
  metadata: Metadata,
  partnerPayload: PartnerPayload,
  includeOwnColumns?: OwnColumnSelection,
  undeclaredColumns: ReadonlyArray<string> = [],
  delimiter: string = DEFAULT_CSV_DELIMITER,
): { headers: string[]; rows: Array<Array<string>> } {
  // The escaping holds only against a single character: a caller that passed a
  // party's choice unresolved -- the reserved detect word above all -- would
  // quote every cell against a string no join could split back on.
  if (!isCsvDelimiter(delimiter))
    throw new InternalConsistencyError(
      "result delimiter is not a single accepted character: resolve the " +
        "party's choice through resultCsvDelimiter before building the table",
    );
  const quote = (value: string): string => quoteCsvField(value, delimiter);
  if (associationTable[0].length !== associationTable[1].length) {
    throw new InternalConsistencyError(
      "association table arrays have different lengths: " +
        `${associationTable[0].length} vs ${associationTable[1].length}`,
    );
  }

  // Each collection is held to being an array before anything is read from it, so
  // a caller past the type -- this is an exported entry point whose
  // PartnerPayload argument no type ties to a parsed frame -- gets the same shape
  // refusal the malformed rows below get rather than a TypeError from the first
  // array method that misses.
  for (const [field, collection] of [
    ["columns", partnerPayload.columns],
    ["rowIndices", partnerPayload.rowIndices],
    ["rows", partnerPayload.rows],
  ] as const) {
    if (!Array.isArray(collection)) {
      throw new ProtocolRefusalError(
        `partner payload ${field} is not an array: ` +
          "refusing to read entries from a value that holds none",
      );
    }
  }

  if (!partnerPayload.columns.every((column) => typeof column === "string")) {
    throw new ProtocolRefusalError(
      "a partner payload column name is not a string: " +
        "refusing to write a header of another shape into the result",
    );
  }

  if (partnerPayload.rowIndices.length !== partnerPayload.rows.length) {
    throw new ProtocolRefusalError(
      "partner payload rowIndices and rows have different lengths: " +
        `${partnerPayload.rowIndices.length} vs ${partnerPayload.rows.length}`,
    );
  }

  // One pass, refusing a row that is not a row and a cell that is not a cell. The
  // cell half is what keeps a value of another shape out of the CSV: quoteCsvField
  // looks for the characters RFC 4180 escapes with `includes`, which an ARRAY
  // answers by element rather than by substring, so an array cell holding a
  // separator reports none and would reach the result unquoted, breaking the row's
  // framing. isPayloadCell is the wire schema's own cell predicate.
  for (const row of partnerPayload.rows) {
    if (!Array.isArray(row)) {
      throw new ProtocolRefusalError(
        "a partner payload row is not an array of cells: " +
          "refusing to read cell values from a non-row value",
      );
    }
    if (!row.every(isPayloadCell)) {
      throw new ProtocolRefusalError(
        "a partner payload cell is neither a string nor null: " +
          "refusing to write a value of another shape into the result",
      );
    }
  }

  const columnCount = partnerPayload.columns.length;
  if (!hasOneCellPerColumn(columnCount, partnerPayload.rows)) {
    throw new ProtocolRefusalError(
      "partner payload rows do not have one cell per declared column: " +
        `expected ${columnCount} cell${columnCount === 1 ? "" : "s"} per row`,
    );
  }

  const ourIdCol = metadata.find((col) => col.role === "identifier") ?? null;

  const hasPartnerCols = partnerPayload.columns.length > 0;
  const ourBaseName = ourIdCol ? ourIdCol.name : "row_id";

  const ownColumns =
    includeOwnColumns === undefined
      ? []
      : ownResultColumnNames(metadata, includeOwnColumns, undeclaredColumns);

  // Our first column's name is taken before any other, then our own columns,
  // then the partner's payload columns, and the partner row-index column last:
  // a collision is resolved in favor of the column named earlier in that order.
  const taken = new Set([ourBaseName]);
  const ownHeaders = ownColumns.map((name) => {
    const header = uniqueColumnName(name, taken, "own_");
    taken.add(header);
    return header;
  });
  const valueHeaders = partnerPayload.columns.map((name) => {
    const header = uniqueColumnName(name, taken);
    taken.add(header);
    return header;
  });
  const partnerIndexHeader = uniqueColumnName("row_id", taken);

  const headers = [
    quote(ourBaseName),
    quote(partnerIndexHeader),
    ...valueHeaders.map(quote),
    ...ownHeaders.map(quote),
  ];

  const theirIdxToPayloadPos = new ShardedMap<number, number>();
  partnerPayload.rowIndices.forEach((rowIdx, pos) => {
    theirIdxToPayloadPos.setIfAbsent(rowIdx, pos);
  });

  // A repeated index is a MALFORMED payload -- a sender emitting a row it
  // should have sent once -- refused under every cardinality: the frame
  // names two payload rows for one of the sender's records without saying
  // which is the record's. Multiplicity is held on the association
  // table's side of the join, never here. The wire schema refuses the
  // repeat at parse, but this is an exported entry point taking a plain
  // PartnerPayload whose argument no type ties to a parsed frame, so the
  // invariant keeps a check of its own rather than resting on that call
  // path.
  if (theirIdxToPayloadPos.size !== partnerPayload.rowIndices.length) {
    throw new ProtocolRefusalError(
      "partner payload rowIndices contains duplicate indices",
    );
  }

  if (hasPartnerCols) {
    // Named once each: a partner row our table pairs with several of our records
    // is one missing payload row, not one per pair.
    const missingSeen = new ShardedMap<number, true>();
    const missing = associationTable[1].filter(
      (idx) =>
        theirIdxToPayloadPos.get(idx) === undefined &&
        missingSeen.setIfAbsent(idx, true) === undefined,
    );
    if (missing.length > 0) {
      throw new ProtocolRefusalError(
        "partner payload is missing rows for association table indices: " +
          missing.join(", "),
      );
    }
  }

  const rows = associationTable[0].map((ourIdx, i) => {
    const theirIdx = associationTable[1][i];
    const ourRow = rawRows[ourIdx];
    const ourIdValue =
      ourIdCol && ourRow ? readRowColumn(ourRow, ourIdCol.name) : undefined;
    const ourId = quote(ourIdValue ?? String(ourIdx));
    const partnerIndexCell = quote(String(theirIdx));
    // A column the matched row does not hold -- a short row in an
    // operator-local CSV -- writes an empty cell, as a null partner cell does.
    const ownValues = ownColumns.map((name) =>
      quote((ourRow ? readRowColumn(ourRow, name) : undefined) ?? ""),
    );

    if (!hasPartnerCols) {
      return [ourId, partnerIndexCell, ...ownValues];
    }

    const partnerRow = partnerPayload.rows[theirIdxToPayloadPos.get(theirIdx)!];
    const theirValues = partnerPayload.columns.map((_, colIdx) =>
      quote(partnerRow[colIdx] ?? ""),
    );

    return [ourId, partnerIndexCell, ...theirValues, ...ownValues];
  });

  return { headers, rows };
}
