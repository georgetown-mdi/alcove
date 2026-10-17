import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MockInstance } from "vitest";
import { MATCHED_KEY_COLUMN, prepareForExchange } from "@alcove/core";
import type { ExchangeSpec } from "@alcove/core";

import { buildCli } from "../../../src/cliParser";
import { saveConfig } from "../../../src/config";
import { saveKeyFile } from "../../../src/keyFile";
import { DEFAULT_RECORD_BASENAME } from "../../../src/recordFile";
import { captureProcessExit } from "../../exitCapture";

// `alcove exchange --include-matching-key`, and the configuration's
// `include_matching_key`, driven through the real yargs builder and handler on
// both parties over filedrop: either one reaches the run, the run's result
// names the key each pair matched on, and the partner's result is unchanged.
// Filedrop only, since nothing here depends on the channel.

const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PEER_TIMEOUT_SECONDS = 30;

const CSV_HEADER = "ssn,last_name,first_name,date_of_birth";
const CSV_FIELDS = ["ssn", "last_name", "first_name", "date_of_birth"];
// SMITH agrees on every field, so the pair is accepted on the first default
// key. JONES differs on date of birth alone, so the pair is accepted on a
// later key that leaves the date out.
const PARTY_A_CSV =
  `${CSV_HEADER}\n` +
  "531247869,SMITH,JOHN,19900115\n" +
  "234567890,JONES,MARY,19850623\n" +
  "345678901,BROWN,ROBERT,19920815\n";
const PARTY_B_CSV =
  `${CSV_HEADER}\n` +
  "531247869,SMITH,JOHN,19900115\n" +
  "234567890,JONES,MARY,19850624\n" +
  "456789012,WHITE,JAMES,19880520\n";
const PROVISION_ROWS = [
  {
    ssn: "123456789",
    last_name: "SMITH",
    first_name: "JOHN",
    date_of_birth: "19900115",
  },
];

let work: string;
let exitSpy: MockInstance<typeof process.exit> | undefined;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-matching-key-"));
  exitSpy = captureProcessExit();
});

afterEach(() => {
  exitSpy?.mockRestore();
  exitSpy = undefined;
  if (work) fs.rmSync(work, { recursive: true, force: true });
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

function provision(
  linkageStrategy: "cascade" | "single-pass" = "cascade",
  configAIncludesMatchingKey?: boolean,
) {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const inputA = path.join(work, "a-input.csv");
  const inputB = path.join(work, "b-input.csv");
  fs.writeFileSync(inputA, PARTY_A_CSV);
  fs.writeFileSync(inputB, PARTY_B_CSV);
  const prepared = prepareForExchange({}, "config", PROVISION_ROWS, CSV_FIELDS);
  const linkageTerms = { ...prepared.linkageTerms, linkageStrategy };
  const spec: ExchangeSpec = {
    connection: {
      channel: "filedrop",
      path: dropDir,
      options: { pollIntervalMs: 1 },
    },
    linkageTerms,
    metadata: prepared.metadata,
  };
  const configA = path.join(work, "a.yaml");
  const configB = path.join(work, "b.yaml");
  saveConfig(
    configA,
    configAIncludesMatchingKey === undefined
      ? spec
      : { ...spec, includeMatchingKey: configAIncludesMatchingKey },
  );
  saveConfig(configB, spec);
  const keyA = path.join(work, "a.key");
  const keyB = path.join(work, "b.key");
  saveKeyFile(keyA, { sharedSecret: INITIAL_SECRET });
  saveKeyFile(keyB, { sharedSecret: INITIAL_SECRET });
  return {
    inputA,
    inputB,
    configA,
    configB,
    keyA,
    keyB,
    keyNames: linkageTerms.linkageKeys.map((key) => key.name),
  };
}

function partyArgs(
  input: string,
  out: string,
  config: string,
  key: string,
  identity: string,
  extra: string[] = ["--no-record"],
): string[] {
  return [
    "exchange",
    input,
    out,
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
    ...extra,
  ];
}

function resultLines(dir: string): Array<Array<string>> {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("alcove-results-"));
  expect(files).toHaveLength(1);
  return fs
    .readFileSync(path.join(dir, files[0]), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split(","));
}

test.each([
  { askedThrough: "--include-matching-key", configKey: undefined },
  { askedThrough: "include_matching_key: true", configKey: true },
])(
  "the party that asks through $askedThrough is told the key each pair matched on",
  async ({ configKey }) => {
    const { inputA, inputB, configA, configB, keyA, keyB, keyNames } =
      provision("cascade", configKey);
    const outA = path.join(work, "out-a");
    const outB = path.join(work, "out-b");

    await runBoth(
      partyArgs(
        inputA,
        outA,
        configA,
        keyA,
        "party-a",
        configKey === true
          ? ["--no-record"]
          : ["--no-record", "--include-matching-key"],
      ),
      partyArgs(inputB, outB, configB, keyB, "party-b"),
    );

    const [headerA, ...rowsA] = resultLines(outA);
    expect(headerA[headerA.length - 1]).toBe(MATCHED_KEY_COLUMN);
    expect(rowsA.map((row) => row[row.length - 1])).toEqual([
      keyNames[0],
      "SSN + FN + LN",
    ]);
    // The key is the first default key for the exact match, and a later one,
    // leaving the date out, for the pair that differs on it.
    expect(keyNames[0]).toBe("SSN + LN + DOB");
    expect(keyNames).toContain("SSN + FN + LN");

    const [headerB, ...rowsB] = resultLines(outB);
    expect(headerB).not.toContain(MATCHED_KEY_COLUMN);
    expect(rowsB).toHaveLength(2);
    expect(headerB).toEqual(headerA.slice(0, headerB.length));
  },
  90_000,
);

test("--include-matching-key is refused on single-pass terms before the partner is contacted", async () => {
  const { inputA, configA, keyA } = provision("single-pass");
  const outA = path.join(work, "out-a");

  await expect(
    runCli(
      partyArgs(inputA, outA, configA, keyA, "party-a", [
        "--no-record",
        "--include-matching-key",
      ]),
    ),
  ).rejects.toThrow("exit:64");
  const drop = fs.readdirSync(work).find((name) => name.startsWith("drop-"));
  expect(fs.readdirSync(path.join(work, drop!))).toEqual([]);
}, 30_000);

test("--no-include-matching-key turns off the configuration's include_matching_key for the run", async () => {
  const { inputA, inputB, configA, configB, keyA, keyB } = provision(
    "cascade",
    true,
  );
  const outA = path.join(work, "out-a");
  const outB = path.join(work, "out-b");

  await runBoth(
    partyArgs(inputA, outA, configA, keyA, "party-a", [
      "--no-record",
      "--no-include-matching-key",
    ]),
    partyArgs(inputB, outB, configB, keyB, "party-b"),
  );

  const [headerA, ...rowsA] = resultLines(outA);
  expect(headerA).not.toContain(MATCHED_KEY_COLUMN);
  expect(rowsA).toHaveLength(2);
}, 90_000);

test("include_matching_key on single-pass terms is refused at the config load before the partner is contacted", async () => {
  const { inputA, configA, keyA } = provision("single-pass", true);
  const outA = path.join(work, "out-a");
  const stderr: string[] = [];
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
  try {
    await expect(
      runCli(
        partyArgs(inputA, outA, configA, keyA, "party-a").map((arg) =>
          arg === "silent" ? "error" : arg,
        ),
      ),
    ).rejects.toThrow("exit:64");
  } finally {
    stderrSpy.mockRestore();
  }
  expect(stderr.join("")).toContain(
    "include_matching_key is set on a single-pass exchange",
  );
  const drop = fs.readdirSync(work).find((name) => name.startsWith("drop-"));
  expect(fs.readdirSync(path.join(work, drop!))).toEqual([]);
}, 30_000);

test("a result holding the matching-key column still verifies against its record", async () => {
  const { inputA, inputB, configA, configB, keyA, keyB } = provision();
  const outA = path.join(work, "out-a");
  const outB = path.join(work, "out-b");

  await runBoth(
    partyArgs(inputA, outA, configA, keyA, "party-a", [
      "--include-matching-key",
    ]),
    partyArgs(inputB, outB, configB, keyB, "party-b"),
  );

  const record = fs
    .readdirSync(outA)
    .find(
      (name) =>
        name.startsWith(`${DEFAULT_RECORD_BASENAME}-`) &&
        name.endsWith(".json") &&
        !name.endsWith(".keys.json") &&
        !name.endsWith(".terms.json"),
    );
  const result = fs
    .readdirSync(outA)
    .find((name) => name.startsWith("alcove-results-"));
  expect(record).toBeDefined();
  expect(result).toBeDefined();
  expect(resultLines(outA)[0]).toContain(MATCHED_KEY_COLUMN);

  const lines: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map((part) => String(part)).join(" "));
    });
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let exitCode: typeof process.exitCode;
  try {
    await runCli([
      "verify-receipt",
      path.join(outA, record!),
      inputA,
      path.join(outA, result!),
      "--log-level",
      "silent",
    ]);
    exitCode = process.exitCode;
  } finally {
    process.exitCode = previousExitCode;
    logSpy.mockRestore();
  }
  expect(lines.join("\n")).toMatch(/^VERIFIED/);
  expect(exitCode).toBe(0);
}, 90_000);
