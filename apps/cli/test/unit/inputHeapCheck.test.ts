import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { UsageError } from "@alcove/core";

import {
  checkInputFitsMainThreadHeap,
  countCsvRecords,
  inputHeapShortfallMessage,
  MAIN_THREAD_HEAP_BYTES_PER_RECORD,
  mainThreadHeapNeedBytes,
} from "../../src/inputHeapCheck";
import { loadInputRows } from "../../src/onlineBootstrap";
import { PSI_HEAP_CEILING_MIB } from "../../src/psiMemoryBudget";

// The main thread's heap limit as the check reads it, when a test sets one.
const heapLimit = vi.hoisted(() => ({
  bytes: undefined as number | undefined,
}));
vi.mock("node:v8", async (importActual) => {
  const actual = await importActual<typeof import("node:v8")>();
  const getHeapStatistics = (): ReturnType<typeof actual.getHeapStatistics> => {
    const statistics = actual.getHeapStatistics();
    return heapLimit.bytes === undefined
      ? statistics
      : { ...statistics, heap_size_limit: heapLimit.bytes };
  };
  return {
    ...actual,
    default: { ...actual, getHeapStatistics },
    getHeapStatistics,
  };
});

let scratch: string | undefined;
afterEach(() => {
  if (scratch !== undefined) fs.rmSync(scratch, { recursive: true });
  scratch = undefined;
});

function writeCsv(body: string): string {
  scratch ??= fs.mkdtempSync(path.join(os.tmpdir(), "alcove-input-heap-"));
  const file = path.join(scratch, `input-${body.length}.csv`);
  fs.writeFileSync(file, body);
  return file;
}

function rows(count: number): string {
  let body = "id,ssn\n";
  for (let i = 0; i < count; i++) body += `${i},123-45-${1000 + i}\n`;
  return body;
}

describe("counting records", () => {
  it("counts the lines after the header, with or without a final newline", async () => {
    expect(await countCsvRecords(writeCsv(rows(3)))).toBe(3);
    expect(await countCsvRecords(writeCsv(rows(3).trimEnd()))).toBe(3);
    expect(await countCsvRecords(writeCsv("id,ssn\n"))).toBe(0);
    expect(await countCsvRecords(writeCsv(""))).toBe(0);
  });
});

describe("the main thread's heap check", () => {
  // A heap that admits exactly ten records.
  const tenRecordHeap = mainThreadHeapNeedBytes(10);

  it("admits an input at the records the heap holds", async () => {
    await expect(
      checkInputFitsMainThreadHeap(writeCsv(rows(10)), tenRecordHeap),
    ).resolves.toBeUndefined();
  });

  it("refuses an input one record over, as a usage error naming the input's size, the limit and the NODE_OPTIONS line", async () => {
    const file = writeCsv(rows(11));
    const outcome = await checkInputFitsMainThreadHeap(
      file,
      tenRecordHeap,
    ).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(UsageError);
    expect((outcome as Error).message).toBe(
      inputHeapShortfallMessage({
        records: 11,
        fileBytes: fs.statSync(file).size,
        heapLimitBytes: tenRecordHeap,
      }),
    );
  });

  it("does not read stdin or a path it cannot stat", async () => {
    await expect(checkInputFitsMainThreadHeap("-", 0)).resolves.toBeUndefined();
    await expect(
      checkInputFitsMainThreadHeap(path.join(os.tmpdir(), "no-such.csv"), 0),
    ).resolves.toBeUndefined();
  });

  it("states the records, the file's size, the need, the limit and the setting", () => {
    expect(
      inputHeapShortfallMessage({
        records: 7_000_000,
        fileBytes: 256_609_852,
        heapLimitBytes: 4_395_630_592,
      }),
    ).toBe(
      `the CSV input holds 7,000,000 records (256.6 MB), and reading and ` +
        `preparing them needs about ` +
        `${((7_000_000 * MAIN_THREAD_HEAP_BYTES_PER_RECORD) / 1e9).toFixed(2)} GB ` +
        `of heap, more than this process's limit of 4.40 GB. Set ` +
        `NODE_OPTIONS=--max-old-space-size=${PSI_HEAP_CEILING_MIB} in the ` +
        `environment and run the command again.`,
    );
  });

  it("suggests more than the ceiling for an input that needs more", () => {
    const records = Math.ceil(
      (PSI_HEAP_CEILING_MIB * 2 ** 20 * 2) / MAIN_THREAD_HEAP_BYTES_PER_RECORD,
    );
    const needMiB = Math.ceil(mainThreadHeapNeedBytes(records) / 2 ** 20);
    expect(
      inputHeapShortfallMessage({
        records,
        fileBytes: 1,
        heapLimitBytes: 1,
      }),
    ).toContain(`NODE_OPTIONS=--max-old-space-size=${needMiB} in`);
  });

  it("admits fewer records at the measured default heap than the largest input measured to complete there", () => {
    // docs/spec/FILE_SYNC.md, "The main thread's heap": 6,500,000 records
    // completed at a heap_size_limit of 4,395,630,592 bytes; 6,750,000 did not.
    expect(
      Math.floor(4_395_630_592 / MAIN_THREAD_HEAP_BYTES_PER_RECORD),
    ).toBeLessThanOrEqual(6_500_000);
  });

  it("admits every input of the per-set maximum under the PSI heap ceiling", () => {
    expect(mainThreadHeapNeedBytes(2 ** 24)).toBeLessThanOrEqual(
      PSI_HEAP_CEILING_MIB * 2 ** 20,
    );
  });
});

describe("the CLI's input read", () => {
  it("refuses before it parses an input the heap cannot hold", async () => {
    heapLimit.bytes = mainThreadHeapNeedBytes(2);
    try {
      await expect(loadInputRows(writeCsv(rows(3)))).rejects.toThrow(
        /the CSV input holds 3 records/,
      );
    } finally {
      heapLimit.bytes = undefined;
    }
    await expect(loadInputRows(writeCsv(rows(3)))).resolves.toMatchObject({
      columns: ["id", "ssn"],
    });
  });
});
