import logLibrary from "loglevel";

import {
  operatorSuppliedText,
  redactAndRenderOperatorSuppliedText,
} from "@alcove/core";

/** Where this party's result went, as the output stage left it. */
export type ResultDelivery =
  | { kind: "file"; matchedRows: number; path: string }
  | { kind: "stdout"; matchedRows: number }
  | { kind: "count"; intersectionCount: number; reportedByPartner: boolean }
  | { kind: "withheld" };

/** What became of the exchange record this run was asked for. */
export type RecordDelivery =
  | { kind: "written"; path: string }
  | { kind: "disabled" }
  | { kind: "notWritten" };

/** The facts {@link describeExchangeOutcome} states, every path absolute. */
export interface ExchangeOutcomeFacts {
  result: ResultDelivery;
  record: RecordDelivery;
  /**
   * The key file the rotated shared secret was saved to, or `undefined` when
   * this run rotated none.
   */
  rotatedKeyFilePath: string | undefined;
}

const renderPath = (path: string): string =>
  redactAndRenderOperatorSuppliedText(operatorSuppliedText(path));

const records = (count: number): string =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "record" : "records"}`;

function resultClause(result: ResultDelivery): string {
  switch (result.kind) {
    case "file":
      return (
        `${records(result.matchedRows)} matched, result written to ` +
        renderPath(result.path)
      );
    case "stdout":
      return (
        `${records(result.matchedRows)} matched, result written to ` +
        "standard output"
      );
    case "count":
      // The sender seat's count arrived over the partner's count-report leg
      // rather than from a round it ran, so its line says whose figure it is
      // where the number is read, not only at consent time. The receiver seat
      // computed its own count, so the caveat would be false there.
      return result.reportedByPartner
        ? `your partner reported ${records(result.intersectionCount)} in ` +
            "common (only your partner computed this count; Alcove does not " +
            "check it against a run of its own), no result file (count only)"
        : `${records(result.intersectionCount)} in common, no result file ` +
            "(count only)";
    case "withheld":
      return "no result file for you under the agreed terms";
  }
}

function recordClause(record: RecordDelivery): string {
  switch (record.kind) {
    case "written":
      return `exchange record written to ${renderPath(record.path)}`;
    case "disabled":
      return "no exchange record (--no-record)";
    case "notWritten":
      return "exchange record not written";
  }
}

/**
 * The one line a completed exchange ends with: how many records matched, where
 * the result and the exchange record are, and whether the shared secret
 * rotated. Each path is the operator's own and is escaped for display here.
 */
export function describeExchangeOutcome(facts: ExchangeOutcomeFacts): string {
  const key =
    facts.rotatedKeyFilePath === undefined
      ? "no shared secret was rotated"
      : "shared secret rotated and saved to " +
        renderPath(facts.rotatedKeyFilePath);
  return (
    `exchange complete: ${resultClause(facts.result)}; ` +
    `${recordClause(facts.record)}; ${key}`
  );
}

/**
 * The warning a completed run logs when nothing matched, or `undefined` when
 * something did or this party received no result to count.
 */
export function zeroMatchWarning(result: ResultDelivery): string | undefined {
  const count =
    result.kind === "file" || result.kind === "stdout"
      ? result.matchedRows
      : result.kind === "count"
        ? result.intersectionCount
        : undefined;
  if (count !== 0) return undefined;
  return (
    "no records matched. If you expected matches, confirm with your partner " +
    "that you both used the same linkage keys and the intended input files."
  );
}

/**
 * The writer a command hands `runProtocol` for its outcome line: the
 * command's unfiltered `writePlainLine`, so the line reaches stderr or the
 * `--log-file` at every `--log-level` but `silent`, which writes nothing.
 */
export function outcomeLineWriter(
  log: { getLevel(): number },
  writePlainLine: (line: string) => void,
): (line: string) => void {
  return (line) => {
    if (log.getLevel() < logLibrary.levels.SILENT) writePlainLine(line);
  };
}
