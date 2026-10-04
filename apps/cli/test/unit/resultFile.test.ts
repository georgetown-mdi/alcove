import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { defaultRecordPath } from "../../src/recordFile";
import {
  DEFAULT_RESULT_BASENAME,
  outputNamesFolder,
  resultFilePath,
} from "../../src/resultFile";
import { writeOutput } from "../../src/util/dataIo";

const CREATED_AT = "2026-10-03T02:00:01.234Z";
const STAMPED_NAME = `${DEFAULT_RESULT_BASENAME}-2026-10-03T02-00-01-234Z.csv`;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-result-file-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("resultFilePath", () => {
  test("a path naming a file is used as given, whether or not it exists", () => {
    const missing = path.join(dir, "results.csv");
    expect(resultFilePath(missing, CREATED_AT)).toBe(missing);
    fs.writeFileSync(missing, "a\n");
    expect(resultFilePath(missing, CREATED_AT)).toBe(missing);
    expect(resultFilePath("results.csv", CREATED_AT)).toBe("results.csv");
  });

  test("an existing directory gets the stamped file inside it", () => {
    expect(resultFilePath(dir, CREATED_AT)).toBe(path.join(dir, STAMPED_NAME));
  });

  test("a path ending in a separator gets the stamped file, existing or not", () => {
    expect(resultFilePath("./", CREATED_AT)).toBe(STAMPED_NAME);
    expect(resultFilePath("results/", CREATED_AT)).toBe(
      path.join("results", STAMPED_NAME),
    );
  });

  test("the result's stamp is the default record name's stamp", () => {
    const recordName = path.basename(defaultRecordPath(CREATED_AT));
    const recordStamp = recordName.slice(
      "alcove-record-".length,
      -".json".length,
    );
    expect(resultFilePath("./", CREATED_AT)).toBe(
      `${DEFAULT_RESULT_BASENAME}-${recordStamp}.csv`,
    );
  });

  test("a folder that does not exist is not created: the write fails", async () => {
    const missing = path.join(dir, "missing");
    await expect(
      writeOutput(resultFilePath(`${missing}/`, CREATED_AT), ["a"], [], {
        error: () => {},
      }),
    ).rejects.toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "a symbolic link to a directory names a folder",
    () => {
      const link = path.join(dir, "link");
      fs.symlinkSync(dir, link);
      expect(outputNamesFolder(link)).toBe(true);
    },
  );
});
