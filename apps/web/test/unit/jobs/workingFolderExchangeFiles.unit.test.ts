import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  WorkingFolderFilesRefusedError,
  createWorkingFolderExchangeFiles,
  invitationIdOf,
  removeUnchangedWorkingFolderExchangeFiles,
  workingFolderExchangeFileDigests,
  workingFolderExchangeFilesMatch,
  workingFolderExchangeFilesPresent,
} from "@jobs/workingFolderExchangeFiles";
import { JOB_FILE_NAMES } from "@jobContract/intentSchemas";

import { tempDataRoot } from "../../utils/jobFixtures";

const SECRET = "A".repeat(43);
const CONFIG = "connection:\n  channel: webrtc\n";
const KEY = JSON.stringify({ sharedSecret: SECRET });
const ROTATED_KEY = JSON.stringify({ sharedSecret: "C".repeat(42) + "A" });

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

describe("createWorkingFolderExchangeFiles", () => {
  test("writes the pair owner-only into an empty folder", () => {
    const root = folder();
    const written = createWorkingFolderExchangeFiles(root, {
      config: CONFIG,
      key: KEY,
    });
    const configPath = path.join(root, JOB_FILE_NAMES.config);
    const keyPath = path.join(root, JOB_FILE_NAMES.key);
    expect(fs.readFileSync(configPath, "utf8")).toBe(CONFIG);
    expect(fs.readFileSync(keyPath, "utf8")).toBe(KEY);
    for (const file of [configPath, keyPath])
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(workingFolderExchangeFileDigests(root)).toEqual(written);
  });

  test.each([JOB_FILE_NAMES.config, JOB_FILE_NAMES.key])(
    "a link at %s, live or dangling, is refused and not followed",
    (name) => {
      const root = folder();
      const outside = path.join(root, "outside");
      fs.mkdirSync(outside);
      const live = path.join(outside, "live");
      fs.writeFileSync(live, "the operator's file\n");
      for (const target of [live, path.join(outside, "dangling")]) {
        fs.symlinkSync(target, path.join(root, name));
        expect(workingFolderExchangeFilesPresent(root)).toBe(true);
        expect(
          refusal(() =>
            createWorkingFolderExchangeFiles(root, {
              config: CONFIG,
              key: KEY,
            }),
          ),
        ).toBe("present");
        expect(fs.readdirSync(root).sort()).toEqual([name, "outside"].sort());
        fs.rmSync(path.join(root, name));
      }
      expect(fs.readFileSync(live, "utf8")).toBe("the operator's file\n");
      expect(fs.readdirSync(outside)).toEqual(["live"]);
    },
  );

  test("a key file already there is never replaced, and no configuration is left", () => {
    const root = folder();
    fs.writeFileSync(path.join(root, JOB_FILE_NAMES.key), ROTATED_KEY);
    expect(
      refusal(() =>
        createWorkingFolderExchangeFiles(root, { config: CONFIG, key: KEY }),
      ),
    ).toBe("present");
    expect(fs.readdirSync(root)).toEqual([JOB_FILE_NAMES.key]);
    expect(fs.readFileSync(path.join(root, JOB_FILE_NAMES.key), "utf8")).toBe(
      ROTATED_KEY,
    );
  });

  test("a folder that refuses the write is unwritable", () => {
    const root = folder();
    const notAFolder = path.join(root, "not-a-folder");
    fs.writeFileSync(notAFolder, "");
    expect(
      refusal(() =>
        createWorkingFolderExchangeFiles(notAFolder, {
          config: CONFIG,
          key: KEY,
        }),
      ),
    ).toBe("unwritable");
  });
});

describe("workingFolderExchangeFilesMatch", () => {
  test("matches the bytes recorded, or a key file holding the invitation's original secret", () => {
    const root = folder();
    const written = createWorkingFolderExchangeFiles(root, {
      config: CONFIG,
      key: KEY,
    });
    const invitation = invitationIdOf(SECRET);
    expect(workingFolderExchangeFilesMatch(root, written, invitation)).toBe(
      true,
    );
    // The same secret in other bytes: the original secret still identifies it.
    fs.writeFileSync(
      path.join(root, JOB_FILE_NAMES.key),
      JSON.stringify({
        sharedSecret: SECRET,
        expires: "2030-01-01T00:00:00.000Z",
      }),
    );
    expect(workingFolderExchangeFilesMatch(root, written, invitation)).toBe(
      true,
    );
    expect(
      workingFolderExchangeFilesMatch(
        root,
        written,
        invitationIdOf("B".repeat(42) + "A"),
      ),
    ).toBe(false);
  });

  test("another configuration, another key, a missing file or a link does not match", () => {
    const root = folder();
    const written = createWorkingFolderExchangeFiles(root, {
      config: CONFIG,
      key: KEY,
    });
    const invitation = invitationIdOf(SECRET);
    const configPath = path.join(root, JOB_FILE_NAMES.config);
    const keyPath = path.join(root, JOB_FILE_NAMES.key);

    fs.writeFileSync(configPath, `${CONFIG}# edited\n`);
    expect(workingFolderExchangeFilesMatch(root, written, invitation)).toBe(
      false,
    );
    fs.writeFileSync(configPath, CONFIG);

    fs.writeFileSync(keyPath, ROTATED_KEY);
    expect(workingFolderExchangeFilesMatch(root, written, invitation)).toBe(
      false,
    );

    fs.rmSync(keyPath);
    expect(workingFolderExchangeFilesMatch(root, written, invitation)).toBe(
      false,
    );

    const copy = path.join(root, "copy");
    fs.writeFileSync(copy, KEY);
    fs.symlinkSync(copy, keyPath);
    expect(workingFolderExchangeFilesMatch(root, written, invitation)).toBe(
      false,
    );
  });
});

describe("removeUnchangedWorkingFolderExchangeFiles", () => {
  test("removes a pair with the bytes written", () => {
    const root = folder();
    const written = createWorkingFolderExchangeFiles(root, {
      config: CONFIG,
      key: KEY,
    });
    expect(removeUnchangedWorkingFolderExchangeFiles(root, written)).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test.each([
    [JOB_FILE_NAMES.config, `${CONFIG}# edited\n`],
    [JOB_FILE_NAMES.key, ROTATED_KEY],
  ])("leaves both files when %s changed", (name, content) => {
    const root = folder();
    const written = createWorkingFolderExchangeFiles(root, {
      config: CONFIG,
      key: KEY,
    });
    fs.writeFileSync(path.join(root, name), content);
    expect(removeUnchangedWorkingFolderExchangeFiles(root, written)).toBe(
      false,
    );
    expect(fs.readdirSync(root).sort()).toEqual(
      [JOB_FILE_NAMES.config, JOB_FILE_NAMES.key].sort(),
    );
    expect(fs.readFileSync(path.join(root, name), "utf8")).toBe(content);
  });
});
