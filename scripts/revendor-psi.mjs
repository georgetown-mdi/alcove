#!/usr/bin/env node
// Steps 3 to 5 of docs/PREBUILD_REVENDOR.md, Procedure, for a new vendored
// @openmined/psi.js tarball, as `.github/workflows/psi_revendor.yaml` runs
// them:
//
//   node scripts/revendor-psi.mjs <version> <fork commit>
//
// It expects lib/ to hold the new tarball, `openmined-psi.js-<version>.tgz`,
// and nothing of the one it replaces (step 1), and its attestation to have
// verified against <fork commit> already (step 2): the marker it writes is
// armed for that commit. It writes the marker and the sidecar, renames the
// tarball in every file that names it, and sets the lockfile's version and
// sha512 integrity for it. The reinstall confirmation and the checks of steps
// 5 and 6 stay the caller's. Exit 0 on success, 1 with the reason otherwise.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The version form a re-vendor accepts: upstream semver plus an `alcove.N` suffix. */
export const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}-alcove\.\d{1,4}$/;

const COMMIT = /^[0-9a-f]{40}$/;
const TARBALL = /^openmined-psi\.js-.+\.tgz$/;
const LOCK_ENTRY = "node_modules/@openmined/psi.js";
const CORE_MANIFEST = "packages/core/package.json";
const CORE_SPEC = /^file:\.\.\/\.\.\/lib\/openmined-psi\.js-(.+)\.tgz$/;

/** The producer identity the armed marker records; docs/PREBUILD_REVENDOR.md, step 2. */
export const PRODUCER = {
  producer_repository: "georgetown-mdi/OpenMinedPSI",
  signer_workflow:
    "georgetown-mdi/OpenMinedPSI/.github/workflows/native-prebuilds.yml",
  source_ref: "refs/heads/master",
};

/**
 * Every file besides the lockfile and lib/ that names the vendored tarball by
 * file name. The test beside this script fails when a tracked file names it
 * and is not listed here.
 */
export const REFERENCE_FILES = [
  "CONTRIBUTING.md",
  "NOTICE",
  "apps/cli/package.json",
  "apps/web/package.json",
  "packages/core/package.json",
  "packages/core/test/vectors/psi-prebuild-manifest.json",
];

const tarballName = (version) => `openmined-psi.js-${version}.tgz`;

/**
 * Rewrites the repository at `root` for the tarball of `version`, attested at
 * `sourceDigest`. Throws an Error naming the problem, having written nothing,
 * when the inputs or the tree are not what the procedure leaves at step 2.
 */
export function revendor({ root, version, sourceDigest }) {
  if (!VERSION.test(version)) {
    throw new Error(
      `version '${version}' does not match ${VERSION.source}, the upstream version plus an alcove.N suffix`,
    );
  }
  if (!COMMIT.test(sourceDigest)) {
    throw new Error(
      `fork commit '${sourceDigest}' is not 40 lowercase hex characters`,
    );
  }

  const spec = JSON.parse(readFileSync(join(root, CORE_MANIFEST), "utf8"))
    .dependencies?.["@openmined/psi.js"];
  const oldVersion = typeof spec === "string" && spec.match(CORE_SPEC)?.[1];
  if (!oldVersion) {
    throw new Error(
      `${CORE_MANIFEST} does not name a lib/ tarball for @openmined/psi.js (found ${JSON.stringify(spec)})`,
    );
  }
  if (oldVersion === version) {
    throw new Error(`${version} is already the vendored version`);
  }
  const oldName = tarballName(oldVersion);
  const newName = tarballName(version);

  const tarballs = readdirSync(join(root, "lib")).filter((name) =>
    TARBALL.test(name),
  );
  if (tarballs.length !== 1 || tarballs[0] !== newName) {
    throw new Error(
      `lib/ must hold ${newName} alone, with the tarball it replaces removed; found ${tarballs.join(", ") || "no tarball"}`,
    );
  }

  const bytes = readFileSync(join(root, "lib", newName));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

  const writes = new Map();
  for (const file of REFERENCE_FILES) {
    const text = readFileSync(join(root, file), "utf8");
    if (!text.includes(oldName)) {
      throw new Error(`${file} does not name ${oldName}`);
    }
    writes.set(file, text.replaceAll(oldName, newName));
  }

  const lockText = readFileSync(join(root, "package-lock.json"), "utf8");
  const lock = JSON.parse(lockText.replaceAll(oldName, newName));
  const entry = lock.packages?.[LOCK_ENTRY];
  if (
    entry?.version !== oldVersion ||
    entry.resolved !== `file:lib/${newName}`
  ) {
    throw new Error(
      `package-lock.json's ${LOCK_ENTRY} entry is not the lib/ tarball of ${oldVersion}`,
    );
  }
  entry.version = version;
  entry.integrity = integrity;
  writes.set("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);

  const marker = {
    attestation_expected: true,
    artifact: newName,
    sha256,
    ...PRODUCER,
    source_digest: sourceDigest,
  };
  writes.set(
    `lib/${newName}.provenance.json`,
    `${JSON.stringify(marker, null, 2)}\n`,
  );
  writes.set(`lib/${newName}.sha256`, `${sha256}  lib/${newName}\n`);

  for (const [file, text] of writes) writeFileSync(join(root, file), text);
  return { oldName, newName, sha256, integrity };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version = "", sourceDigest = ""] = process.argv.slice(2);
  try {
    const result = revendor({
      root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      version,
      sourceDigest,
    });
    console.log(
      `Re-vendored ${result.oldName} -> ${result.newName}: sha256 ${result.sha256}, lockfile integrity ${result.integrity}.`,
    );
  } catch (error) {
    console.error(`revendor-psi: ${error.message}`);
    process.exitCode = 1;
  }
}
