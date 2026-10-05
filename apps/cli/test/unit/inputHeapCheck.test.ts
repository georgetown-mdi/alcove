import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getLogger, loadCSVFile, UsageError } from "@alcove/core";

import {
  checkInputFitsMainThreadHeap,
  countCsvRecords,
  inputHeapShortfallMessage,
  inputHeapShortfallOverrideWarning,
  MAIN_THREAD_HEAP_BYTES_PER_RECORD,
  mainThreadHeapNeedBytes,
} from "../../src/inputHeapCheck";
import { loadInputRows } from "../../src/onlineBootstrap";
import { PSI_HEAP_CEILING_MIB } from "../../src/psiMemoryBudget";
import { openInputSource } from "../../src/util/dataIo";

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

let written = 0;
function writeCsv(body: string): string {
  scratch ??= fs.mkdtempSync(path.join(os.tmpdir(), "alcove-input-heap-"));
  const file = path.join(scratch, `input-${written++}.csv`);
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

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["bare CR", "\r"],
  ])(
    "never counts fewer records than the core CSV read parses, with %s line endings",
    async (_name, ending) => {
      const records = 5;
      for (const finalEnding of [true, false]) {
        let body = rows(records).replaceAll("\n", ending);
        if (!finalEnding) body = body.slice(0, -ending.length);
        const file = writeCsv(body);
        const parsed = await loadCSVFile(openInputSource(file));
        expect(parsed.data).toHaveLength(records);
        expect(await countCsvRecords(file)).toBeGreaterThanOrEqual(
          parsed.data.length,
        );
      }
    },
  );

  it("never counts fewer records than the parser when its first chunk ends inside a CRLF", async () => {
    // Both reads take 64 KiB chunks. The parser then takes CR as the line
    // ending and reads each LF as text, so the last LF is a record of its own.
    const header = "id\r\n";
    const pad = "x".repeat(64 * 1024 - header.length - 1);
    const file = writeCsv(`${header}${pad}\r\ny\r\n`);
    const parsed = await loadCSVFile(openInputSource(file));
    expect(parsed.data).toHaveLength(3);
    expect(await countCsvRecords(file)).toBe(3);
  });

  it("counts a bare CR split across read chunks", async () => {
    const header = "id\r";
    const pad = "x".repeat(64 * 1024 - header.length - 1);
    const file = writeCsv(`${header}${pad}\ry\r`);
    expect(await countCsvRecords(file)).toBe(2);
  });
});

describe("the main thread's heap check", () => {
  // A heap that admits exactly ten records.
  const tenRecordHeap = mainThreadHeapNeedBytes(10);

  it("admits an input at the records the heap holds", async () => {
    await expect(
      checkInputFitsMainThreadHeap(writeCsv(rows(10)), {
        heapLimitBytes: tenRecordHeap,
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses an input one record over, as a usage error naming the input's size, the limit and the NODE_OPTIONS line", async () => {
    const file = writeCsv(rows(11));
    const outcome = await checkInputFitsMainThreadHeap(file, {
      heapLimitBytes: tenRecordHeap,
    }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(UsageError);
    expect((outcome as Error).message).toBe(
      inputHeapShortfallMessage({
        records: 11,
        fileBytes: fs.statSync(file).size,
        heapLimitBytes: tenRecordHeap,
      }),
    );
  });

  it("warns and admits an input one record over under --allow-memory-shortfall", async () => {
    const file = writeCsv(rows(11));
    const warn = vi.spyOn(getLogger("input"), "warn");
    try {
      await expect(
        checkInputFitsMainThreadHeap(file, {
          heapLimitBytes: tenRecordHeap,
          allowShortfall: true,
        }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        inputHeapShortfallOverrideWarning({
          records: 11,
          fileBytes: fs.statSync(file).size,
          heapLimitBytes: tenRecordHeap,
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not read stdin or a path it cannot stat", async () => {
    await expect(
      checkInputFitsMainThreadHeap("-", { heapLimitBytes: 0 }),
    ).resolves.toBeUndefined();
    await expect(
      checkInputFitsMainThreadHeap(path.join(os.tmpdir(), "no-such.csv"), {
        heapLimitBytes: 0,
      }),
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
        `environment and run the command again, or pass ` +
        `--allow-memory-shortfall to run anyway; the run may then run out of ` +
        `heap while it reads the input and end with exit 134.`,
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

  it("reads an input the heap cannot hold under --allow-memory-shortfall", async () => {
    heapLimit.bytes = mainThreadHeapNeedBytes(2);
    const warn = vi.spyOn(getLogger("input"), "warn");
    try {
      await expect(
        loadInputRows(writeCsv(rows(3)), { allowMemoryShortfall: true }),
      ).resolves.toMatchObject({ columns: ["id", "ssn"] });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /^running with --allow-memory-shortfall: the CSV input holds 3 records/,
        ),
      );
    } finally {
      warn.mockRestore();
      heapLimit.bytes = undefined;
    }
  });
});
