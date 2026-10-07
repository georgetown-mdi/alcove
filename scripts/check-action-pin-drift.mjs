#!/usr/bin/env node
// GitHub Action pin drift check: `npm run check:action-pin-drift`, run by
// static_checks.yaml on every pull request. Reads every `uses:` reference under
// .github/workflows and .github/actions and fails on any of three rules:
//
//   A. An action named in both trees has a differing ref anywhere it appears.
//   B. A pin under .github/actions names an action no workflow uses.
//   C. A remote `uses:` reference names no ref.
//
// Refs are compared as text. Exit 0 clean, 1 on a finding. The mirror
// invariant it enforces: docs/spec/DEPENDENCY_PINS.md. Rationale and limits:
// docs/notes/repo-check-scripts.md.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ACTION_DIR, WORKFLOW_DIR, treeReferences } from "./lib/workflows.mjs";

const isPinned = ({ ref }) => ref !== null;

const byName = (pins) => {
  const groups = new Map();
  for (const pin of pins) {
    const group = groups.get(pin.name);
    if (group) group.push(pin);
    else groups.set(pin.name, [pin]);
  }
  return groups;
};

// "@v7 (a.yaml, b.yaml), @v6 (setup/action.yml)" -- each distinct ref once, with
// every file it came from, so a failure names the files to edit.
function describeRefs(pins) {
  const files = new Map();
  for (const { ref, file } of pins) {
    const seen = files.get(ref);
    if (seen) seen.add(file);
    else files.set(ref, new Set([file]));
  }
  return [...files]
    .map(([ref, from]) => `@${ref} (${[...from].join(", ")})`)
    .join(", ");
}

/**
 * Every way the two trees' references can be out of step, as message strings.
 * Empty means every reference names a ref and each composite pin mirrors a
 * workflow pin exactly.
 */
export function pinViolations(workflowReferences, actionReferences) {
  const violations = [...workflowReferences, ...actionReferences]
    .filter((reference) => !isPinned(reference))
    .map(
      ({ file, name }) =>
        `${name} in ${file} names no ref -- an unpinned remote reference fixes no version, so nothing here determines which code the step runs and no release or advisory has an occurrence to be reported against. Write it as owner/action@ref.`,
    );
  const workflowsByName = byName(workflowReferences.filter(isPinned));

  for (const [name, composite] of byName(actionReferences.filter(isPinned))) {
    const workflow = workflowsByName.get(name);
    if (!workflow) {
      violations.push(
        `${name} is pinned only under ${ACTION_DIR}: ${describeRefs(composite)} -- no workflow under ${WORKFLOW_DIR} uses it, and the github-actions Dependabot block is configured against ${WORKFLOW_DIR}, so this pin has no occurrence there for a release or advisory to be reported against. Mirror it into a workflow that legitimately uses the action, or extend Dependabot coverage to ${ACTION_DIR}.`,
      );
      continue;
    }
    const both = [...workflow, ...composite];
    if (new Set(both.map((pin) => pin.ref)).size === 1) continue;
    violations.push(
      `${name} is pinned at differing refs across ${WORKFLOW_DIR} and ${ACTION_DIR}: ${describeRefs(both)} -- a composite pin is tracked only through the workflow pin it mirrors, so bump every occurrence to one ref.`,
    );
  }

  return violations;
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { workflowReferences, actionReferences } = treeReferences(root);
  if (workflowReferences.length === 0) {
    console.error(
      `${WORKFLOW_DIR}: no action reference was found in any workflow. If you changed how workflows write \`uses:\` lines, update the reading in scripts/lib/workflows.mjs to match.`,
    );
    process.exit(1);
  }
  const violations = pinViolations(workflowReferences, actionReferences);
  if (violations.length > 0) {
    for (const violation of violations) console.error(violation);
    process.exit(1);
  }
  const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  console.log(
    `Action pin drift check passed: ${plural(actionReferences.length, "pin")} under ${ACTION_DIR} checked against ${plural(workflowReferences.length, "pin")} under ${WORKFLOW_DIR}.`,
  );
}
