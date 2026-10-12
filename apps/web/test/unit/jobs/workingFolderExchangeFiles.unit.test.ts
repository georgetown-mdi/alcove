import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  WorkingFolderFilesRefusedError,
  refreshWorkingFolderExchangeFiles,
  workingFolderExchangeFilePaths,
  workingFolderExchangeFilesPresent,
  writeWorkingFolderExchangeFiles,
} from "@jobs/workingFolderExchangeFiles";
import { JOB_FILE_NAMES } from "@jobContract/intentSchemas";

import { tempDataRoot } from "../../utils/jobFixtures";

import type { ExchangeFilePaths } from "@jobs/workingFolderExchangeFiles";

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

/** A run's own pair, in a run folder inside `root`. */
function runPair(root: string, config = CONFIG, key = KEY): ExchangeFilePaths {
  const workdir = path.join(root, "run");
  fs.mkdirSync(workdir, { recursive: true });
  const pair = {
    configPath: path.join(workdir, JOB_FILE_NAMES.config),
    keyPath: path.join(workdir, JOB_FILE_NAMES.key),
  };
  fs.writeFileSync(pair.configPath, config);
  fs.writeFileSync(pair.keyPath, key);
  return pair;
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
  test("copies the run's pair owner-only into an empty folder", () => {
    const root = folder();
    const written = writeWorkingFolderExchangeFiles(root, runPair(root));
    expect(written).toEqual(workingFolderExchangeFilePaths(root));
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
    expect(workingFolderExchangeFilesPresent(root)).toEqual({
      config: false,
      key: true,
    });
    expect(
      refusal(() => writeWorkingFolderExchangeFiles(root, runPair(root))),
    ).toBe("present");
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(root, JOB_FILE_NAMES.config))).toBe(false);
  });

  test("a key file already there is never replaced, whatever it holds", () => {
    const root = folder();
    fs.writeFileSync(path.join(root, JOB_FILE_NAMES.key), KEY);
    expect(
      refusal(() => writeWorkingFolderExchangeFiles(root, runPair(root))),
    ).toBe("present");
    expect(fs.readdirSync(root).sort()).toEqual([JOB_FILE_NAMES.key, "run"]);
  });

  test("a folder that refuses the write is unwritable, leaving nothing", () => {
    const root = folder();
    const source = runPair(root);
    const notAFolder = path.join(root, "not-a-folder");
    fs.writeFileSync(notAFolder, "");
    expect(
      refusal(() => writeWorkingFolderExchangeFiles(notAFolder, source)),
    ).toBe("unwritable");
  });
});

describe("refreshWorkingFolderExchangeFiles", () => {
  test("brings the folder's pair up to date with the run's, owner-only", () => {
    const root = folder();
    const source = runPair(root);
    const target = writeWorkingFolderExchangeFiles(root, source);
    fs.writeFileSync(source.configPath, `${CONFIG}signing: {}\n`);
    fs.writeFileSync(source.keyPath, JSON.stringify({ sharedSecret: "two" }));
    refreshWorkingFolderExchangeFiles(source, target);
    expect(fs.readFileSync(target.configPath, "utf8")).toBe(
      `${CONFIG}signing: {}\n`,
    );
    expect(JSON.parse(fs.readFileSync(target.keyPath, "utf8"))).toEqual({
      sharedSecret: "two",
    });
    for (const file of [target.configPath, target.keyPath])
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root).sort()).toEqual(
      [JOB_FILE_NAMES.key, JOB_FILE_NAMES.config, "run"].sort(),
    );
  });

  test("a file moved out of the folder is not written again", () => {
    const root = folder();
    const source = runPair(root);
    const target = writeWorkingFolderExchangeFiles(root, source);
    fs.rmSync(target.configPath);
    fs.writeFileSync(source.configPath, "changed\n");
    refreshWorkingFolderExchangeFiles(source, target);
    expect(fs.existsSync(target.configPath)).toBe(false);
  });

  test("a run folder already removed copies nothing", () => {
    const root = folder();
    const source = runPair(root);
    const target = writeWorkingFolderExchangeFiles(root, source);
    fs.rmSync(path.dirname(source.configPath), { recursive: true });
    refreshWorkingFolderExchangeFiles(source, target);
    expect(fs.readFileSync(target.configPath, "utf8")).toBe(CONFIG);
  });
});
