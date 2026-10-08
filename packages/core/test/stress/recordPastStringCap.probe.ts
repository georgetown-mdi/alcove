// One exchange record and both parties' receipt content built over a sent
// payload of one 30-character column whose commitment encoding is either just
// under V8's longest string ("under") or past it ("past"), and an empty
// received payload; then the record's commitments verified, and the encoding
// one row longer ("under") or the encoding itself ("past") checked to be
// refused as one string. "under" also checks the payload and association-table
// commitments and the payload's receipt MAC against the one-shot encoding.
// Run in its own process so it can raise its heap and its peak resident set
// is its own: `recordPastStringCap.stress.test.ts` spawns it and reads the one
// JSON line it prints.
//
// Usage: node --max-old-space-size=<MiB> --import tsx recordPastStringCap.probe.ts under|past

import { constants } from "node:buffer";
import { performance } from "node:perf_hooks";

import {
  buildExchangeRecord,
  verifyRecordCommitments,
} from "../../src/records/exchangeRecord";
import { buildReceiptContent } from "../../src/records/signedReceipt";
import { canonicalBytes, canonicalString } from "../../src/utils/canonical";
import {
  fromBase64Url,
  hkdfDerive,
  hmacSha256,
  randomBytes,
  toBase64Url,
} from "../../src/utils/crypto";

import type {
  CommittedPayload,
  ExchangeRecordInputs,
} from "../../src/records/exchangeRecord";
import type { LinkageTerms } from "../../src/config/linkageTermsSchema";

export type ProbeMode = "under" | "past";

export interface ProbeResult {
  readonly mode: ProbeMode;
  readonly rows: number;
  /** UTF-8 length of the sent-payload commitment's canonical encoding. */
  readonly commitmentEncodingBytes: number;
  readonly holds: boolean;
  /** Whether canonicalString refused the one-shot encoding ("under": one row more). */
  readonly oneShotRefused: boolean;
  /** "under" only: whether the commitments and the MAC equal the one-shot values. */
  readonly matchesOneShot?: boolean;
  readonly error?: string;
  readonly buildMs: number;
  readonly verifyMs: number;
  readonly receiptMs: number;
  readonly maxRssMiB: number;
}

const CELL_WIDTH = 30;
const PAST_ROWS = 2 ** 24 + 2048;
// The constructions in docs/spec/EXCHANGE_RECORD.md, restated so the one-shot
// values are computed apart from the code under test.
const PAYLOAD_SENT_DOMAIN = "alcove-commit-payload-sent/v2";
const ASSOCIATION_TABLE_DOMAIN = "alcove-commit-association-table/v2";
const RECEIPT_PAYLOAD_MAC_LABEL = "alcove-signed-receipt-payload-v2";

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

const cell = (row: number): string => String(row).padStart(CELL_WIDTH, "0");

const commitmentMessage = (payload: CommittedPayload) => ({
  domain: PAYLOAD_SENT_DOMAIN,
  data: payload,
});

// The commitment encoding of this shape is an empty payload's, plus one row's
// encoding and a separating comma per row, less the comma the first row lacks.
const emptyLength = canonicalString(
  commitmentMessage({ columns: ["id"], rows: [] }),
).length;
const perRowLength = canonicalString([cell(0)]).length + 1;
const encodingLength = (rows: number): number =>
  emptyLength + rows * perRowLength - 1;

function refusedAsOneString(value: unknown): boolean {
  try {
    canonicalString(value);
    return false;
  } catch (caught) {
    return /Invalid string length/.test((caught as Error).message);
  }
}

async function oneShotMac(
  key: Uint8Array<ArrayBuffer>,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  return toBase64Url(await hmacSha256(key, bytes));
}

const mode = process.argv[2] as ProbeMode;
if (mode !== "under" && mode !== "past") throw new Error("usage: under|past");
const rows =
  mode === "under"
    ? Math.floor((constants.MAX_STRING_LENGTH - emptyLength + 1) / perRowLength)
    : PAST_ROWS;

const payload: CommittedPayload = {
  columns: ["id"],
  rows: Array.from({ length: rows }, (_unused, row) => [cell(row)]),
};
const empty: CommittedPayload = { columns: [], rows: [] };
const own = Array.from({ length: rows }, (_unused, at) => at);
const partner = Array.from({ length: rows }, (_unused, at) => at >> 3);
const inputs: ExchangeRecordInputs = {
  localTerms: terms,
  partnerTerms: { ...terms, identity: "Party B", deduplicate: false },
  contributedLinkageFields: ["ssn"],
  outcome: "completed",
  certificateMismatchObserved: false,
  recordsExposed: rows,
  resultSize: rows,
  associationTable: [own, partner],
  localPayloadSent: payload,
  partnerPayloadReceived: empty,
  createdAt: "2026-10-07T00:00:00.000Z",
};

let holds = false;
let oneShotRefused = false;
let matchesOneShot: boolean | undefined;
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
  const sessionKey = randomBytes(32);
  start = performance.now();
  const initiator = await buildReceiptContent(
    "initiator",
    record.termsHash,
    payload,
    empty,
    "binder",
    sessionKey,
  );
  receiptMs = Math.round(performance.now() - start);
  const responder = await buildReceiptContent(
    "responder",
    record.termsHash,
    empty,
    payload,
    "binder",
    sessionKey,
  );
  holds =
    allValid &&
    JSON.stringify(initiator) === JSON.stringify(responder) &&
    initiator.initiatorToResponderPayload.length > 0;

  if (mode === "under") {
    const salts = keys.salts;
    const payloadBytes = canonicalBytes(commitmentMessage(payload));
    const payloadMatches =
      payloadBytes.length === encodingLength(rows) &&
      record.commitments.localPayloadSent ===
        (await oneShotMac(fromBase64Url(salts.localPayloadSent), payloadBytes));
    const tableMatches =
      record.commitments.associationTable ===
      (await oneShotMac(
        fromBase64Url(salts.associationTable ?? ""),
        canonicalBytes({
          domain: ASSOCIATION_TABLE_DOMAIN,
          data: [own, partner],
        }),
      ));
    const macKey = await hkdfDerive(
      sessionKey,
      `${RECEIPT_PAYLOAD_MAC_LABEL}:initiator-to-responder`,
      32,
    );
    const macMatches =
      initiator.initiatorToResponderPayload ===
      (await oneShotMac(macKey, canonicalBytes(payload)));
    matchesOneShot = payloadMatches && tableMatches && macMatches;
    payload.rows.push([cell(rows)]);
  }
  oneShotRefused = refusedAsOneString(commitmentMessage(payload));
} catch (caught) {
  const failure = caught as Error;
  error = `${failure.name}: ${failure.message}`;
}
const result: ProbeResult = {
  mode,
  rows,
  commitmentEncodingBytes: encodingLength(rows),
  holds,
  oneShotRefused,
  matchesOneShot,
  error,
  buildMs,
  verifyMs,
  receiptMs,
  maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
};
process.stdout.write(`${JSON.stringify(result)}\n`);
