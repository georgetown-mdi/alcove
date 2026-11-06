// Holds docs/COMPLIANCE.md's AU-12 row: a whole exchange, run at the most
// verbose log level, writes no record value to any logger. It covers the
// paths this run drives -- terms, PSI matching, payload exchange and receipt
// signing over an in-memory pipe -- and no other: an error path, a transport's
// own logging, and the applications' loggers are outside it.

import { inspect } from "node:util";

import PSI from "@openmined/psi.js";
import logLibrary from "loglevel";
import { afterEach, beforeEach, expect, test } from "vitest";

import { prepareForExchange, runExchange } from "../src/exchange";
import { createMessagePipe } from "../src/connection/messageConnection";
import { payloadRow, payloadRowCount } from "../src/payloadExchange";
import { generateSigningIdentity } from "../src/records/signingIdentity";
import {
  getDiagnosticSink,
  getLogger,
  setDiagnosticSink,
  setLogLevel,
} from "../src/utils/logger";

import type { Metadata } from "../src/config/metadata";
import type { ExchangeResult, RunExchangeOptions } from "../src/exchange";

const psiLibrary = await PSI();

const TERMS = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "cascade" as const,
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [
    { name: "last_name", type: "last_name" as const },
    { name: "first_name", type: "first_name" as const },
  ],
  linkageKeys: [
    {
      name: "full name",
      elements: [{ field: "last_name" }, { field: "first_name" }],
    },
    { name: "last name", elements: [{ field: "last_name" }] },
  ],
};

const METADATA: Metadata = [
  {
    name: "person_id",
    type: "identifier",
    role: "identifier",
    isPayload: true,
  },
  { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "note", type: "other", role: "payload", isPayload: true },
];

const COLUMNS = ["person_id", "last_name", "first_name", "note"];

// Every cell is a value no log line could hold by coincidence. Matched rows
// (both name keys), a row matched on the second key only, and unmatched rows
// on each side, so each phase handles some of them.
const initiatorRows = [
  {
    person_id: "ipid-qorvantel",
    last_name: "Brindlewick",
    first_name: "Ottoline",
    note: "inote-marrowgate",
  },
  {
    person_id: "ipid-saffrelund",
    last_name: "Quenneville",
    first_name: "Thaddeus",
    note: "inote-pellucidar",
  },
  {
    person_id: "ipid-wendholm",
    last_name: "Zarathine",
    first_name: "Isembard",
    note: "inote-cobblestoke",
  },
];

const responderRows = [
  {
    person_id: "rpid-halvergate",
    last_name: "Brindlewick",
    first_name: "Ottoline",
    note: "rnote-tamberlune",
  },
  {
    person_id: "rpid-orrinshaw",
    last_name: "Quenneville",
    first_name: "Philippa",
    note: "rnote-gossamerly",
  },
  {
    person_id: "rpid-kestrelmoor",
    last_name: "Vantongeren",
    first_name: "Leocadia",
    note: "rnote-umberfield",
  },
];

const RECORD_VALUES = [...initiatorRows, ...responderRows].flatMap((row) =>
  Object.values(row),
);

const initiatorIdentity = await generateSigningIdentity("Initiator Co");
const responderIdentity = await generateSigningIdentity("Responder Co");
const sessionKey = new Uint8Array(32).fill(9) as Uint8Array<ArrayBuffer>;

interface LogLine {
  level: string;
  text: string;
}

let lines: LogLine[] = [];
let previousLevel: logLibrary.LogLevelNumbers;
let previousSink: ReturnType<typeof getDiagnosticSink>;

beforeEach(() => {
  lines = [];
  previousLevel = logLibrary.getLevel();
  previousSink = getDiagnosticSink();
  setLogLevel("trace");
  setDiagnosticSink((methodName, prefix, args) => {
    const rendered = args.map((arg) =>
      typeof arg === "string" ? arg : inspect(arg, { depth: Infinity }),
    );
    lines.push({ level: methodName, text: [prefix, ...rendered].join(" ") });
  });
});

afterEach(() => {
  setDiagnosticSink(previousSink);
  setLogLevel(previousLevel);
});

/**
 * The record values a log line holds, matched without regard to case, since
 * standardization may change a value's case before it is logged.
 */
function recordValuesLogged(logged: LogLine[]): string[] {
  return RECORD_VALUES.filter((value) =>
    logged.some((line) =>
      line.text.toLowerCase().includes(value.toLowerCase()),
    ),
  );
}

async function runBothParties(
  extra: Partial<RunExchangeOptions> = {},
): Promise<[ExchangeResult, ExchangeResult]> {
  const [initiatorConn, responderConn] = createMessagePipe();
  const prepare = (identity: string, rows: typeof initiatorRows) =>
    prepareForExchange(
      { metadata: METADATA, linkageTerms: { ...TERMS, identity } },
      identity,
      rows,
      COLUMNS,
    );
  return Promise.all([
    runExchange(
      initiatorConn,
      "initiator",
      prepare("Initiator Co", initiatorRows),
      {
        psiLibrary,
        verbosity: 2,
        signingIdentity: initiatorIdentity,
        sessionKey,
        ...extra,
      },
    ),
    runExchange(
      responderConn,
      "responder",
      prepare("Responder Co", responderRows),
      {
        psiLibrary,
        verbosity: 2,
        signingIdentity: responderIdentity,
        sessionKey,
      },
    ),
  ]);
}

test("a whole exchange at trace level logs no record value", async () => {
  const [initiator, responder] = await runBothParties();

  // The run matched and exchanged payload, so every phase ran with record
  // values in hand, and the capture saw the verbose levels it is checking.
  expect(initiator.associationTable?.[0]).toHaveLength(2);
  expect(initiator.signedReceipt).toBeDefined();
  expect(responder.signedReceipt).toBeDefined();
  const received = responder.partnerPayload;
  expect(
    Array.from({ length: payloadRowCount(received.rows) }, (_, index) =>
      payloadRow(received.rows, index),
    ).flat(),
  ).toContain("inote-marrowgate");
  expect(lines.some((line) => line.level === "debug")).toBe(true);

  expect(recordValuesLogged(lines)).toEqual([]);
});

test("a log call given a record value during the run fails the check", async () => {
  await runBothParties({
    onStage: () => {
      getLogger("exchange").debug("stage reached for", initiatorRows[1]);
    },
  });

  expect(recordValuesLogged(lines)).toEqual(
    expect.arrayContaining(["ipid-saffrelund", "Quenneville", "Thaddeus"]),
  );
});
