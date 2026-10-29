import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MockInstance } from "vitest";
import YAML from "yaml";
import { DEFAULT_LINKAGE_RULE_SET } from "@alcove/core";

import { buildCli } from "../../../src/cliParser";
import { saveKeyFile } from "../../../src/keyFile";
import { DEFAULT_RECORD_BASENAME } from "../../../src/recordFile";
import { DEFAULT_RESULT_BASENAME } from "../../../src/resultFile";
import { captureProcessExit } from "../../exitCapture";

// Configurations `alcove init INPUT_FILE` wrote hold the built-in rule set's
// lists at the 95% floor, narrowed to that file. Two such configurations
// exchange, as written and with the 95% keys deleted to run only the 99%
// rules, and verify-receipt given the configuration re-derives the terms
// the run agreed on, so the record verifies.
//
// filedrop only, like verifyReceiptDefaultExchange.test.ts beside it.

const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PEER_TIMEOUT_SECONDS = 30;

const CSV_HEADER = "ssn,last_name,first_name,date_of_birth";
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

let work: string;
let originalCwd: string;
let exitSpy: MockInstance<typeof process.exit> | undefined;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-verify-init-"));
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

/** The names of the shipped keys in the 95% band. */
function keysAt95(): Set<string> {
  return new Set(
    (DEFAULT_LINKAGE_RULE_SET.ruleBands ?? [])
      .filter((band) => band.band === 95)
      .map((band) => band.rule),
  );
}

/**
 * Write the configuration `alcove init` writes for `input` at `configPath`,
 * then poll fast, and with `only99` delete its 95% keys as the template's
 * help says. Returns the key names the file holds.
 */
async function initConfig(
  configPath: string,
  identity: string,
  dropDir: string,
  input: string,
  only99: boolean,
): Promise<string[]> {
  await runCli([
    "init",
    pathToFileURL(dropDir).href,
    input,
    "--identity",
    identity,
    "--config-file",
    configPath,
    "--log-level",
    "silent",
  ]);
  const doc = YAML.parseDocument(fs.readFileSync(configPath, "utf8"));
  doc.setIn(["connection", "options", "poll_interval_ms"], 1);
  const keys = doc.getIn(["linkage_terms", "linkage_keys"]) as YAML.YAMLSeq<
    YAML.YAMLMap<string, unknown>
  >;
  if (only99) {
    const at95 = keysAt95();
    keys.items = keys.items.filter((key) => !at95.has(String(key.get("name"))));
  }
  fs.writeFileSync(configPath, doc.toString());
  return keys.items.map((key) => String(key.get("name")));
}

describe("verify-receipt of a run from configurations alcove init wrote", () => {
  test.each([{ only99: false }, { only99: true }] as const)(
    "with only the 99% rules $only99",
    async ({ only99 }) => {
      const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
      const inputA = path.join(work, "a-input.csv");
      fs.writeFileSync(inputA, PARTY_A_CSV);
      const inputB = path.join(work, "b-input.csv");
      fs.writeFileSync(inputB, PARTY_B_CSV);
      const outA = path.join(work, "a-out");
      const outB = path.join(work, "b-out");
      const configA = path.join(work, "a.yaml");
      const configB = path.join(work, "b.yaml");
      const keyNames = await initConfig(
        configA,
        "party-a",
        dropDir,
        inputA,
        only99,
      );
      await initConfig(configB, "party-b", dropDir, inputB, only99);
      const at95 = keysAt95();
      expect(keyNames.some((name) => at95.has(name))).toBe(!only99);
      expect(keyNames).toContain("SSN + LN + DOB");
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
    },
    120_000,
  );
});
