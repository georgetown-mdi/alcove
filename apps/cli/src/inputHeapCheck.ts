import fs from "node:fs";
import { getHeapStatistics } from "node:v8";

import { UsageError } from "@alcove/core";

import { PSI_HEAP_CEILING_MIB } from "./psiMemoryBudget";

// The main thread reads and prepares the whole input before any other check
// can run, and a heap too small for it ends the process with a V8 abort
// (exit 134) and no message. This check refuses that run first, from the
// input's record count. The figure and its measurement: docs/spec/FILE_SYNC.md,
// "The main thread's heap".

/**
 * Main-thread heap an input record takes, in bytes, from reading the CSV
 * through the first-round count, for the four-column input (an id, an SSN, a
 * last name, a date of birth). At Node's default heap it admits 5,940,041
 * records, under the 6,500,000 measured to complete. A stress test holds an
 * input of the records it admits at the default heap to completing.
 */
export const MAIN_THREAD_HEAP_BYTES_PER_RECORD = 740;

/** The smallest a CSV record can be on disk: one character and a newline. */
const SMALLEST_RECORD_BYTES = 2;

/** The heap the main thread needs to read and prepare `records` records. */
export function mainThreadHeapNeedBytes(records: number): number {
  return records * MAIN_THREAD_HEAP_BYTES_PER_RECORD;
}

/**
 * The records in the CSV file at `path`: its line count less the header,
 * counted without parsing. A quoted field holding a line break adds a line,
 * so the count is never below the parser's.
 */
export async function countCsvRecords(path: string): Promise<number> {
  let newlines = 0;
  let lastByte: number | undefined;
  for await (const chunk of fs.createReadStream(path)) {
    const bytes = chunk as Buffer;
    for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1))
      newlines++;
    if (bytes.length > 0) lastByte = bytes[bytes.length - 1];
  }
  if (lastByte === undefined) return 0;
  const lines = newlines + (lastByte === 10 ? 0 : 1);
  return Math.max(0, lines - 1);
}

/**
 * The `--max-old-space-size` value, in MiB, to tell the operator: the PSI heap
 * ceiling the container images set, or more when the input needs more.
 */
function suggestedHeapMiB(needBytes: number): number {
  return Math.max(PSI_HEAP_CEILING_MIB, Math.ceil(needBytes / 2 ** 20));
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

/** The refusal for an input the main thread's heap cannot hold. */
export function inputHeapShortfallMessage(params: {
  records: number;
  fileBytes: number;
  heapLimitBytes: number;
}): string {
  const needBytes = mainThreadHeapNeedBytes(params.records);
  return (
    `the CSV input holds ${params.records.toLocaleString("en-US")} records ` +
    `(${(params.fileBytes / 1e6).toFixed(1)} MB), and reading and preparing them needs ` +
    `about ${gigabytes(needBytes)} of heap, more than this process's limit ` +
    `of ${gigabytes(params.heapLimitBytes)}. Set ` +
    `NODE_OPTIONS=--max-old-space-size=${suggestedHeapMiB(needBytes)} in the ` +
    `environment and run the command again.`
  );
}

/**
 * Refuse, with a {@link UsageError}, a CSV input file the main thread's heap
 * cannot read and prepare. Reads nothing for stdin (`-`), and leaves a path
 * it cannot stat or read to the read that reports it. A file too small to hold
 * more records than the heap admits is not counted.
 */
export async function checkInputFitsMainThreadHeap(
  input: string,
  heapLimitBytes: number = getHeapStatistics().heap_size_limit,
): Promise<void> {
  if (input === "-") return;
  let fileBytes: number;
  try {
    const stat = fs.statSync(input);
    if (!stat.isFile()) return;
    fileBytes = stat.size;
  } catch {
    return;
  }
  const mostRecords = Math.floor(fileBytes / SMALLEST_RECORD_BYTES);
  if (mainThreadHeapNeedBytes(mostRecords) <= heapLimitBytes) return;
  let records: number;
  try {
    records = await countCsvRecords(input);
  } catch {
    return;
  }
  if (mainThreadHeapNeedBytes(records) <= heapLimitBytes) return;
  throw new UsageError(
    inputHeapShortfallMessage({ records, fileBytes, heapLimitBytes }),
  );
}
