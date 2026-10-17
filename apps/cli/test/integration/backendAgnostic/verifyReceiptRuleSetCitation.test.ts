import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MockInstance } from "vitest";
import YAML from "yaml";
import {
  DEFAULT_LINKAGE_RULE_SET,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@alcove/core";

import { buildCli } from "../../../src/cliParser";
import { saveKeyFile } from "../../../src/keyFile";
import { DEFAULT_RECORD_BASENAME } from "../../../src/recordFile";
import { DEFAULT_RESULT_BASENAME } from "../../../src/resultFile";
import { captureProcessExit } from "../../exitCapture";

// A configuration that names the built-in rule set and writes no rules runs
// the keys its precision floor selects, narrowed by its metadata block or,
// with none, by the input's header. verify-receipt given that configuration
// and the input re-derives the same terms, so the record verifies.
//
// filedrop only, like verifyReceiptDefaultExchange.test.ts beside it.

const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PEER_TIMEOUT_SECONDS = 30;

const CSV_FIELDS = ["ssn", "last_name", "first_name", "date_of_birth"];
const CSV_HEADER = CSV_FIELDS.join(",");
const PARTY_A_CSV =
  `${CSV_HEADER}\n` +
  "123456789,SMITH,JOHN,19900115\n" +
  "234567890,JONES,MARY,19850623\n" +
  "345678901,BROWN,ROBERT,19920815\n";
const PARTY_B_CSV =
  `${CSV_HEADER}\n` +
  "123456789,SMITH,JOHN,19900115\n" +
  "234567890,JONES,MARY,19850623\n" +
  "456789012,WHITE,JAMES,19880520\n";
// The same people with no SSN column: under a header-narrowed configuration
// it selects other keys, so it is not the input the record's run read.
const OTHER_INPUT_CSV =
  "last_name,first_name,date_of_birth\n" +
  "SMITH,JOHN,19900115\n" +
  "JONES,MARY,19850623\n" +
  "BROWN,ROBERT,19920815\n";

let work: string;
let originalCwd: string;
let exitSpy: MockInstance<typeof process.exit> | undefined;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-verify-rule-set-"));
  originalCwd = process.cwd();
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

/** A configuration naming the built-in set at `floor`, writing no rules. */
function writeRuleSetConfig(
  configPath: string,
  identity: string,
  dropDir: string,
  floor: 95 | 99,
  withMetadata: boolean,
): void {
  const {
    linkageFields: _fields,
    linkageKeys: _keys,
    linkageRuleSet: _ruleSet,
    ...rest
  } = getDefaultLinkageTerms(identity);
  fs.writeFileSync(
    configPath,
    YAML.stringify({
      connection: {
        channel: "filedrop",
        path: dropDir,
        options: { poll_interval_ms: 1 },
      },
      linkage_terms: {
        ...rest,
        linkageRuleSet: DEFAULT_LINKAGE_RULE_SET.reference,
        precision_floor: floor,
      },
      ...(withMetadata ? { metadata: inferMetadata(CSV_FIELDS, []) } : {}),
    }),
  );
}

describe("verify-receipt of a run from a configuration naming the rule set", () => {
  test.each([
    { floor: 95, withMetadata: false },
    { floor: 99, withMetadata: false },
    { floor: 95, withMetadata: true },
    { floor: 99, withMetadata: true },
  ] as const)(
    "at the $floor% floor, metadata block $withMetadata",
    async ({ floor, withMetadata }) => {
      const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
      const inputA = path.join(work, "a-input.csv");
      fs.writeFileSync(inputA, PARTY_A_CSV);
      const inputB = path.join(work, "b-input.csv");
      fs.writeFileSync(inputB, PARTY_B_CSV);
      const otherInput = path.join(work, "other-input.csv");
      fs.writeFileSync(otherInput, OTHER_INPUT_CSV);
      const outA = path.join(work, "a-out");
      const outB = path.join(work, "b-out");
      const configA = path.join(work, "a.yaml");
      const configB = path.join(work, "b.yaml");
      writeRuleSetConfig(configA, "party-a", dropDir, floor, withMetadata);
      writeRuleSetConfig(configB, "party-b", dropDir, floor, withMetadata);
      const keyA = path.join(work, "a.key");
      const keyB = path.join(work, "b.key");
      saveKeyFile(keyA, { sharedSecret: INITIAL_SECRET });
      saveKeyFile(keyB, { sharedSecret: INITIAL_SECRET });

      const exchange = (
        input: string,
        out: string,
        config: string,
        key: string,
        extra: string[],
      ) => [
        "exchange",
        input,
        out,
        "--config-file",
        config,
        "--key-file",
        key,
        ...extra,
        "--peer-timeout",
        `${PEER_TIMEOUT_SECONDS}s`,
        "--log-level",
        "silent",
      ];
      await runBoth(
        exchange(inputA, outA, configA, keyA, []),
        exchange(inputB, outB, configB, keyB, ["--no-record"]),
      );

      const records = fs
        .readdirSync(outA)
        .filter(
          (name) =>
            name.startsWith(`${DEFAULT_RECORD_BASENAME}-`) &&
            name.endsWith(".json") &&
            !name.endsWith(".keys.json") &&
            !name.endsWith(".terms.json"),
        );
      expect(records).toHaveLength(1);
      const record = path.join(outA, records[0]!);
      const result = path.join(
        outA,
        records[0]!
          .replace(`${DEFAULT_RECORD_BASENAME}-`, `${DEFAULT_RESULT_BASENAME}-`)
          .replace(/\.json$/, ".csv"),
      );

      const own = await verify([
        record,
        inputA,
        result,
        "--config-file",
        configA,
      ]);
      expect(own.stdout).toMatch(/^VERIFIED/);
      expect(own.stdout).toContain("agreed-terms hash: re-derives and matches");
      expect(own.exitCode).toBe(0);

      // Only a header-narrowed configuration derives its keys from the input,
      // so only there does another header re-derive other terms.
      if (withMetadata) return;
      const other = await verify([
        record,
        otherInput,
        result,
        "--config-file",
        configA,
      ]);
      expect(other.stdout).not.toMatch(/^VERIFIED/);
      expect(other.stdout).toContain("agreed-terms hash: DOES NOT MATCH");
      expect(other.exitCode).not.toBe(0);
    },
    120_000,
  );
});
