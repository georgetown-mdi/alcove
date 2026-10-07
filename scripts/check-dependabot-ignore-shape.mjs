#!/usr/bin/env node
// Dependabot ignore-shape check: `npm run check:dependabot-ignore-shape`, run
// by static_checks.yaml on every pull request. Reads the `github-actions`
// block's `ignore` entries in .github/dependabot.yml and every action pin
// under .github/workflows and .github/actions, and fails unless:
//
//   A pin whose name is covered by a `github-actions` `ignore` entry that
//   suppresses within-major updates names a bare floating major tag.
//
// An entry suppresses within-major updates when its `update-types` names
// `version-update:semver-minor` or `version-update:semver-patch`, or names no
// update type. An entry's `*` matches across `/`. Exit 0 clean, 1 on a finding
// or when no github-actions block or no workflow action reference is found.
// Rationale and limits:
// docs/notes/repo-check-scripts.md.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { coversDependencyName } from "./lib/dependabot.mjs";
import { WORKFLOW_DIR, treeReferences } from "./lib/workflows.mjs";

const CONFIG_FILE = ".github/dependabot.yml";
const ECOSYSTEM = "github-actions";
const WITHIN_MAJOR_UPDATE_TYPES = [
  "version-update:semver-minor",
  "version-update:semver-patch",
];
const FLOATING_MAJOR = /^v\d+$/;

/**
 * The `ignore` entries the `github-actions` update block declares, as
 * `{dependencyName, updateTypes}` pairs in config order, or null when the source
 * has no `github-actions` block at all. A null `updateTypes` is an entry
 * naming no update type.
 */
export function githubActionsIgnoreEntries(source) {
  const updates = parse(source)?.updates;
  const block = (Array.isArray(updates) ? updates : []).find(
    (candidate) => candidate?.["package-ecosystem"] === ECOSYSTEM,
  );
  if (!block) return null;
  const ignore = Array.isArray(block.ignore) ? block.ignore : [];
  return ignore.flatMap((entry) => {
    const dependencyName = entry?.["dependency-name"];
    if (typeof dependencyName !== "string") return [];
    const updateTypes = entry["update-types"];
    return [
      {
        dependencyName,
        updateTypes: Array.isArray(updateTypes) ? updateTypes : null,
      },
    ];
  });
}

/**
 * Whether an ignore entry suppresses updates within a major version. An entry
 * naming no update type suppresses every update, within-major included.
 */
export function suppressesWithinMajor({ updateTypes }) {
  if (updateTypes === null) return true;
  return updateTypes.some((type) => WITHIN_MAJOR_UPDATE_TYPES.includes(type));
}

/**
 * Whether a ref is a bare floating major tag -- the shape a within-major ignore
 * entry's rationale assumes of every pin it covers.
 */
export function isFloatingMajor(ref) {
  return FLOATING_MAJOR.test(ref);
}

/**
 * Every pin covered by a within-major ignore entry whose ref is not a bare
 * floating major, as message strings. Empty means the ignore list and the pin
 * shapes it covers agree.
 */
export function shapeViolations(references, entries) {
  const suppressing = entries.filter(suppressesWithinMajor);
  const messages = references.flatMap(({ file, name, ref }) => {
    if (ref === null || isFloatingMajor(ref)) return [];
    const entry = suppressing.find(({ dependencyName }) =>
      coversDependencyName(dependencyName, name),
    );
    if (!entry) return [];
    return [
      `${name}@${ref} in ${file} is not pinned to a bare floating major tag, but ${CONFIG_FILE} ignores within-major updates for it under dependency-name "${entry.dependencyName}" -- so nothing will ever open a pull request moving this pin off @${ref}, however many fixes land within the major. Re-pin it to the floating major tag that entry assumes (${name}@v<major>), or drop or narrow the entry so this pin's within-major bumps surface.`,
    ];
  });
  return [...new Set(messages)];
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entries = githubActionsIgnoreEntries(
    readFileSync(resolve(root, CONFIG_FILE), "utf8"),
  );
  if (entries === null) {
    console.error(
      `${CONFIG_FILE}: no ${ECOSYSTEM} update block was found. If you reshaped that block, update the pattern in scripts/check-dependabot-ignore-shape.mjs to read the new form; if Dependabot no longer covers GitHub Actions, delete this check.`,
    );
    process.exit(1);
  }
  const { workflowReferences, actionReferences } = treeReferences(root);
  if (workflowReferences.length === 0) {
    console.error(
      `${WORKFLOW_DIR}: no action reference was found in any workflow. If you changed how workflows write \`uses:\` lines, update the reading in scripts/lib/workflows.mjs to match.`,
    );
    process.exit(1);
  }
  const references = [...workflowReferences, ...actionReferences];
  const violations = shapeViolations(references, entries);
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  const pins = `${references.length} pin${references.length === 1 ? "" : "s"}`;
  const suppressing = entries.filter(suppressesWithinMajor).length;
  console.log(
    `Dependabot ignore shape check passed: ${pins} checked against ${suppressing} of ${entries.length} ${ECOSYSTEM} ignore entries in ${CONFIG_FILE}, the ones suppressing within-major updates.`,
  );
}
