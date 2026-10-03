import fs from "node:fs";
import path from "node:path";

import {
  SAMPLE_INVITER_CSV,
  SAMPLE_INVITER_FILE_NAME,
  SAMPLE_PARTNER_CSV,
  SAMPLE_PARTNER_FILE_NAME,
} from "@psi/sampleData";

/**
 * Writing the two synthetic sample CSVs into the console's work-input
 * directory, so an operator practicing on the console picks the sample from
 * their own folder instead of downloading it and moving it there by hand.
 */

/** The sample files in the order they are written: the inviter's, then the
 * partner's. */
const SAMPLE_INPUTS: ReadonlyArray<{ name: string; content: string }> = [
  { name: SAMPLE_INVITER_FILE_NAME, content: SAMPLE_INVITER_CSV },
  { name: SAMPLE_PARTNER_FILE_NAME, content: SAMPLE_PARTNER_CSV },
];

/** One sample file's outcome: written now, or left as it was because a file of
 * that name is already in the folder. */
interface SampleInputOutcome {
  name: string;
  written: boolean;
}

/** The `POST /api/jobs/inputs/samples` success body. */
export interface SampleInputsWritten {
  files: Array<SampleInputOutcome>;
}

/** A sample file could not be written into the folder (a read-only mount, or a
 * permission fault). Holds no path or OS error, so the route answers with a
 * fixed code only. */
export class SampleInputsUnwritableError extends Error {
  constructor() {
    super("the sample input files could not be written");
    this.name = "SampleInputsUnwritableError";
  }
}

/**
 * Write each sample CSV into `inputDir` under its fixed name, creating it
 * exclusively: a file already at the name -- the operator's own, an earlier
 * sample, or a link -- is left untouched and reported as not written.
 *
 * @throws {SampleInputsUnwritableError} when a file cannot be created for any
 *   other reason. Files written before the fault stay, as they would after a
 *   successful call.
 */
export function writeSampleInputs(inputDir: string): SampleInputsWritten {
  const files: Array<SampleInputOutcome> = [];
  for (const sample of SAMPLE_INPUTS) {
    try {
      fs.writeFileSync(path.join(inputDir, sample.name), sample.content, {
        flag: "wx",
      });
      files.push({ name: sample.name, written: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        files.push({ name: sample.name, written: false });
        continue;
      }
      throw new SampleInputsUnwritableError();
    }
  }
  return { files };
}
