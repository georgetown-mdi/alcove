import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  CsvLineByteCeilingError,
  MAX_NAME_LENGTH,
  StandardizationSchema,
  createDateFormatInferrer,
  isProtocolGrammarName,
  maxCodeUnits,
  readRowColumn,
  streamCSVRows,
} from "@alcove/core";

import { PREVIEW_SAMPLE_SIZE } from "@psi/columnSamples";
import { createFieldCoverageAccumulator } from "@psi/workers/nonEmptyAggregate";

import {
  MAX_INPUT_NAME_LENGTH,
  isAdmissibleInputName,
} from "@jobContract/workInputName";
import {
  MAX_STANDARDIZATION_STEPS,
  MAX_STANDARDIZATION_TRANSFORMATIONS,
  jobCsvDelimiterSchema,
  stepPatternsWithinCap,
} from "@jobContract/intentSchemas";
import { CONSOLE_WRITTEN_NAMES } from "./consoleOwnedFiles";
import { JOB_DATA_ROOT_ENV } from "./gate";

import type {
  ColumnDateInputFormat,
  ColumnSample,
  JobInputFileEntry,
  JobInputListing,
  JobInputProfile,
  JobInputProfileErrorCode,
} from "@jobContract/workInputResponses";
import type { DateFormatInferrer, Standardization } from "@alcove/core";
import type { FieldValueCoverage } from "@psi/workers/nonEmptyAggregate";

/**
 * The environment variable naming the operator-mounted directory the console
 * lists and reads input CSVs from. When unset or empty, falls back to
 * `JOB_DATA_ROOT` (so a single-folder console, one mount with only
 * `JOB_DATA_ROOT` set, still lists inputs). The feature is off only when both
 * are unset: the listing reports `configured: false` with an empty list and
 * the profile/coverage routes answer 404. The operator mounts their own data,
 * so this is trusted local input, not a shared-service surface.
 */
const JOB_INPUT_DIR_ENV = "JOB_INPUT_DIR";

export {
  MAX_INPUT_NAME_LENGTH,
  isAdmissibleInputName,
} from "@jobContract/workInputName";

/**
 * The byte cap on a coverage request body: a generous bound on the streamed read
 * of the standardization JSON, which is a handful of transformations at most. The
 * input CSV never rides the body -- it is read from the mounted directory -- so
 * this stays small.
 */
export const MAX_COVERAGE_BODY_BYTES = 1024 * 1024;

/** A requested input name that names no regular file in the mounted directory: an
 * inadmissible name, or a file that is absent or is not a regular file. */
export class JobInputNotFoundError extends Error {
  constructor() {
    super("job input not found");
    this.name = "JobInputNotFoundError";
  }
}

/** A profile fault the route maps to a 400 holding only {@link code}. Never wraps
 * the underlying error, so no path or cell bytes reach the response. */
export class JobInputProfileError extends Error {
  constructor(readonly code: JobInputProfileErrorCode) {
    super(`job input profile failed: ${code}`);
    this.name = "JobInputProfileError";
  }
}

/** Signals that a {@link coverageJobInput} pass was aborted through its signal (a
 * client disconnect or a superseded sweep). Holds no path, so the aborted pass
 * never exposes the mounted directory. */
export class JobInputCoverageAbortedError extends Error {
  constructor() {
    super("job input coverage aborted");
    this.name = "JobInputCoverageAbortedError";
  }
}

declare global {
  var jobInputDirConfig: { resolvedDir?: string } | undefined;
}

/** Truncate a stat's float `mtimeMs` to integer epoch milliseconds, the single
 * serialized representation used in the listing and profile. */
function mtimeMsInt(mtimeMs: number): number {
  return Math.trunc(mtimeMs);
}

/**
 * Resolve `name` to a readable regular file inside `resolvedDir`, returning its path
 * and the stat used to admit it. The name is a single admissible segment
 * ({@link isAdmissibleInputName}) so it never composes a traversal even though the
 * mounted directory is the operator's own; a name that resolves to no regular file
 * is a {@link JobInputNotFoundError}. Returning the stat lets a caller read size and
 * mtime without a second stat that could race the file away and expose a raw fs
 * error holding the mounted path.
 */
function resolveJobInputFile(
  resolvedDir: string,
  name: string,
): { filePath: string; stat: fs.Stats } {
  if (!isAdmissibleInputName(name)) throw new JobInputNotFoundError();
  const filePath = path.join(resolvedDir, name);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new JobInputNotFoundError();
  }
  if (!stat.isFile()) throw new JobInputNotFoundError();
  return { filePath, stat };
}

/**
 * Resolve an input reference to the mounted file the CLI reads in place. Shared by
 * the job manager, which composes the absolute path into the CLI config without
 * copying the content.
 */
export function jobInputFilePath(resolvedDir: string, name: string): string {
  return resolveJobInputFile(resolvedDir, name).filePath;
}

/** Whether `name` is a file the console or an exchange writes into the folder
 * -- a console-written name, or a file in the exchange's protocol filename
 * grammar, which a shared-folder exchange on a one-folder console writes beside
 * the inputs -- rather than an input. */
export function isConsoleOrExchangeFileName(name: string): boolean {
  return CONSOLE_WRITTEN_NAMES.has(name) || isProtocolGrammarName(name);
}

/** The realpath of `filePath`, or undefined when it cannot be resolved. */
function realpathOrUndefined(filePath: string): string | undefined {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

/**
 * List the admissible input files, or the unconfigured state when `resolvedDir` is
 * undefined. Reads the directory non-recursively, admits regular files whose name
 * is admissible ({@link isAdmissibleInputName}), and sorts by name. An unreadable
 * directory (a mis-mount) reports `readable: false` with an empty list rather than an
 * empty-but-readable directory, so the operator checks their mount instead of placing
 * a file that is already there. On any ambiguity the listing still fails toward empty.
 *
 * Files that are not inputs are left out: the ones the console or an exchange
 * writes ({@link isConsoleOrExchangeFileName}), and any whose realpath is in
 * `credentialPaths` -- the credential and signing-identity files the current
 * connection and opened configuration reference.
 */
export function listJobInputs(
  resolvedDir: string | undefined,
  credentialPaths: ReadonlySet<string> = new Set(),
): JobInputListing {
  if (resolvedDir === undefined)
    return { configured: false, readable: true, files: [] };
  let names: Array<string>;
  try {
    names = fs.readdirSync(resolvedDir);
  } catch {
    return { configured: true, readable: false, files: [] };
  }
  const files: Array<JobInputFileEntry> = [];
  for (const name of names) {
    if (!isAdmissibleInputName(name) || isConsoleOrExchangeFileName(name))
      continue;
    const filePath = path.join(resolvedDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (credentialPaths.size > 0) {
      const realPath = realpathOrUndefined(filePath);
      if (realPath !== undefined && credentialPaths.has(realPath)) continue;
    }
    files.push({
      name,
      sizeBytes: stat.size,
      modifiedAt: mtimeMsInt(stat.mtimeMs),
    });
  }
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { configured: true, readable: true, files };
}

/**
 * Profile a mounted input in ONE streaming pass that retains no rows: columns from
 * the header, `rowCount` by counting, `columnSamples` as the first
 * {@link PREVIEW_SAMPLE_SIZE} non-empty values per column in row order (the
 * `sampleInputValues` semantics the browser preview uses), and `dateInputFormats`
 * by feeding every column's values to its own core date-format inferrer
 * ({@link createDateFormatInferrer}), which stops at its scan cap. Every
 * accumulator is constant-size per column, so peak memory is one parse chunk
 * regardless of the file's row count.
 *
 * `csvDelimiter` is the field delimiter the operator chose for their own file;
 * omitted, the pass reads commas, and `detect` takes the delimiter from the file.
 * The columns this reports become the party's linkage terms, so the profile and
 * the run the console composes must read the file the same way.
 */
export async function profileJobInput(
  resolvedDir: string,
  name: string,
  csvDelimiter?: string,
): Promise<JobInputProfile> {
  const { filePath, stat } = resolveJobInputFile(resolvedDir, name);
  const stream = fs.createReadStream(filePath);
  const samples = new Map<string, Array<string>>();
  const dateInferrers = new Map<string, DateFormatInferrer>();
  let rowCount = 0;
  let columns: Array<string>;
  let sanitizedColumnPositions: Array<number>;
  try {
    ({ columns, sanitizedColumnPositions } = await streamCSVRows(
      stream,
      (rows, cols) => {
        for (const row of rows) {
          rowCount++;
          for (const col of cols) {
            let bucket = samples.get(col);
            if (bucket === undefined) {
              bucket = [];
              samples.set(col, bucket);
            }
            const value = readRowColumn(row, col);
            if (
              bucket.length < PREVIEW_SAMPLE_SIZE &&
              value !== undefined &&
              value.trim() !== ""
            )
              bucket.push(value);
            let inferrer = dateInferrers.get(col);
            if (inferrer === undefined) {
              inferrer = createDateFormatInferrer();
              dateInferrers.set(col, inferrer);
            }
            inferrer.add(value);
          }
        }
      },
      undefined,
      csvDelimiter,
    ));
  } catch (error) {
    // Classify the fault into a closed code; the underlying error (a read fault
    // embedding the mounted path, or a parser error holding cell bytes) is never
    // exposed. A ceiling trip is the one distinguishable non-generic case.
    throw new JobInputProfileError(
      error instanceof CsvLineByteCeilingError ? "too_large" : "parse_failed",
    );
  }
  // A parse that yields no columns is not a usable CSV (an empty file, or one with
  // no header row), a distinct operator-meaningful reason from a parse fault.
  if (columns.length === 0) throw new JobInputProfileError("not_a_csv");
  const dateInputFormats: Array<ColumnDateInputFormat> = [];
  for (const column of new Set(columns)) {
    const format = dateInferrers.get(column)?.result().format;
    if (format !== undefined) dateInputFormats.push({ column, format });
  }
  const columnSamples: Array<ColumnSample> = columns.map((col) => ({
    column: col,
    values: samples.get(col) ?? [],
  }));
  return {
    name,
    sizeBytes: stat.size,
    modifiedAt: mtimeMsInt(stat.mtimeMs),
    rowCount,
    columns,
    sanitizedColumnPositions,
    dateInputFormats,
    columnSamples,
  };
}

/**
 * Sweep a mounted input's per-field coverage in ONE streaming pass, feeding the
 * shared per-row accumulator ({@link createFieldCoverageAccumulator}) so the result
 * equals `computeFieldCoverage` over the same rows.
 *
 * An optional `signal` stops the pass early: when the client disconnects or the
 * browser supersedes the sweep it aborts, the read stream is destroyed, and the pass
 * rejects with a {@link JobInputCoverageAbortedError} rather than scanning the rest
 * of a CLI-scale file. The abort error holds no path or row bytes.
 *
 * `csvDelimiter` is the operator's own choice for this file, as
 * {@link profileJobInput} takes it: a sweep that read the file another way would
 * report coverage for columns the run never sees.
 */
export async function coverageJobInput(
  resolvedDir: string,
  name: string,
  standardization: Standardization,
  csvDelimiter?: string,
  signal?: AbortSignal,
): Promise<Array<FieldValueCoverage>> {
  const { filePath } = resolveJobInputFile(resolvedDir, name);
  if (signal?.aborted) throw new JobInputCoverageAbortedError();
  const stream = fs.createReadStream(filePath);
  // A no-op error listener so destroying the stream on abort -- or an open fault that
  // races the abort -- is never reported as an uncaught 'error'; the parse rejection
  // holds the real fault on the non-abort path.
  stream.on("error", () => {});
  const accumulator = createFieldCoverageAccumulator(standardization);
  const parse = streamCSVRows(
    stream,
    (rows) => {
      for (const row of rows) accumulator.add(row);
    },
    undefined,
    csvDelimiter,
  );

  if (signal === undefined) {
    await parse;
    return accumulator.result();
  }

  // Race the parse against the abort: an abort destroys the stream so the pass stops
  // rather than scanning the rest of a CLI-scale file. Swallow a late parse rejection
  // once the abort has won the race.
  parse.catch(() => {});
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      stream.destroy();
      reject(new JobInputCoverageAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([parse, aborted]);
  } catch (error) {
    // An aborted signal always reports the clean aborted error, never a parser
    // rejection that could embed the mounted path on a mid-stream read fault.
    if (signal.aborted) throw new JobInputCoverageAbortedError();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return accumulator.result();
}

/** Resolve the input directory to an absolute path from {@link JOB_INPUT_DIR_ENV},
 * falling back to {@link JOB_DATA_ROOT_ENV} when it is unset so one mount runs a full
 * console, or undefined when both are unset. The mounted directory is trusted
 * operator data, so this is a plain resolve -- no containment check against the data
 * root, no fail-closed existence assertion (a mis-mount shows as an empty
 * listing). */
function loadJobInputDir(env: NodeJS.ProcessEnv): string | undefined {
  const configured = (env[JOB_INPUT_DIR_ENV] ?? "").trim();
  const resolved =
    configured.length > 0 ? configured : (env[JOB_DATA_ROOT_ENV] ?? "").trim();
  if (resolved.length === 0) return undefined;
  return path.resolve(resolved);
}

/**
 * Resolve the input directory once and memoize it on globalThis, so dev-mode HMR
 * does not re-read it. The wrapper distinguishes "loaded, feature off" (an
 * undefined `resolvedDir`) from "not yet loaded".
 */
export function useJobInputDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  globalThis.jobInputDirConfig ??= { resolvedDir: loadJobInputDir(env) };
  return globalThis.jobInputDirConfig.resolvedDir;
}

/**
 * The coverage route's standardization validation: core's structural schema plus
 * the same count bounds the intent schema applies (reusing its exported caps) plus
 * the per-step pattern-length cap ({@link stepPatternsWithinCap}). The shared
 * intent schema is NOT modified -- only this in-process compute endpoint applies
 * the pattern cap.
 */
const coverageStandardizationSchema = StandardizationSchema.refine(
  (transformations) =>
    transformations.length <= MAX_STANDARDIZATION_TRANSFORMATIONS,
  { message: "standardization must not exceed the transformation cap" },
)
  .refine(
    (transformations) =>
      transformations.every(
        (transformation) =>
          (transformation.steps?.length ?? 0) <= MAX_STANDARDIZATION_STEPS,
      ),
    { message: "a standardization transformation exceeds the step cap" },
  )
  .refine(
    (transformations) =>
      transformations.every(
        (transformation) =>
          transformation.output.length <= MAX_NAME_LENGTH &&
          transformation.input.length <= MAX_NAME_LENGTH,
      ),
    { message: "a standardization output or input exceeds the length cap" },
  )
  .refine((transformations) => transformations.every(stepPatternsWithinCap), {
    message: "a standardization step pattern exceeds the length cap",
  });

/** The validated `POST /api/jobs/inputs/coverage` request body. */
interface CoverageRequestBody {
  name: string;
  standardization: Standardization;
  csvDelimiter?: string;
}

/** Schema for the coverage request body. `name` is length-bounded here and
 * resolved against the mounted directory at sweep time; `csvDelimiter` takes the
 * job intent's own grade ({@link jobCsvDelimiterSchema}), so a sweep and the run
 * it advises accept the same delimiters. */
export const coverageRequestSchema: z.ZodType<CoverageRequestBody> = z
  .object({
    name: z.string().min(1).check(maxCodeUnits(MAX_INPUT_NAME_LENGTH)),
    standardization: coverageStandardizationSchema,
    csvDelimiter: jobCsvDelimiterSchema.optional(),
  })
  .strict();
