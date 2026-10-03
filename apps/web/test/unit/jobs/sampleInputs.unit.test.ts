import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { writeSampleInputs } from "@jobs/sampleInputs";

import {
  SAMPLE_INVITER_CSV,
  SAMPLE_INVITER_FILE_NAME,
  SAMPLE_PARTNER_FILE_NAME,
} from "@psi/sampleData";

const dirs: Array<string> = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `alcove-${label}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeSampleInputs", () => {
  test("writes both samples, and leaves a file already at a sample's name as it was", () => {
    const dir = tempDir("inputs");
    fs.writeFileSync(path.join(dir, SAMPLE_PARTNER_FILE_NAME), "mine");
    expect(writeSampleInputs(dir)).toEqual({
      files: [
        { name: SAMPLE_INVITER_FILE_NAME, written: true },
        { name: SAMPLE_PARTNER_FILE_NAME, written: false },
      ],
    });
    expect(
      fs.readFileSync(path.join(dir, SAMPLE_INVITER_FILE_NAME), "utf8"),
    ).toBe(SAMPLE_INVITER_CSV);
    expect(
      fs.readFileSync(path.join(dir, SAMPLE_PARTNER_FILE_NAME), "utf8"),
    ).toBe("mine");
  });

  test("does not write through a link at a sample's name", () => {
    const dir = tempDir("inputs");
    const target = path.join(tempDir("elsewhere"), "target.csv");
    fs.symlinkSync(target, path.join(dir, SAMPLE_INVITER_FILE_NAME));
    const written = writeSampleInputs(dir);
    expect(written.files[0]).toEqual({
      name: SAMPLE_INVITER_FILE_NAME,
      written: false,
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a folder it cannot write into is refused with no path",
    () => {
      const dir = tempDir("inputs");
      fs.chmodSync(dir, 0o500);
      let caught: Error | null = null;
      try {
        writeSampleInputs(dir);
      } catch (error) {
        caught = error as Error;
      }
      expect(caught?.name).toBe("SampleInputsUnwritableError");
      expect(caught?.message).not.toContain(dir);
    },
  );
});
