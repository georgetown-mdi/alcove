import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { PRODUCER, REFERENCE_FILES, revendor } from "./revendor-psi.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_ENTRY = "node_modules/@openmined/psi.js";
const COMMIT = "6ef5f7f21ac5c15bbb3cc9a760f855b66b9d50f5";
const NEW_VERSION = "9.9.9-alcove.7";
const NEW_NAME = `openmined-psi.js-${NEW_VERSION}.tgz`;
const NEW_BYTES = Buffer.from("stand-in tarball bytes\n");

const lock = JSON.parse(
  readFileSync(join(repoRoot, "package-lock.json"), "utf8"),
);
const oldVersion = lock.packages[LOCK_ENTRY].version;
const oldName = `openmined-psi.js-${oldVersion}.tgz`;

let scratch;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

// A copy of the files the script reads, with lib/ as step 1 leaves it: the
// new tarball in place and the old one and its sidecars removed.
function stagedTree({ libFiles = { [NEW_NAME]: NEW_BYTES } } = {}) {
  scratch = mkdtempSync(join(tmpdir(), "revendor-psi-"));
  for (const file of [...REFERENCE_FILES, "package-lock.json"]) {
    mkdirSync(dirname(join(scratch, file)), { recursive: true });
    cpSync(join(repoRoot, file), join(scratch, file));
  }
  mkdirSync(join(scratch, "lib"));
  for (const [name, bytes] of Object.entries(libFiles)) {
    writeFileSync(join(scratch, "lib", name), bytes);
  }
  return scratch;
}

const read = (root, file) => readFileSync(join(root, file), "utf8");

describe("revendor", () => {
  it("writes the armed marker, the sidecar, the lockfile entry and every reference", () => {
    const root = stagedTree();
    const sha256 = createHash("sha256").update(NEW_BYTES).digest("hex");
    const integrity = `sha512-${createHash("sha512").update(NEW_BYTES).digest("base64")}`;

    expect(
      revendor({ root, version: NEW_VERSION, sourceDigest: COMMIT }),
    ).toEqual({ oldName, newName: NEW_NAME, sha256, integrity });

    expect(JSON.parse(read(root, `lib/${NEW_NAME}.provenance.json`))).toEqual({
      attestation_expected: true,
      artifact: NEW_NAME,
      sha256,
      ...PRODUCER,
      source_digest: COMMIT,
    });
    expect(read(root, `lib/${NEW_NAME}.sha256`)).toBe(
      `${sha256}  lib/${NEW_NAME}\n`,
    );

    const written = JSON.parse(read(root, "package-lock.json"));
    expect(written.packages[LOCK_ENTRY]).toMatchObject({
      version: NEW_VERSION,
      resolved: `file:lib/${NEW_NAME}`,
      integrity,
    });
    for (const file of [...REFERENCE_FILES, "package-lock.json"]) {
      const before = read(repoRoot, file);
      const after = read(root, file);
      expect(after, file).not.toContain(oldName);
      expect(after, file).toContain(NEW_NAME);
      if (file !== "package-lock.json") {
        expect(after, file).toBe(before.replaceAll(oldName, NEW_NAME));
      }
    }
  });

  it("changes no lockfile entry but the vendored tarball's", () => {
    const root = stagedTree();
    revendor({ root, version: NEW_VERSION, sourceDigest: COMMIT });
    const written = JSON.parse(read(root, "package-lock.json"));
    const expected = JSON.parse(
      read(repoRoot, "package-lock.json").replaceAll(oldName, NEW_NAME),
    );
    expected.packages[LOCK_ENTRY].version = NEW_VERSION;
    expected.packages[LOCK_ENTRY].integrity =
      written.packages[LOCK_ENTRY].integrity;
    expect(written).toEqual(expected);
  });

  it.each([
    ["a version without the alcove suffix", "2.0.7", COMMIT, /does not match/],
    [
      "a version with a path in it",
      "1.2.3-alcove.1/..",
      COMMIT,
      /does not match/,
    ],
    [
      "the vendored version",
      oldVersion,
      COMMIT,
      /already the vendored version/,
    ],
    ["an abbreviated commit", NEW_VERSION, "6ef5f7f21", /40 lowercase hex/],
  ])("refuses %s and writes nothing", (_, version, sourceDigest, message) => {
    const root = stagedTree();
    const lockBefore = read(root, "package-lock.json");
    expect(() => revendor({ root, version, sourceDigest })).toThrow(message);
    expect(read(root, "package-lock.json")).toBe(lockBefore);
  });

  it("refuses a lib/ that still holds the tarball it replaces", () => {
    const root = stagedTree({
      libFiles: { [NEW_NAME]: NEW_BYTES, [oldName]: Buffer.from("old\n") },
    });
    expect(() =>
      revendor({ root, version: NEW_VERSION, sourceDigest: COMMIT }),
    ).toThrow(/must hold .* alone/);
  });

  it("refuses a lib/ without the new tarball", () => {
    const root = stagedTree({ libFiles: {} });
    expect(() =>
      revendor({ root, version: NEW_VERSION, sourceDigest: COMMIT }),
    ).toThrow(/found no tarball/);
  });
});

describe("REFERENCE_FILES", () => {
  it("lists every tracked file outside lib/ that names the vendored tarball", () => {
    const run = spawnSync("git", ["grep", "-l", "-F", oldName], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const naming = run.stdout
      .split("\n")
      .filter(Boolean)
      .filter(
        (file) =>
          !file.startsWith("lib/") &&
          file !== "package-lock.json" &&
          !file.startsWith("docs/spec/wording-changes/"),
      );
    expect(naming.sort()).toEqual([...REFERENCE_FILES].sort());
  });
});
