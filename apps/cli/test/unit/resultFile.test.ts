import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { UsageError } from "@alcove/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { recordFilePathIn } from "../../src/recordFile";
import {
  DEFAULT_RESULT_BASENAME,
  preflightOutputFolder,
  resultFilePath,
  runArtifactFolder,
} from "../../src/resultFile";
import { exitCodeForError } from "../../src/util/exit";

const CREATED_AT = "2026-10-03T02:00:01.234Z";
const STAMPED_NAME = `${DEFAULT_RESULT_BASENAME}-2026-10-03T02-00-01-234Z.csv`;

const quietLog = { info: () => {} } as unknown as Parameters<
  typeof preflightOutputFolder
>[1];

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-result-file-"));
});

afterEach(() => {
  fs.chmodSync(dir, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("resultFilePath", () => {
  test("the result gets a stamped name inside the folder", () => {
    expect(resultFilePath(dir, CREATED_AT)).toBe(path.join(dir, STAMPED_NAME));
    expect(resultFilePath("./", CREATED_AT)).toBe(STAMPED_NAME);
    expect(resultFilePath("results", CREATED_AT)).toBe(
      path.join("results", STAMPED_NAME),
    );
  });

  test("the result's stamp is the record name's stamp", () => {
    const recordName = path.basename(recordFilePathIn(".", CREATED_AT));
    const recordStamp = recordName.slice(
      "alcove-record-".length,
      -".json".length,
    );
    expect(resultFilePath(".", CREATED_AT)).toBe(
      `${DEFAULT_RESULT_BASENAME}-${recordStamp}.csv`,
    );
  });
});

describe("runArtifactFolder", () => {
  test("the output folder when one is given, the working directory otherwise", () => {
    expect(runArtifactFolder(dir)).toBe(dir);
    expect(runArtifactFolder(undefined)).toBe(".");
  });
});

describe("preflightOutputFolder", () => {
  test("a missing folder is created, parents included, and left empty", () => {
    const missing = path.join(dir, "a", "b");
    preflightOutputFolder(missing, quietLog);
    expect(fs.statSync(missing).isDirectory()).toBe(true);
    expect(fs.readdirSync(missing)).toEqual([]);
  });

  test("an existing writable folder passes and keeps no probe file", () => {
    fs.writeFileSync(path.join(dir, "earlier.csv"), "a\n");
    preflightOutputFolder(dir, quietLog);
    expect(fs.readdirSync(dir)).toEqual(["earlier.csv"]);
  });

  test("a file path is refused as a usage error (exit 64), and left as it is", () => {
    const file = path.join(dir, "results.csv");
    fs.writeFileSync(file, "a\n");
    let thrown: unknown;
    try {
      preflightOutputFolder(file, quietLog);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect(exitCodeForError(thrown)).toBe(64);
    expect((thrown as Error).message).toContain("is a file, not a folder");
    expect(fs.readFileSync(file, "utf8")).toBe("a\n");
  });

  test("a folder that cannot be created is refused with exit 64", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "");
    let thrown: unknown;
    try {
      preflightOutputFolder(path.join(blocker, "out"), quietLog);
    } catch (err) {
      thrown = err;
    }
    expect(exitCodeForError(thrown)).toBe(64);
    expect((thrown as Error).message).toMatch(/cannot be (created|checked)/);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a folder that cannot be written is refused with exit 64",
    () => {
      fs.chmodSync(dir, 0o500);
      let thrown: unknown;
      try {
        preflightOutputFolder(dir, quietLog);
      } catch (err) {
        thrown = err;
      }
      expect(exitCodeForError(thrown)).toBe(64);
      expect((thrown as Error).message).toContain("is not writable");
    },
  );

  test("a probe that cannot be closed is refused with exit 64 and removed", () => {
    const spy = vi.spyOn(fs, "closeSync").mockImplementation(() => {
      throw new Error("close failed");
    });
    let thrown: unknown;
    try {
      preflightOutputFolder(dir, quietLog);
    } catch (err) {
      thrown = err;
    } finally {
      spy.mockRestore();
    }
    expect(exitCodeForError(thrown)).toBe(64);
    expect((thrown as Error).message).toContain("is not writable");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a missing folder under a read-only parent is refused with exit 64",
    () => {
      fs.chmodSync(dir, 0o500);
      let thrown: unknown;
      try {
        preflightOutputFolder(path.join(dir, "out"), quietLog);
      } catch (err) {
        thrown = err;
      }
      expect(exitCodeForError(thrown)).toBe(64);
      expect((thrown as Error).message).toContain("cannot be created");
    },
  );

  test.skipIf(process.platform === "win32")(
    "a symbolic link to a folder is accepted",
    () => {
      const target = path.join(dir, "target");
      fs.mkdirSync(target);
      const link = path.join(dir, "link");
      fs.symlinkSync(target, link);
      preflightOutputFolder(link, quietLog);
      expect(resultFilePath(link, CREATED_AT)).toBe(
        path.join(link, STAMPED_NAME),
      );
    },
  );
});
