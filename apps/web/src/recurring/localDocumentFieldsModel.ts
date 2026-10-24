/**
 * The pure model behind the stored exchange's editor for the five settings of
 * its document that are this party's alone -- which of its own columns its
 * result file holds (`includeOwnColumns`), whether that file names the key
 * each match was made on (`includeMatchingKey`), how its input file separates
 * fields (`csvDelimiter`), the retention note filed with its exchange record
 * (`retentionDisposition`), and the relays its runs may use (a webrtc
 * connection's `allowedRelays`): what each control starts on for a stored
 * document, what a save writes, and what re-reading the input file under a
 * changed delimiter found. No React and no I/O.
 *
 * None of the five is a term: nothing about them is sent to the partner or
 * folded into the agreed-terms hash, so each edits in place on a stored record
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Local settings of the document").
 */

import { DEFAULT_CSV_DELIMITER, selectRunRelay } from "@alcove/core";

import {
  CSV_DELIMITER_OPTIONS,
  CSV_DELIMITER_OTHER,
  INITIAL_CSV_DELIMITER_CHOICE,
  resolveCsvDelimiter,
} from "@components/csvDelimiterChoice";
import {
  allowedRelayLinesError,
  allowedRelaysText,
  parseExchangeAllowedRelayLines,
} from "@psi/transport/relayRestriction";
import { assessManagedInputColumns } from "@psi/managed/managedInputGuard";
import { managedAllowedRelays } from "@psi/managed/managedExchangeRecord";
import { matchingKeyWithheldReason } from "@psi/matchingKeyModel";
import { ownColumnsActionable } from "@psi/ownColumnsModel";
import { retentionNoteValue } from "@exchange/manageOfferModel";

import type { ExchangeSpec, MatchingKeyUnavailableReason } from "@alcove/core";
import type { CsvDelimiterChoice } from "@components/csvDelimiterChoice";
import type { ManagedExchangeLocalEdits } from "@psi/managed/managedExchangeRecord";
import type { OwnColumnsChoice } from "@psi/ownColumnsModel";

/** The five controls' values as the operator has them. */
export interface LocalDocumentFieldValues {
  ownColumns: OwnColumnsChoice;
  /** Whether the result file ends with the `matched_on_key` column. */
  matchingKey: boolean;
  delimiter: CsvDelimiterChoice;
  /** The retention note as typed. */
  retentionNote: string;
  /** The allowed relays as typed, one per line. */
  allowedRelays: string;
  /** Whether a save removes the stored allowed relays, empty list included. */
  removeAllowedRelays: boolean;
}

/** The edits a save of the five controls writes. */
export type LocalDocumentFieldEdits = Pick<
  ManagedExchangeLocalEdits,
  | "includeOwnColumns"
  | "includeMatchingKey"
  | "csvDelimiter"
  | "retentionDisposition"
  | "allowedRelays"
>;

/**
 * The delimiter choice that shows a stored `csvDelimiter`: the named option
 * where the value is one, "Other" holding the value where it is not, and the
 * comma a document without the field is read by.
 */
export function csvDelimiterChoiceFrom(
  stored: string | undefined,
): CsvDelimiterChoice {
  if (stored === undefined) return INITIAL_CSV_DELIMITER_CHOICE;
  const named = CSV_DELIMITER_OPTIONS.some(
    (option) => option.value !== CSV_DELIMITER_OTHER && option.value === stored,
  );
  return named
    ? { option: stored, other: "" }
    : { option: CSV_DELIMITER_OTHER, other: stored };
}

/** What each control starts on for a stored document: the values it holds. */
export function localDocumentFieldValuesFrom(
  exchangeFile: ExchangeSpec,
): LocalDocumentFieldValues {
  return {
    ownColumns: exchangeFile.includeOwnColumns ?? "none",
    matchingKey: exchangeFile.includeMatchingKey === true,
    delimiter: csvDelimiterChoiceFrom(exchangeFile.csvDelimiter),
    retentionNote: exchangeFile.retentionDisposition ?? "",
    allowedRelays: allowedRelaysText(managedAllowedRelays(exchangeFile)),
    removeAllowedRelays: false,
  };
}

/**
 * Whether the Allowed relays control is offered for a document: only on a
 * webrtc connection, the one channel with relays. Where it is not offered, a
 * save leaves the connection as it is.
 */
export function allowedRelaysOffered(exchangeFile: ExchangeSpec): boolean {
  return exchangeFile.connection.channel === "webrtc";
}

/**
 * Whether the page shows the Allowed relays control for a document it is
 * offered for: where the document holds a list, an empty one included, where
 * the field's `text`, the list as typed, is not empty or the field was
 * `edited`, Remove included, so its line's action can take focus after Remove
 * empties it, or where `runsListRelay`, its runs listing a relay for the list
 * to keep or leave out. Hiding it leaves the document's list as it is.
 */
export function allowedRelaysShown(
  exchangeFile: ExchangeSpec,
  { text, edited }: { text: string; edited: boolean },
  runsListRelay: boolean,
): boolean {
  return (
    allowedRelaysOffered(exchangeFile) &&
    (allowedRelaysRemovable(exchangeFile) ||
      text !== "" ||
      edited ||
      runsListRelay)
  );
}

/**
 * Whether a command-line run of a document lists a TURN or WebSocket relay
 * url for its allowed relays to keep or leave out: its connection's own
 * `turn` and `websocket_relay`, and its `invitation_relay`'s
 * (`selectRunRelay` in core).
 */
export function commandLineRunListsRelay(exchangeFile: ExchangeSpec): boolean {
  const connection = exchangeFile.connection;
  if (connection.channel !== "webrtc") return false;
  const selection = selectRunRelay(connection);
  const listed = [
    ...(selection.turn ?? []),
    ...(selection.turnLeftOut ?? []),
    ...(selection.websocket ?? []),
    ...(selection.websocketLeftOut ?? []),
  ];
  return listed.length > 0;
}

/**
 * Whether a document's allowed relays are an empty list, under which its runs
 * keep no TURN url ({@link NO_ALLOWED_RELAY_NOTE}).
 */
export function allowsNoRelay(exchangeFile: ExchangeSpec): boolean {
  return managedAllowedRelays(exchangeFile)?.length === 0;
}

/**
 * Whether a document holds allowed relays, an empty list included, so the
 * control that removes them is offered.
 */
export function allowedRelaysRemovable(exchangeFile: ExchangeSpec): boolean {
  return managedAllowedRelays(exchangeFile) !== undefined;
}

/**
 * The allowed-relays values for the remove control set to `remove`: the field
 * emptied while removing, which a document without a list shows, and the
 * stored list again once the control is cleared.
 */
export function removeAllowedRelaysValues(
  exchangeFile: ExchangeSpec,
  remove: boolean,
): Pick<LocalDocumentFieldValues, "allowedRelays" | "removeAllowedRelays"> {
  return {
    allowedRelays: remove
      ? ""
      : allowedRelaysText(managedAllowedRelays(exchangeFile)),
    removeAllowedRelays: remove,
  };
}

/**
 * The field error the allowed relays as typed show, or `undefined` where they
 * can be saved. Core's entry rule only, with no bound on how many or how long
 * ({@link parseExchangeAllowedRelayLines}).
 */
export function allowedRelaysError(text: string): string | undefined {
  return allowedRelayLinesError(parseExchangeAllowedRelayLines(text));
}

function sameEntries(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string> | undefined,
): boolean {
  return (
    b !== undefined &&
    a.length === b.length &&
    a.every((entry, index) => entry === b[index])
  );
}

/**
 * What a save writes for the allowed relays: `null` where the remove control
 * is set over a stored list; otherwise, for the text as typed, nothing where
 * it is the stored list's or reads as the same entries, the entries where they
 * differ, and `null` where the field is emptied of a list that names relays.
 * An empty stored list shows as an empty field, so an empty field keeps it.
 */
function allowedRelaysEdit(
  exchangeFile: ExchangeSpec,
  values: Pick<
    LocalDocumentFieldValues,
    "allowedRelays" | "removeAllowedRelays"
  >,
): ReadonlyArray<string> | null | undefined {
  const stored = managedAllowedRelays(exchangeFile);
  if (values.removeAllowedRelays && stored !== undefined) return null;
  const text = values.allowedRelays;
  if (text === allowedRelaysText(stored)) return undefined;
  const lines = parseExchangeAllowedRelayLines(text);
  if (!lines.ok) return undefined;
  if (lines.entries === undefined)
    return stored !== undefined && stored.length > 0 ? null : undefined;
  return sameEntries(lines.entries, stored) ? undefined : lines.entries;
}

/**
 * Why the matched-key control is shown disabled for a document, or `undefined`
 * where it can be changed: its terms leave this party no key to name
 * ({@link matchingKeyWithheldReason}). Where it is withheld, a save leaves the
 * stored value as it is.
 */
export function matchingKeyWithheld(
  exchangeFile: ExchangeSpec,
): MatchingKeyUnavailableReason | undefined {
  return matchingKeyWithheldReason(exchangeFile.linkageTerms);
}

/**
 * Whether the own-columns control is offered for a document: only where its
 * terms write this party a result file for the choice to act on, the rule
 * setup applies ({@link ownColumnsActionable}). Where it is not offered, a save
 * leaves the stored value as it is.
 */
export function ownColumnsOffered(exchangeFile: ExchangeSpec): boolean {
  return ownColumnsActionable(exchangeFile.linkageTerms);
}

/**
 * The delimiter the stored document is read by: its `csvDelimiter`, or the
 * comma where it holds none.
 */
export function storedCsvDelimiter(exchangeFile: ExchangeSpec): string {
  return exchangeFile.csvDelimiter ?? DEFAULT_CSV_DELIMITER;
}

/**
 * The delimiter a changed choice resolves to, or `undefined` where the choice
 * is unchanged from the stored document or refused. The editor re-reads the
 * input file only for a delimiter this returns.
 */
export function changedCsvDelimiter(
  exchangeFile: ExchangeSpec,
  choice: CsvDelimiterChoice,
): string | undefined {
  const resolution = resolveCsvDelimiter(choice);
  if (!resolution.ok) return undefined;
  return resolution.delimiter === storedCsvDelimiter(exchangeFile)
    ? undefined
    : resolution.delimiter;
}

/**
 * What a save writes for the five controls: an edit for each value that
 * differs from the stored document, and nothing for one that does not, so a
 * save that changed only the label leaves the document as it was imported. A
 * `null` drops the field: "Nothing of mine" for the own-columns choice, an
 * unchecked matched-key box, an empty retention note, and allowed relays
 * emptied or removed. A refused delimiter or allowed relay writes nothing; the
 * editor blocks the save on it.
 */
export function localDocumentFieldEdits(
  exchangeFile: ExchangeSpec,
  values: LocalDocumentFieldValues,
): LocalDocumentFieldEdits {
  const edits: LocalDocumentFieldEdits = {};
  if (
    ownColumnsOffered(exchangeFile) &&
    values.ownColumns !== (exchangeFile.includeOwnColumns ?? "none")
  )
    edits.includeOwnColumns =
      values.ownColumns === "none" ? null : values.ownColumns;
  if (
    matchingKeyWithheld(exchangeFile) === undefined &&
    values.matchingKey !== (exchangeFile.includeMatchingKey === true)
  )
    edits.includeMatchingKey = values.matchingKey ? true : null;
  const delimiter = changedCsvDelimiter(exchangeFile, values.delimiter);
  if (delimiter !== undefined) edits.csvDelimiter = delimiter;
  if (values.retentionNote !== (exchangeFile.retentionDisposition ?? ""))
    edits.retentionDisposition =
      retentionNoteValue(values.retentionNote) ?? null;
  if (allowedRelaysOffered(exchangeFile)) {
    const allowedRelays = allowedRelaysEdit(exchangeFile, values);
    if (allowedRelays !== undefined) edits.allowedRelays = allowedRelays;
  }
  return edits;
}

/**
 * What re-reading the stored input file under a changed delimiter found:
 *
 * - `reading` -- the read is under way; the save waits for it.
 * - `fits` -- the file reads into columns that cover every agreed key.
 * - `short` -- the file reads, but its columns do not cover every agreed key;
 *   `singleColumn` where it read as one column, the shape of a file separated
 *   by some other character.
 * - `unreadable` -- this browser could not read the file without asking for
 *   permission, or the file is missing or does not parse.
 */
export type DelimiterRecheck =
  | { kind: "reading" }
  | { kind: "fits"; columnCount: number }
  | { kind: "short"; singleColumn: boolean }
  | { kind: "unreadable" };

/** Grade the columns a re-read found against the document's agreed terms, the
 * grade every run applies before it connects ({@link assessManagedInputColumns}). */
export function delimiterRecheckFrom(
  exchangeFile: ExchangeSpec,
  columns: ReadonlyArray<string>,
): DelimiterRecheck {
  const rejection = assessManagedInputColumns(exchangeFile, columns);
  if (rejection === undefined)
    return { kind: "fits", columnCount: columns.length };
  return {
    kind: "short",
    singleColumn: rejection.reason === "columns" && rejection.singleColumn,
  };
}

/** What the editor states about a re-read, or `undefined` while it runs. */
export function delimiterRecheckNote(
  recheck: DelimiterRecheck,
): { tone: "ok" | "warning"; message: string } | undefined {
  switch (recheck.kind) {
    case "reading":
      return undefined;
    case "fits":
      return {
        tone: "ok",
        message:
          `Your input file reads as ${recheck.columnCount} ` +
          (recheck.columnCount === 1 ? "column" : "columns") +
          " with this separator, covering every agreed key.",
      };
    case "short":
      return {
        tone: "warning",
        message: recheck.singleColumn
          ? "Your input file reads as a single column with this separator, " +
            "so its fields are likely separated by another character. " +
            "Choose your file's separator, or Detect to take it from the file."
          : "Your input file reads with this separator, but its columns do " +
            "not cover every agreed key, so a run would be refused before it " +
            "connects. Check that this is your file's separator.",
      };
    case "unreadable":
      return {
        tone: "warning",
        message:
          "This browser could not read your input file to check it with " +
          "this separator. The next run reads it this way; check that this " +
          "is your file's separator.",
      };
  }
}
