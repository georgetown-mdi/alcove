import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test } from "vitest";
import type { MockInstance } from "vitest";
import { getDefaultLinkageTerms, inferMetadata } from "@alcove/core";
import type { ExchangeSpec } from "@alcove/core";

import { buildCli } from "../../../src/cliParser";
import { saveConfig } from "../../../src/config";
import { saveKeyFile } from "../../../src/keyFile";
import { DEFAULT_RECORD_BASENAME } from "../../../src/recordFile";
import { DEFAULT_RESULT_BASENAME } from "../../../src/resultFile";
import { captureProcessExit } from "../../exitCapture";
import { captureStdio } from "../../loggingTestSupport";

// What crosses on a quick exchange against a recurring one, driven end to end
// over a filedrop rendezvous: the quick exchange sends every column of the
// sender's file that is not a linkage key, its id columns included, while a
// configuration with no metadata block sends only what inference recognizes.
// Both parties run the real parser and handler in this process.

const PEER_TIMEOUT_SECONDS = 30;

const SENDER_CSV =
  "ssn,last_name,first_name,date_of_birth,dob,program_code,case_id,household_id\n" +
  "123456789,SMITH,JOHN,19900115,19900115,A1,c-1,h-1\n" +
  "234567890,JONES,MARY,19850623,19850623,B2,c-2,h-2\n" +
  "345678901,BROWN,ROBERT,19920815,19920815,C3,c-3,h-3\n";
const RECEIVER_CSV =
  "ssn,last_name,first_name,date_of_birth\n" +
  "123456789,SMITH,JOHN,19900115\n" +
  "234567890,JONES,MARY,19850623\n" +
  "456789012,WHITE,JAMES,19880520\n";

const LINKAGE_KEY_COLUMNS = ["ssn", "last_name", "first_name", "date_of_birth"];

const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let work: string;
let originalCwd: string;
let exitSpy: MockInstance<typeof process.exit> | undefined;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-quick-columns-"));
  originalCwd = process.cwd();
  process.chdir(work);
  exitSpy = captureProcessExit();
});

afterEach(() => {
  process.chdir(originalCwd);
  exitSpy?.mockRestore();
  exitSpy = undefined;
  fs.rmSync(work, { recursive: true, force: true });
});

async function runCli(argv: string[]): Promise<void> {
  await buildCli(argv).exitProcess(false).fail(false).parseAsync();
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

function onlyFile(dir: string, prefix: string, suffix: string): string {
  const matches = fs
    .readdirSync(dir)
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        name.endsWith(suffix) &&
        !name.endsWith(".keys.json") &&
        !name.endsWith(".terms.json"),
    );
  if (matches.length !== 1)
    throw new Error(
      `expected one ${prefix}*${suffix} in ${dir}, found ${matches.length}`,
    );
  return path.join(dir, matches[0]);
}

function resultHeader(dir: string): Array<string> {
  const result = onlyFile(dir, `${DEFAULT_RESULT_BASENAME}-`, ".csv");
  return fs.readFileSync(result, "utf8").split(/\r?\n/)[0].split(",");
}

function recordPayloadNames(
  dir: string,
  direction: "payloadSent" | "payloadReceived",
): Array<string> {
  const record = JSON.parse(
    fs.readFileSync(
      onlyFile(dir, `${DEFAULT_RECORD_BASENAME}-`, ".json"),
      "utf8",
    ),
  ) as { governance: Record<string, Array<{ name: string }>> };
  return record.governance[direction].map((entry) => entry.name);
}

const commonFlags = [
  "--polling-frequency",
  "100ms",
  "--peer-timeout",
  `${PEER_TIMEOUT_SECONDS}s`,
  "--log-level",
  "silent",
];

test("a quick exchange sends every column that is not a linkage key, and no linkage key", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const url = pathToFileURL(dropDir).href;
  const senderInput = path.join(work, "sender.csv");
  fs.writeFileSync(senderInput, SENDER_CSV);
  const receiverInput = path.join(work, "receiver.csv");
  fs.writeFileSync(receiverInput, RECEIVER_CSV);
  const senderOut = path.join(work, "sender-out");
  const receiverOut = path.join(work, "receiver-out");

  const stdio = captureStdio();
  try {
    await runBoth(
      [url, senderInput, senderOut, "--identity", "sender", ...commonFlags],
      [
        url,
        receiverInput,
        receiverOut,
        "--identity",
        "receiver",
        ...commonFlags,
      ],
    );
  } finally {
    stdio.restore();
  }

  // dob is a second date-of-birth column, so it is not sent, and the keys read
  // the first; the sender's display names it, and the receiver has none.
  const shown = stdio.stderrWrites.join("");
  expect(shown).toContain("\n  held back (enforced): dob\n");
  expect(shown.match(/held back/g)).toHaveLength(1);

  const sent = ["program_code", "case_id", "household_id"];
  expect(recordPayloadNames(senderOut, "payloadSent")).toEqual(sent);
  expect(recordPayloadNames(receiverOut, "payloadReceived")).toEqual(sent);
  const header = resultHeader(receiverOut);
  for (const column of sent) expect(header).toContain(column);
  for (const column of LINKAGE_KEY_COLUMNS)
    expect(header).not.toContain(column);
}, 90_000);

test("a recurring exchange with no metadata block withholds the columns inference does not recognize", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const senderInput = path.join(work, "sender.csv");
  fs.writeFileSync(senderInput, SENDER_CSV);
  const receiverInput = path.join(work, "receiver.csv");
  fs.writeFileSync(receiverInput, RECEIVER_CSV);
  const senderOut = path.join(work, "sender-out");
  const receiverOut = path.join(work, "receiver-out");

  // No metadata block in either configuration, so each run infers its own.
  // The linkage terms are the shared default over the linkage columns.
  const linkageTerms = getDefaultLinkageTerms(
    "config",
    inferMetadata(LINKAGE_KEY_COLUMNS, []),
  );
  const spec: ExchangeSpec = {
    connection: {
      channel: "filedrop",
      path: dropDir,
      options: { pollIntervalMs: 1 },
    },
    linkageTerms,
  };
  const senderConfig = path.join(work, "sender.yaml");
  const receiverConfig = path.join(work, "receiver.yaml");
  saveConfig(senderConfig, spec);
  saveConfig(receiverConfig, spec);
  const senderKey = path.join(work, "sender.key");
  const receiverKey = path.join(work, "receiver.key");
  saveKeyFile(senderKey, { sharedSecret: INITIAL_SECRET });
  saveKeyFile(receiverKey, { sharedSecret: INITIAL_SECRET });

  const exchangeArgs = (
    config: string,
    key: string,
    input: string,
    out: string,
    identity: string,
  ) => [
    "exchange",
    "--config-file",
    config,
    "--key-file",
    key,
    "--identity",
    identity,
    "--peer-timeout",
    `${PEER_TIMEOUT_SECONDS}s`,
    "--log-level",
    "silent",
    input,
    out,
  ];
  await runBoth(
    exchangeArgs(senderConfig, senderKey, senderInput, senderOut, "sender"),
    exchangeArgs(
      receiverConfig,
      receiverKey,
      receiverInput,
      receiverOut,
      "receiver",
    ),
  );

  expect(recordPayloadNames(senderOut, "payloadSent")).toEqual([]);
  expect(recordPayloadNames(receiverOut, "payloadReceived")).toEqual([]);
  const header = resultHeader(receiverOut);
  for (const column of ["program_code", "case_id", "household_id"])
    expect(header).not.toContain(column);
}, 90_000);
