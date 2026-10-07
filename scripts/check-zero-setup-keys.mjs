#!/usr/bin/env node
// Zero-setup key-field check: `npm run check:zero-setup-keys
// [-- --root <tree>]`, run by static_checks.yaml on every pull request. Holds
// docs/notes/default-linkage-rule-set.md's "What zero-setup rests on": every
// built-in key is built from the guaranteed-minimum fields both parties bring.
// Reads each set the registry in
// packages/core/src/defaults/builtInLinkageTerms.ts declares, not the default
// alone, and fails unless, for each element of each key:
//
//   A. its `field` names a field its own set declares, so a key over
//      `phone_number`, `email_address` or `zip_code` fails; and
//   B. that field's `name` equals its `type`, since the satisfiability filter
//      matches an element's `field` against the semantic types a file supplies.
//
// Takes the declared field set as the guaranteed minimum, and reads the sets,
// not the terms builder over them. Exit 0 clean, 1 on a finding or a set it
// cannot read, 2 on a usage error. Rationale and limits:
// docs/notes/repo-check-scripts.md.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REGISTRY_DECLARATION,
  RULE_SET_SOURCE,
  readRuleSetsFrom,
} from "./lib/builtInRuleSets.mjs";

export { RULE_SET_SOURCE };

/** The note stating the property, named by every failure this check reports. */
export const NOTE_SECTION =
  'docs/notes/default-linkage-rule-set.md, "What zero-setup rests on"';

/**
 * The reasons a key leaves its own set's field set, as `{kind, message}`; empty
 * when every key of every set stays inside it. `kind` is `outside` (an element
 * names no declared field) or `unbindable` (it names one a derived input can
 * never supply).
 */
export function keyFieldViolations(ruleSets) {
  const violations = [];
  for (const { fieldSet, keySet } of ruleSets) {
    const declared = new Map(
      fieldSet.content.map((field) => [field.name, field]),
    );
    for (const key of keySet.content) {
      for (const element of key.elements) {
        const field = declared.get(element.field);
        if (field === undefined) {
          violations.push({
            kind: "outside",
            message: `Key "${key.name}" of ${keySet.name} matches on \`${element.field}\`, which ${fieldSet.name} does not declare. A party derives its terms from its own file, so a built-in key over a field outside the guaranteed minimum strands whoever does not carry it. Build the key from the declared fields, or take the decision to widen ${fieldSet.name} (${NOTE_SECTION}).`,
          });
        } else if (field.type !== field.name) {
          violations.push({
            kind: "unbindable",
            message: `Key "${key.name}" of ${keySet.name} matches on \`${element.field}\`, which ${fieldSet.name} declares with type \`${field.type}\`. A party's input satisfies a key element by semantic TYPE, so a field whose name is not its type is one no file supplies and every key over it is dropped from the derived terms (${NOTE_SECTION}).`,
          });
        }
      }
    }
  }
  return violations;
}

/**
 * Read the tree at `root` and report what the property holds there, as
 * `{ruleSets, violations, blocked}`. `blocked` contains the reasons the check
 * could not read a declaration at all, which fail rather than passing as an
 * empty set.
 */
export function inspect(root) {
  const { ruleSets, unreadable } = readRuleSetsFrom(root);
  const blocked = unreadable.map(({ declaration, reason }) =>
    declaration === RULE_SET_SOURCE
      ? `${RULE_SET_SOURCE} could not be read: ${reason}. A set this check cannot read is one it cannot hold anything to.`
      : `${RULE_SET_SOURCE}'s \`${declaration}\` could not be read: ${reason}. A set this check cannot read is one it cannot hold anything to.`,
  );
  return {
    ruleSets,
    violations: blocked.length === 0 ? keyFieldViolations(ruleSets) : [],
    blocked,
  };
}

/**
 * One line per field of each set's guaranteed minimum, and one naming the keys
 * held to it. Reported on every passing run so the substrate the whole property
 * rests on is read rather than inferred.
 */
export function substrateReport({ ruleSets }) {
  return ruleSets.flatMap(({ fieldSet, keySet }) => [
    ...fieldSet.content.map(
      (field) => `  ${fieldSet.name}  ${field.name} -- type ${field.type}`,
    ),
    `  ${keySet.name}  ${keySet.content.length} key${keySet.content.length === 1 ? "" : "s"}, every element inside ${fieldSet.name}`,
  ]);
}

// CLI entry: only runs when invoked directly, so the tests can import the pure
// functions without the process.exit. `--root` points the run at another tree,
// which is how the tests drive a set this repository does not hold.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  if (rootFlag !== -1 && args[rootFlag + 1] === undefined) {
    console.error(
      "usage: node scripts/check-zero-setup-keys.mjs [--root <tree>]",
    );
    process.exit(2);
  }
  const root =
    rootFlag === -1
      ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
      : resolve(args[rootFlag + 1]);

  const report = inspect(root);
  if (report.blocked.length > 0) {
    console.error("Zero-setup key-field check could not run:\n");
    for (const reason of report.blocked) console.error("  " + reason);
    process.exit(1);
  }

  if (report.violations.length > 0) {
    console.error("Zero-setup key-field check failed:\n");
    for (const { message } of report.violations) console.error("  " + message);
    process.exit(1);
  }

  for (const line of substrateReport(report)) console.log(line);
  console.log(
    `\nZero-setup key-field check passed: across the ${report.ruleSets.length} rule set${report.ruleSets.length === 1 ? "" : "s"} ${REGISTRY_DECLARATION} declares, every element of every key names a field its own set declares and a derived input can supply by type.`,
  );
}
