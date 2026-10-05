// One exchange record built and then verified from a re-supplied input of
// <rows> rows, each matched once, as the deduplicating side of the
// whole-exchange figures in docs/spec/PROTOCOL.md: first through the input's
// identifier column, then with the result's first column as the row index.
// Run in its own process so it can raise its heap and its peak resident set is
// its own: `verifyReceiptLarge.stress.test.ts` spawns it and reads the one
// JSON line it prints.
//
// Usage: node --max-old-space-size=<MiB> --import tsx verifyReceiptLarge.probe.ts <rows>

import { performance } from "node:perf_hooks";

import { buildExchangeRecord } from "../../src/records/exchangeRecord";
import {
  reconstructCommittedData,
  verifyExchangeRecord,
} from "../../src/records/recordVerification";

import type { CommittedPayload } from "../../src/records/exchangeRecord";
import type { LinkageTerms } from "../../src/config/linkageTermsSchema";
import type { CSVRow } from "../../src/file";
import type {
  RecordVerificationOutcome,
  RetainedResult,
} from "../../src/records/recordVerification";

export interface ProbeResult {
  readonly rows: number;
  readonly byIdentifier?: RecordVerificationOutcome;
  readonly byRowIndex?: RecordVerificationOutcome;
  readonly warnings: number;
  readonly error?: string;
  readonly buildMs: number;
  readonly byIdentifierMs: number;
  readonly byRowIndexMs: number;
  readonly maxRssMiB: number;
}

const RECORDS_PER_VALUE = 8;
// Nine decimal digits, the shape of a cleaned SSN.
const FIRST_IDENTIFIER = 100_000_000;

const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: true,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};
const partnerTerms: LinkageTerms = {
  ...terms,
  identity: "Party B",
  deduplicate: false,
};

const rows = Number(process.argv[2]);
if (!Number.isSafeInteger(rows) || rows <= 0) throw new Error("usage: <rows>");

const identifiers = Array.from({ length: rows }, (_unused, at) =>
  String(FIRST_IDENTIFIER + at),
);
const inputRows: CSVRow[] = identifiers.map((pid) => ({ pid }));
const own = Array.from({ length: rows }, (_unused, at) => at);
const partner = own.map((at) => Math.floor(at / RECORDS_PER_VALUE));
const empty: CommittedPayload = { columns: [], rows: [] };

let byIdentifier: RecordVerificationOutcome | undefined;
let byRowIndex: RecordVerificationOutcome | undefined;
let warnings = 0;
let error: string | undefined;
let buildMs = 0;
let byIdentifierMs = 0;
let byRowIndexMs = 0;
try {
  let start = performance.now();
  const { record, keys } = await buildExchangeRecord({
    localTerms: terms,
    partnerTerms,
    contributedLinkageFields: ["ssn"],
    outcome: "completed",
    certificateMismatchObserved: false,
    recordsExposed: rows,
    resultSize: rows,
    associationTable: [own, partner],
    localPayloadSent: {
      columns: ["pid"],
      rows: identifiers.map((pid) => [pid]),
    },
    partnerPayloadReceived: empty,
    createdAt: "2026-10-04T00:00:00.000Z",
  });
  buildMs = Math.round(performance.now() - start);

  const result: RetainedResult = {
    headers: ["pid", "row_id"],
    rows: identifiers.map((pid, at) => [pid, String(partner[at])]),
  };
  const verify = async (ourIdColumn: string | undefined) => {
    const reconstructed = reconstructCommittedData({
      record,
      inputRows,
      result,
      ourIdColumn,
    });
    warnings += reconstructed.warnings.length;
    const report = await verifyExchangeRecord(record, keys, {
      data: reconstructed.data,
      localTerms: terms,
      partnerTerms,
    });
    return report.outcome;
  };

  start = performance.now();
  byIdentifier = await verify("pid");
  byIdentifierMs = Math.round(performance.now() - start);

  result.headers[0] = "row_id";
  result.rows.forEach((row, at) => {
    row[0] = String(at);
  });
  start = performance.now();
  byRowIndex = await verify(undefined);
  byRowIndexMs = Math.round(performance.now() - start);
} catch (caught) {
  const failure = caught as Error;
  error = `${failure.name}: ${failure.message}`;
}
const maxRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
const result: ProbeResult = {
  rows,
  byIdentifier,
  byRowIndex,
  warnings,
  error,
  buildMs,
  byIdentifierMs,
  byRowIndexMs,
  maxRssMiB,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
