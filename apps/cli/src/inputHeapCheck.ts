import fs from "node:fs";
import { getHeapStatistics } from "node:v8";

import { getLogger, UsageError } from "@alcove/core";

import { PSI_HEAP_CEILING_MIB } from "./psiMemoryBudget";

/** Main-thread heap an input record takes, in bytes, through the first-round count. */
export const MAIN_THREAD_HEAP_BYTES_PER_RECORD = 760;

/** The smallest a CSV record can be on disk: one character and a line terminator. */
const SMALLEST_RECORD_BYTES = 2;

const LF = 0x0a;
const CR = 0x0d;

/** The heap the main thread needs to read and prepare `records` records. */
export function mainThreadHeapNeedBytes(records: number): number {
  return records * MAIN_THREAD_HEAP_BYTES_PER_RECORD;
}

/**
 * The records in the CSV file at `path`: its line count less the header,
 * counted without parsing. The parser takes one line ending from the start of
 * the file -- LF, CRLF, or CR -- and reads the others as text, so the line
 * count is the larger of the lines ended by an LF or a lone CR and the lines
 * ended by a CR. A quoted field holding a line break adds a line, so the count
 * is never below the parser's.
 */
export async function countCsvRecords(path: string): Promise<number> {
  let lfs = 0;
  let crs = 0;
  let loneCrs = 0;
  let previousEndedInCr = false;
  let lastByte: number | undefined;
  for await (const chunk of fs.createReadStream(path)) {
    const bytes = chunk as Buffer;
    if (bytes.length === 0) continue;
    if (previousEndedInCr && bytes[0] !== LF) loneCrs++;
    for (let at = bytes.indexOf(LF); at !== -1; at = bytes.indexOf(LF, at + 1))
      lfs++;
    for (
      let at = bytes.indexOf(CR);
      at !== -1;
      at = bytes.indexOf(CR, at + 1)
    ) {
      crs++;
      if (at + 1 < bytes.length && bytes[at + 1] !== LF) loneCrs++;
    }
    lastByte = bytes[bytes.length - 1];
    previousEndedInCr = lastByte === CR;
  }
  if (lastByte === undefined) return 0;
  if (previousEndedInCr) loneCrs++;
  const lines = Math.max(
    lfs + loneCrs + (lastByte === LF || lastByte === CR ? 0 : 1),
    crs + (lastByte === CR ? 0 : 1),
  );
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

interface InputHeapShortfall {
  records: number;
  fileBytes: number;
  heapLimitBytes: number;
}

function inputHeapShortfallSentence(params: InputHeapShortfall): string {
  const needBytes = mainThreadHeapNeedBytes(params.records);
  return (
    `the CSV input holds ${params.records.toLocaleString("en-US")} records ` +
    `(${(params.fileBytes / 1e6).toFixed(1)} MB), and reading and preparing them needs ` +
    `about ${gigabytes(needBytes)} of heap, more than this process's limit ` +
    `of ${gigabytes(params.heapLimitBytes)}`
  );
}

/** The refusal for an input the main thread's heap cannot hold. */
export function inputHeapShortfallMessage(params: InputHeapShortfall): string {
  const needBytes = mainThreadHeapNeedBytes(params.records);
  return (
    `${inputHeapShortfallSentence(params)}. Set ` +
    `NODE_OPTIONS=--max-old-space-size=${suggestedHeapMiB(needBytes)} in the ` +
    `environment and run the command again, or pass ` +
    `--allow-memory-shortfall to run anyway; the run may then run out of ` +
    `heap while it reads the input and end with exit 134.`
  );
}

/** The warning for an input {@link inputHeapShortfallMessage} would refuse, read under the override. */
export function inputHeapShortfallOverrideWarning(
  params: InputHeapShortfall,
): string {
  return (
    `running with --allow-memory-shortfall: ${inputHeapShortfallSentence(params)}. ` +
    `The run may run out of heap while it reads the input and end with exit 134.`
  );
}

/**
 * Refuse, with a {@link UsageError}, a CSV input file the main thread's heap
 * cannot read and prepare, or with `allowShortfall` warn and return. Reads
 * nothing for stdin (`-`), and leaves a path it cannot stat or read to the read
 * that reports it. A file too small to hold more records than the heap admits
 * is not counted.
 */
export async function checkInputFitsMainThreadHeap(
  input: string,
  {
    allowShortfall = false,
    heapLimitBytes = getHeapStatistics().heap_size_limit,
  }: { allowShortfall?: boolean; heapLimitBytes?: number } = {},
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
  const shortfall = { records, fileBytes, heapLimitBytes };
  if (allowShortfall) {
    getLogger("input").warn(inputHeapShortfallOverrideWarning(shortfall));
    return;
  }
  throw new UsageError(inputHeapShortfallMessage(shortfall));
}
