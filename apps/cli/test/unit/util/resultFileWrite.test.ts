import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { resetStdoutErrorGuard, writeOutput } from "../../../src/util/dataIo";

// The result file is written from rows built as they are read: each line is
// written under the stream's backpressure, and a row that fails to build
// rejects the write.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-result-write-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const log = { error: () => {} };

test("rows read one at a time are written in order past the stream's buffer", async () => {
  const rowCount = 100_000;
  let built = 0;
  function* rows(): Generator<Array<string>> {
    for (let i = 0; i < rowCount; i++) {
      built += 1;
      yield [String(i), `value ${i}`];
    }
  }
  const file = path.join(dir, "result.csv");
  await writeOutput(file, ["id", "value"], rows(), log);

  expect(built).toBe(rowCount);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  expect(lines).toHaveLength(rowCount + 2);
  expect(lines[0]).toBe("id,value");
  expect(lines[1]).toBe("0,value 0");
  expect(lines[rowCount]).toBe(`${rowCount - 1},value ${rowCount - 1}`);
  expect(lines[rowCount + 1]).toBe("");
});

test("a row that fails to build rejects the write", async () => {
  const failure = new Error("row 3 could not be built");
  function* rows(): Generator<Array<string>> {
    for (let i = 0; i < 3; i++) yield [String(i)];
    throw failure;
  }
  await expect(
    writeOutput(path.join(dir, "result.csv"), ["id"], rows(), log),
  ).rejects.toBe(failure);
  // The rows went to a temp file, which the failure removed, so nothing is
  // left at the result's name or beside it.
  expect(fs.readdirSync(dir)).toEqual([]);
});

// The result is written to an owner-only temp file renamed onto its name at
// close, so whatever already holds that name is replaced, not written through.

test.skipIf(process.platform === "win32")(
  "a symlink at the result's name is replaced and its target left unchanged",
  async () => {
    const target = path.join(dir, "elsewhere.txt");
    fs.writeFileSync(target, "original contents\n");
    fs.chmodSync(target, 0o644);
    const file = path.join(dir, "alcove-results-20261106T000000Z.csv");
    fs.symlinkSync(target, file);

    await writeOutput(file, ["id"], [["1"], ["2"]], log);

    expect(fs.readFileSync(target, "utf8")).toBe("original contents\n");
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("id\n1\n2\n");
  },
);

test.skipIf(process.platform === "win32")(
  "a dangling symlink at the result's name is replaced and creates nothing at its target",
  async () => {
    const target = path.join(dir, "absent", "planted.csv");
    const file = path.join(dir, "result.csv");
    fs.symlinkSync(target, file);

    await writeOutput(file, ["id"], [["1"]], log);

    expect(fs.existsSync(path.dirname(target))).toBe(false);
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("id\n1\n");
  },
);

test("a file the result's name shares with another link is replaced and the other link's file left unchanged", async () => {
  const other = path.join(dir, "other.txt");
  fs.writeFileSync(other, "original contents\n");
  const file = path.join(dir, "result.csv");
  fs.linkSync(other, file);

  await writeOutput(file, ["id"], [["1"]], log);

  expect(fs.readFileSync(other, "utf8")).toBe("original contents\n");
  expect(fs.statSync(other).nlink).toBe(1);
  expect(fs.readFileSync(file, "utf8")).toBe("id\n1\n");
  expect(fs.readdirSync(dir).sort()).toEqual(["other.txt", "result.csv"]);
});

// The stdout path pulls the same lazily built rows, so a row that fails to
// build rejects with the row's own error there too, never as a lost stdout.

test("stdout: a row that fails to build on the first pump rejects with its error", async () => {
  const failure = new Error("row 1 could not be built");
  function* rows(): Generator<Array<string>> {
    throw failure;
  }
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(
      ((_chunk: string | Uint8Array): boolean =>
        true) as typeof process.stdout.write,
    );
  try {
    await expect(writeOutput(undefined, ["id"], rows(), log)).rejects.toBe(
      failure,
    );
  } finally {
    stdoutSpy.mockRestore();
    resetStdoutErrorGuard();
  }
});

test("stdout: a row that fails to build after a drain rejects with its error", async () => {
  const failure = new Error("row 3 could not be built");
  function* rows(): Generator<Array<string>> {
    for (let i = 0; i < 3; i++) yield [String(i)];
    throw failure;
  }
  let written = 0;
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    _chunk: string | Uint8Array,
  ): boolean => {
    written += 1;
    if (written === 2) {
      setImmediate(() => process.stdout.emit("drain"));
      return false;
    }
    return true;
  }) as typeof process.stdout.write);
  try {
    await expect(writeOutput(undefined, ["id"], rows(), log)).rejects.toBe(
      failure,
    );
    expect(written).toBe(3);
  } finally {
    stdoutSpy.mockRestore();
    resetStdoutErrorGuard();
  }
});
