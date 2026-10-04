// One exchange record and receipt build over a result of <pairs> matched
// pairs, run in its own process so it can raise its heap and its peak resident
// set is its own: `canonicalLargeArray.stress.test.ts` spawns it and reads the
// one JSON line it prints.
//
// Usage: node --max-old-space-size=<MiB> --import tsx exchangeRecordLarge.probe.ts <pairs>

import { performance } from "node:perf_hooks";

import {
  buildExchangeRecord,
  verifyRecordCommitments,
} from "../../src/records/exchangeRecord";
import { buildReceiptContent } from "../../src/records/signedReceipt";
import { randomBytes } from "../../src/utils/crypto";

import type {
  CommittedPayload,
  ExchangeRecordInputs,
} from "../../src/records/exchangeRecord";
import type { LinkageTerms } from "../../src/config/linkageTermsSchema";

export interface ProbeResult {
  readonly pairs: number;
  readonly holds: boolean;
  readonly error?: string;
  readonly buildMs: number;
  readonly verifyMs: number;
  readonly receiptMs: number;
  readonly maxRssMiB: number;
}

// Own records per partner record: the deduplicating side of the
// whole-exchange figures in docs/spec/PROTOCOL.md.
const RECORDS_PER_VALUE = 8;

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

const pairs = Number(process.argv[2]);
if (!Number.isSafeInteger(pairs) || pairs <= 0)
  throw new Error("usage: <pairs>");

const own = Array.from({ length: pairs }, (_unused, at) => at);
const partner = Array.from({ length: pairs }, (_unused, at) =>
  Math.floor(at / RECORDS_PER_VALUE),
);
const payload: CommittedPayload = {
  columns: ["id"],
  rows: Array.from({ length: pairs }, (_unused, at) => [String(at)]),
};
const empty: CommittedPayload = { columns: [], rows: [] };
const inputs: ExchangeRecordInputs = {
  localTerms: terms,
  partnerTerms: { ...terms, identity: "Party B", deduplicate: false },
  contributedLinkageFields: ["ssn"],
  outcome: "completed",
  certificateMismatchObserved: false,
  recordsExposed: pairs,
  resultSize: pairs,
  associationTable: [own, partner],
  localPayloadSent: payload,
  partnerPayloadReceived: empty,
  createdAt: "2026-10-04T00:00:00.000Z",
};

let holds = false;
let error: string | undefined;
let buildMs = 0;
let verifyMs = 0;
let receiptMs = 0;
try {
  let start = performance.now();
  const { record, keys } = await buildExchangeRecord(inputs);
  buildMs = Math.round(performance.now() - start);
  start = performance.now();
  const { allValid } = await verifyRecordCommitments(record, keys, {
    localPayloadSent: payload,
    partnerPayloadReceived: empty,
    associationTable: [own, partner],
  });
  verifyMs = Math.round(performance.now() - start);
  start = performance.now();
  const content = await buildReceiptContent(
    "initiator",
    record.termsHash,
    payload,
    empty,
    "binder",
    randomBytes(32),
  );
  receiptMs = Math.round(performance.now() - start);
  holds = allValid && content.initiatorToResponderPayload.length > 0;
} catch (caught) {
  const failure = caught as Error;
  error = `${failure.name}: ${failure.message}`;
}
const maxRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
const result: ProbeResult = {
  pairs,
  holds,
  error,
  buildMs,
  verifyMs,
  receiptMs,
  maxRssMiB,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
