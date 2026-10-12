import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  WorkingFolderFilesRefusedError,
  writeWorkingFolderExchangeFiles,
} from "@jobs/workingFolderExchangeFiles";
import { JOB_FILE_NAMES } from "@jobContract/intentSchemas";

import { tempDataRoot } from "../../utils/jobFixtures";

const CONFIG = "connection:\n  channel: webrtc\n";
const KEY = JSON.stringify({ sharedSecret: "secret-one" });

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = tempDataRoot("working-folder-files");
  roots.push(root);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function refusal(write: () => unknown): string | undefined {
  try {
    write();
  } catch (error) {
    if (error instanceof WorkingFolderFilesRefusedError) return error.fault;
    throw error;
  }
  return undefined;
}

describe("writeWorkingFolderExchangeFiles", () => {
  test("writes both files owner-only into an empty folder", () => {
    const root = folder();
    const written = writeWorkingFolderExchangeFiles(root, CONFIG, KEY);
    expect(written).toEqual({
      configPath: path.join(root, JOB_FILE_NAMES.config),
      keyPath: path.join(root, JOB_FILE_NAMES.key),
    });
    expect(fs.readFileSync(written.configPath, "utf8")).toBe(CONFIG);
    expect(fs.readFileSync(written.keyPath, "utf8")).toBe(KEY);
    for (const file of [written.configPath, written.keyPath])
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a link at either name is refused and not followed", () => {
    const root = folder();
    const target = path.join(root, "elsewhere");
    fs.symlinkSync(target, path.join(root, JOB_FILE_NAMES.key));
    expect(
      refusal(() => writeWorkingFolderExchangeFiles(root, CONFIG, KEY)),
    ).toBe("present");
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(root, JOB_FILE_NAMES.config))).toBe(false);
  });

  test("another exchange's key file is refused, with nothing written", () => {
    const root = folder();
    const other = JSON.stringify({ sharedSecret: "secret-two" });
    fs.writeFileSync(path.join(root, JOB_FILE_NAMES.key), other);
    expect(
      refusal(() => writeWorkingFolderExchangeFiles(root, CONFIG, KEY)),
    ).toBe("present");
    expect(fs.readdirSync(root)).toEqual([JOB_FILE_NAMES.key]);
  });

  test("this invitation's own key file is kept, and a removed alcove.yaml written again", () => {
    const root = folder();
    writeWorkingFolderExchangeFiles(root, CONFIG, KEY);
    fs.writeFileSync(path.join(root, JOB_FILE_NAMES.config), "edited\n");
    writeWorkingFolderExchangeFiles(root, CONFIG, KEY);
    expect(
      fs.readFileSync(path.join(root, JOB_FILE_NAMES.config), "utf8"),
    ).toBe("edited\n");

    fs.rmSync(path.join(root, JOB_FILE_NAMES.config));
    writeWorkingFolderExchangeFiles(root, CONFIG, KEY);
    expect(
      fs.readFileSync(path.join(root, JOB_FILE_NAMES.config), "utf8"),
    ).toBe(CONFIG);
  });

  test("a folder that refuses the write is unwritable, leaving nothing", () => {
    const root = path.join(folder(), "not-a-folder");
    fs.writeFileSync(root, "");
    expect(
      refusal(() => writeWorkingFolderExchangeFiles(root, CONFIG, KEY)),
    ).toBe("unwritable");
  });
});
