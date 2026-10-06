import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MockInstance } from "vitest";
import { prepareForExchange } from "@alcove/core";
import type { ExchangeSpec } from "@alcove/core";

import { RECEIPT_VERIFICATION_FAILED_EXIT_CODE } from "@alcove/cli-contract";

import { buildCli } from "../../../src/cliParser";
import { RESULT_FROM_ANOTHER_RUN_HEADLINE } from "../../../src/commands/verifyReceipt";
import { saveConfig } from "../../../src/config";
import { saveKeyFile } from "../../../src/keyFile";
import {
  agreedTermsPathFor,
  DEFAULT_RECORD_BASENAME,
} from "../../../src/recordFile";
import { DEFAULT_RESULT_BASENAME } from "../../../src/resultFile";
import { captureProcessExit } from "../../exitCapture";

// A default (unsigned) exchange verified the way its operator would: the
// record, the input, and the result, with no other file. Two runs of the
// same partnership write two records and two results into one output folder,
// each pair under one stamp, so the first record checked against the second
// run's result is the mismatch an operator re-supplying the wrong file makes.
//
// filedrop only, like commandDefaultRecord.test.ts beside it: the record and
// agreed-terms writes are transport-agnostic.

const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PEER_TIMEOUT_SECONDS = 30;

const CSV_HEADER = "ssn,last_name,first_name,date_of_birth";
const CSV_FIELDS = ["ssn", "last_name", "first_name", "date_of_birth"];
const PARTY_A_CSV =
  `${CSV_HEADER}\n` +
  "123456789,SMITH,JOHN,19900115\n" +
  "234567890,JONES,MARY,19850623\n" +
  "345678901,BROWN,ROBERT,19920815\n";
// The second run's partner extract matches one more of party A's rows, so
// that run's result differs from the first's.
const PARTY_B_FIRST_CSV =
  `${CSV_HEADER}\n` +
  "123456789,SMITH,JOHN,19900115\n" +
  "234567890,JONES,MARY,19850623\n" +
  "456789012,WHITE,JAMES,19880520\n";
const PARTY_B_SECOND_CSV =
  PARTY_B_FIRST_CSV + "345678901,BROWN,ROBERT,19920815\n";

const PROVISION_ROWS = [
  {
    ssn: "123456789",
    last_name: "SMITH",
    first_name: "JOHN",
    date_of_birth: "19900115",
  },
];

let work: string;
let originalCwd: string;
let exitSpy: MockInstance<typeof process.exit> | undefined;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-verify-default-"));
  originalCwd = process.cwd();
  // The default record path is relative to cwd.
  process.chdir(work);
  exitSpy = captureProcessExit();
});

afterEach(() => {
  process.chdir(originalCwd);
  exitSpy?.mockRestore();
  exitSpy = undefined;
  try {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

async function runCli(argv: string[]): Promise<void> {
  await buildCli(argv).exitProcess(false).parseAsync();
}

async function runBoth(argvA: string[], argvB: string[]): Promise<void> {
  const results = await Promise.allSettled([runCli(argvA), runCli(argvB)]);
  const reasons = results
    .filter((r) => r.status === "rejected")
    .map((r) => (r as PromiseRejectedResult).reason);
  if (reasons.length === 1) throw reasons[0];
  if (reasons.length > 1)
    throw new AggregateError(reasons, "both parties failed");
}

// The verdict goes to stdout through console.log and its result to
// process.exitCode, both read here and restored.
async function verify(
  args: string[],
): Promise<{ stdout: string; exitCode: typeof process.exitCode }> {
  const lines: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map((part) => String(part)).join(" "));
    });
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runCli(["verify-receipt", ...args, "--log-level", "silent"]);
    return { stdout: lines.join("\n"), exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExitCode;
    logSpy.mockRestore();
  }
}

// The records party A wrote, oldest first: the stamp in each default name is
// an ISO timestamp, which sorts in time order.
function recordsIn(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter(
      (name) =>
        name.startsWith(`${DEFAULT_RECORD_BASENAME}-`) &&
        name.endsWith(".json") &&
        !name.endsWith(".keys.json") &&
        !name.endsWith(".terms.json"),
    )
    .sort()
    .map((name) => path.join(dir, name));
}

test("a default exchange's record verifies from the record, input, and result alone", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const inputA = path.join(work, "a-input.csv");
  fs.writeFileSync(inputA, PARTY_A_CSV);
  const inputB = path.join(work, "b-input.csv");
  fs.writeFileSync(inputB, PARTY_B_FIRST_CSV);
  const outA = path.join(work, "a-out");
  const outB = path.join(work, "b-out");

  const prepared = prepareForExchange({}, "config", PROVISION_ROWS, CSV_FIELDS);
  const spec: ExchangeSpec = {
    connection: {
      channel: "filedrop",
      path: dropDir,
      options: { pollIntervalMs: 1 },
    },
    linkageTerms: prepared.linkageTerms,
    metadata: prepared.metadata,
  };
  const configA = path.join(work, "a.yaml");
  const configB = path.join(work, "b.yaml");
  saveConfig(configA, spec);
  saveConfig(configB, spec);
  const keyA = path.join(work, "a.key");
  const keyB = path.join(work, "b.key");
  saveKeyFile(keyA, { sharedSecret: INITIAL_SECRET });
  saveKeyFile(keyB, { sharedSecret: INITIAL_SECRET });

  const exchangeA = [
    "exchange",
    inputA,
    outA,
    "--config-file",
    configA,
    "--key-file",
    keyA,
    "--identity",
    "party-a",
    "--peer-timeout",
    `${PEER_TIMEOUT_SECONDS}s`,
    "--log-level",
    "silent",
  ];
  const exchangeB = [
    "exchange",
    inputB,
    outB,
    "--config-file",
    configB,
    "--key-file",
    keyB,
    "--identity",
    "party-b",
    "--no-record",
    "--peer-timeout",
    `${PEER_TIMEOUT_SECONDS}s`,
    "--log-level",
    "silent",
  ];

  await runBoth(exchangeA, exchangeB);
  // A later run of the same partnership writes a second record and a second
  // result beside the first.
  fs.writeFileSync(inputB, PARTY_B_SECOND_CSV);
  await runBoth(exchangeA, exchangeB);

  expect(recordsIn(work)).toEqual([]);
  const [firstRecord, secondRecord] = recordsIn(outA);
  expect(recordsIn(outA)).toHaveLength(2);
  const [firstResult, secondResult] = [firstRecord, secondRecord].map(
    (record) =>
      path.join(
        outA,
        path
          .basename(record)
          .replace(`${DEFAULT_RECORD_BASENAME}-`, `${DEFAULT_RESULT_BASENAME}-`)
          .replace(/\.json$/, ".csv"),
      ),
  );
  const termsFile = agreedTermsPathFor(firstRecord);
  expect(fs.existsSync(termsFile)).toBe(true);
  if (process.platform !== "win32")
    expect(fs.statSync(termsFile).mode & 0o077).toBe(0);
  expect(fs.readFileSync(secondResult, "utf8")).not.toBe(
    fs.readFileSync(firstResult, "utf8"),
  );

  const own = await verify([firstRecord, inputA, firstResult]);
  expect(own.stdout).toMatch(/^VERIFIED/);
  expect(own.stdout).toContain("agreed-terms hash: re-derives and matches");
  expect(own.exitCode).toBe(0);

  const later = await verify([secondRecord, inputA, secondResult]);
  expect(later.stdout).toMatch(/^VERIFIED/);
  expect(later.exitCode).toBe(0);

  const overwritten = await verify([firstRecord, inputA, secondResult]);
  expect(overwritten.stdout.split("\n")[0]).toBe(
    RESULT_FROM_ANOTHER_RUN_HEADLINE,
  );
  expect(overwritten.stdout).toContain(
    "agreed-terms hash: re-derives and matches",
  );
  expect(overwritten.exitCode).toBe(RECEIPT_VERIFICATION_FAILED_EXIT_CODE);
}, 120_000);

test("a folder output names each run's result after its record, and each record verifies against its own", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const inputA = path.join(work, "a-input.csv");
  fs.writeFileSync(inputA, PARTY_A_CSV);
  const inputB = path.join(work, "b-input.csv");
  fs.writeFileSync(inputB, PARTY_B_FIRST_CSV);
  const outB = path.join(work, "b-out");

  const prepared = prepareForExchange({}, "config", PROVISION_ROWS, CSV_FIELDS);
  const spec: ExchangeSpec = {
    connection: {
      channel: "filedrop",
      path: dropDir,
      options: { pollIntervalMs: 1 },
    },
    linkageTerms: prepared.linkageTerms,
    metadata: prepared.metadata,
  };
  const configA = path.join(work, "a.yaml");
  const configB = path.join(work, "b.yaml");
  saveConfig(configA, spec);
  saveConfig(configB, spec);
  const keyA = path.join(work, "a.key");
  const keyB = path.join(work, "b.key");
  saveKeyFile(keyA, { sharedSecret: INITIAL_SECRET });
  saveKeyFile(keyB, { sharedSecret: INITIAL_SECRET });

  const exchangeA = [
    "exchange",
    inputA,
    "./",
    "--config-file",
    configA,
    "--key-file",
    keyA,
    "--identity",
    "party-a",
    "--peer-timeout",
    `${PEER_TIMEOUT_SECONDS}s`,
    "--log-level",
    "silent",
  ];
  const exchangeB = [
    "exchange",
    inputB,
    outB,
    "--config-file",
    configB,
    "--key-file",
    keyB,
    "--identity",
    "party-b",
    "--no-record",
    "--peer-timeout",
    `${PEER_TIMEOUT_SECONDS}s`,
    "--log-level",
    "silent",
  ];

  await runBoth(exchangeA, exchangeB);
  fs.writeFileSync(inputB, PARTY_B_SECOND_CSV);
  await runBoth(exchangeA, exchangeB);

  const records = recordsIn(work);
  expect(records).toHaveLength(2);
  const results = records.map((record) =>
    path.join(
      work,
      path
        .basename(record)
        .replace(`${DEFAULT_RECORD_BASENAME}-`, `${DEFAULT_RESULT_BASENAME}-`)
        .replace(/\.json$/, ".csv"),
    ),
  );
  for (const result of results) {
    expect(fs.existsSync(result)).toBe(true);
    if (process.platform !== "win32")
      expect(fs.statSync(result).mode & 0o077).toBe(0);
  }
  expect(fs.readFileSync(results[0], "utf8")).not.toBe(
    fs.readFileSync(results[1], "utf8"),
  );

  for (const [index, record] of records.entries()) {
    const verdict = await verify([record, inputA, results[index]]);
    expect(verdict.stdout).toMatch(/^VERIFIED/);
    expect(verdict.exitCode).toBe(0);
  }
}, 120_000);
