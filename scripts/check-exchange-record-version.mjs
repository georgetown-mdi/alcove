#!/usr/bin/env node
// The two obligations on EXCHANGE_RECORD_VERSION: `npm run
// check:exchange-record-version`, run by static_checks.yaml on every PR. Reads
// the literal out of packages/core/src/records/exchangeRecord.ts (not the built
// package: this runs before any build), the recovery sources
// RECOVERY_ENTRY_POINTS names, and the release marker apps/cli/package.json's
// version, through lib/releaseManifest.mjs.
//
// Rule 1, the bump. A move with no migration step from the version before it
// leaves every managed accounting of disclosures at rest in a browser
// unreadable (docs/spec/MANAGED_EXCHANGE_RECORD.md), and its recovery
// has been driven against RECORD_VERSION_PIN alone. So a literal off the pin
// fails, naming the steps to take before recording the new value: re-drive the
// envelope/entries split (apps/web/test/unit/psi/disclosureAccounting.test.ts),
// re-check both recovery arms are reachable in order
// (apps/web/test/browser/managedExchangeDetail.test.ts), restate what the bump
// does to a stored accounting in the spec and docs/MANAGED_EXCHANGE.md if it
// changed, then set RECORD_VERSION_PIN. Each RECOVERY_ENTRY_POINTS function no
// longer exported also fails.
//
// Rule 2, the reset. The first release at COMPATIBILITY_RELEASE or above, the
// marker from which the compatibility policy binds, ships the counter at
// RESET_RECORD_VERSION. Before it, the literal at that value fails; from it, the
// check fails until the literal is at that value and RESET_TAKEN_AT_RELEASE
// records the release that took the reset, which retires the rule. A recorded
// release below COMPATIBILITY_RELEASE or ahead of the marker fails. The steps
// are docs/RELEASES.md, "Reset the exchange-record format at 1.0.0".
//
// RECORD_VERSION_PIN and RESET_TAKEN_AT_RELEASE are constants in this file, so
// recording either is an edit a reviewer sees. `--root <tree>` reads another
// tree. Exit 0 when the tree meets both rules; 1 on a violation or an input it
// cannot read (a marker that is not a release version, a literal that is not a
// quoted string); 2 on `--root` naming no tree. Rationale and what the check
// cannot see: docs/notes/repo-check-scripts.md.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  obligationRoot,
  reportBlocked,
  reportViolations,
} from "./lib/deferredObligation.mjs";
import {
  COMPATIBILITY_RELEASE,
  RELEASE_MANIFEST,
  compareReleaseVersions,
  isCompatibilityRelease,
  manifestVersion,
} from "./lib/releaseManifest.mjs";

export { COMPATIBILITY_RELEASE, RELEASE_MANIFEST };

/** Where the record version literal is declared. */
export const RECORD_VERSION_SOURCE =
  "packages/core/src/records/exchangeRecord.ts";

/** This file, named by every failure that asks for an edit to it. */
export const CHECK_SOURCE = "scripts/check-exchange-record-version.mjs";

/** The exchange-record version the recovery path has been driven against. Moving
 * it here is how the bump decision this check defers is recorded as taken. */
export const RECORD_VERSION_PIN = "alcove-exchange-record/v11";

/** The entry points the recovery from a version-invalidated accounting is built
 * on, per file. Named functions rather than a surface description: a declaration
 * is a fact this check can read, where "the affordance is reachable" is not. */
export const RECOVERY_ENTRY_POINTS = {
  "apps/web/src/psi/disclosureAccounting.ts": [
    "parseStoredDisclosureAccounting",
  ],
  "apps/web/src/psi/disclosureAccountingStore.ts": [
    "readDisclosureAccounting",
    "resetDisclosureAccounting",
  ],
};

/** The record format literal the first release at COMPATIBILITY_RELEASE ships. */
export const RESET_RECORD_VERSION = "alcove-exchange-record/v1";

/** The Release Checklist heading holding the obligations this check cannot
 * read: the artifacts to clear, and the order the reset is taken in. */
export const CHECKLIST_HEADING = "Reset the exchange-record format at 1.0.0";

/** That heading as every failure names it. */
export const CHECKLIST_STEP = `docs/RELEASES.md, "${CHECKLIST_HEADING}"`;

/**
 * The release the reset was taken at, or undefined while it has not been taken.
 * Recording it here retires the reset rule.
 */
export const RESET_TAKEN_AT_RELEASE = undefined;

/**
 * The exchange-record version literal declared in the given source, or
 * `undefined` when the declaration is not a quoted string this can read.
 */
export function declaredRecordVersion(source) {
  const match = /export const EXCHANGE_RECORD_VERSION\s*=\s*"([^"]*)"/.exec(
    source,
  );
  return match === null ? undefined : match[1];
}

/**
 * The recovery entry points a source does not declare, as `{file, name}` pairs;
 * empty when every one of them is exported from the file that should hold it.
 */
export function missingRecoveryEntryPoints(sources) {
  const missing = [];
  for (const [file, names] of Object.entries(RECOVERY_ENTRY_POINTS)) {
    const source = sources[file] ?? "";
    for (const name of names) {
      const declared = new RegExp(
        `export\\s+(?:async\\s+)?function\\s+${name}\\b`,
      );
      if (!declared.test(source)) missing.push({ file, name });
    }
  }
  return missing;
}

/**
 * The reasons the tree breaks rule 1, as
 * `{kind, message}`; empty when the record version is where the recovery was
 * driven against it and the recovery is still there to defer to. `declared` is
 * the literal read from the tree, which `inspect` blocks on when it is
 * unreadable. `kind` is `moved` (the literal is off the pin) or `recovery` (an
 * entry point the deferral points at is gone). Each reason names the obligation
 * rather than only the mismatch, since the point of the failure is the
 * decision, not the diff.
 */
export function bumpViolations(declared, sources) {
  const violations = [];
  if (declared !== RECORD_VERSION_PIN) {
    violations.push({
      kind: "moved",
      message: [
        `${RECORD_VERSION_SOURCE}: EXCHANGE_RECORD_VERSION moved from "${RECORD_VERSION_PIN}" to "${declared}".`,
        "",
        "A move invalidates every accounting of disclosures already at rest in a browser: the accounting's read refuses the whole value, and so does the append inside it, so a scheduled exchange goes on disclosing and files nothing. The recovery offered for that state is the stored-form export and the accounting-scoped reset, and its export arm exists only while a move leaves the accounting ENVELOPE readable with the stored entries returned verbatim.",
        "",
        "That assumption has been driven against the pinned version and no other. Before recording the new one:",
        "  - re-drive the split against the moved format (apps/web/test/unit/psi/disclosureAccounting.test.ts), so the export arm is known to still have entries to hand over;",
        "  - re-check that both arms are reachable from the unreadable state, in order (apps/web/test/browser/managedExchangeDetail.test.ts);",
        "  - state what the bump does to a stored accounting in docs/spec/MANAGED_EXCHANGE_RECORD.md and docs/MANAGED_EXCHANGE.md if the answer changed;",
        `  - then set RECORD_VERSION_PIN in ${CHECK_SOURCE} to "${declared}".`,
      ].join("\n"),
    });
  }
  violations.push(...recoveryViolations(sources));
  return violations;
}

/**
 * The reasons there is nothing left for rule 1 to defer to, as
 * `{kind, message}`; empty when every entry point is exported from the file
 * that should hold it. It reads the recovery sources and nothing else, so an
 * input the other rules cannot read does not withhold it: a tree that lost both
 * reports both.
 */
export function recoveryViolations(sources) {
  return missingRecoveryEntryPoints(sources).map(({ file, name }) => ({
    kind: "recovery",
    message: `${file}: "${name}" is no longer exported. Restore the export, or remove rule 1 from ${CHECK_SOURCE}: it defers a version-bump decision to the recovery path from a version-invalidated accounting of disclosures, and without this entry point there is nothing to defer to, so a bump would leave every stored accounting with no recovery.`,
  }));
}

/**
 * The reasons the tree breaks rule 2, as `{kind, message}`; empty when it
 * meets it. `kind` is `discharge` (the recorded RESET_TAKEN_AT_RELEASE names
 * no release at or above COMPATIBILITY_RELEASE, or one ahead of the marker), `early` (the reset
 * landed before the release that publishes it), `due` (the reset is due and the
 * literal is elsewhere), or `record` (the reset landed and is not recorded).
 */
export function resetViolations({
  bound,
  releaseVersion,
  declared,
  takenAtRelease,
}) {
  const violations = [];

  if (takenAtRelease !== undefined) {
    if (isCompatibilityRelease(takenAtRelease) !== true) {
      violations.push({
        kind: "discharge",
        message: `${CHECK_SOURCE} records the reset as taken at "${takenAtRelease}", which is not a release at or above ${COMPATIBILITY_RELEASE}. Set RESET_TAKEN_AT_RELEASE to the release that shipped the reset, or back to undefined if no release has: any other value would turn this rule off before the reset is taken.`,
      });
    } else {
      const compared = compareReleaseVersions(takenAtRelease, releaseVersion);
      if (compared === undefined || compared > 0) {
        violations.push({
          kind: "discharge",
          message: `${CHECK_SOURCE} records the reset as taken at "${takenAtRelease}", ahead of the ${releaseVersion === undefined ? "version-less" : `"${releaseVersion}"`} ${RELEASE_MANIFEST} names. Set RESET_TAKEN_AT_RELEASE back to undefined until ${RELEASE_MANIFEST} names that release: it records a release that has shipped the reset.`,
        });
      }
    }
    return violations;
  }

  if (!bound) {
    if (declared === RESET_RECORD_VERSION) {
      violations.push({
        kind: "early",
        message: [
          `${RECORD_VERSION_SOURCE}: EXCHANGE_RECORD_VERSION is already "${RESET_RECORD_VERSION}" while ${RELEASE_MANIFEST} names ${releaseVersion}, below ${COMPATIBILITY_RELEASE}.`,
          "",
          "The counter has been through that value once already, so a development artifact written under the old one parses as the current version and then fails on its field set, instead of taking the clean version refusal the reader is built to give.",
          "",
          `The reset belongs to the release that publishes it: move the literal forward on the development counter, and set it to "${RESET_RECORD_VERSION}" in the release branch that takes ${RELEASE_MANIFEST} to ${COMPATIBILITY_RELEASE} or above (${CHECKLIST_STEP}).`,
        ].join("\n"),
      });
    }
    return violations;
  }

  if (declared !== RESET_RECORD_VERSION) {
    violations.push({
      kind: "due",
      message: [
        `${RELEASE_MANIFEST} names ${releaseVersion}, a release at or above ${COMPATIBILITY_RELEASE}, and ${RECORD_VERSION_SOURCE} declares EXCHANGE_RECORD_VERSION "${declared}".`,
        "",
        `The release at ${COMPATIBILITY_RELEASE} or above ships the record format at "${RESET_RECORD_VERSION}": the counter moved freely before the compatibility policy bound, and from this release it is held to it.`,
        "",
        `Take the reset as one piece (${CHECKLIST_STEP}):`,
        `  - set EXCHANGE_RECORD_VERSION to "${RESET_RECORD_VERSION}" in ${RECORD_VERSION_SOURCE};`,
        "  - regenerate the record vectors through their generator, which `npm run check:vectors` compares them against;",
        `  - re-take the recovery obligations rule 1 names and re-record RECORD_VERSION_PIN in ${CHECK_SOURCE}, which fails on its own once the literal moves;`,
        "  - clear the development artifacts the checklist step enumerates, which a downward move leaves misread rather than refused;",
        `  - record the reset: RESET_TAKEN_AT_RELEASE = "${releaseVersion}" in ${CHECK_SOURCE}.`,
      ].join("\n"),
    });
    return violations;
  }

  violations.push({
    kind: "record",
    message: [
      `${RECORD_VERSION_SOURCE} declares EXCHANGE_RECORD_VERSION "${RESET_RECORD_VERSION}" and ${RELEASE_MANIFEST} names release ${releaseVersion}, at or above ${COMPATIBILITY_RELEASE}, but ${CHECK_SOURCE} records no RESET_TAKEN_AT_RELEASE.`,
      "",
      `Once the rest of the checklist step is met -- the vectors regenerated, RECORD_VERSION_PIN re-recorded, and the development artifacts cleared -- set RESET_TAKEN_AT_RELEASE to "${releaseVersion}" in ${CHECK_SOURCE}. The reset is taken once, and recording it retires this rule, so an ordinary forward bump after this release passes (${CHECKLIST_STEP}).`,
    ].join("\n"),
  });
  return violations;
}

/**
 * Read the tree at `root` and report what both rules find there, as
 * `{bound, releaseVersion, declared, takenAtRelease, violations, blocked}`.
 * `blocked` lists the reasons an input could not be read at all, which fail
 * rather than passing as inert. A blocked run still reports the recovery
 * violations, which rest on no input it is blocked on.
 */
export function inspect(root) {
  const read = (relative) => readFileSync(resolve(root, relative), "utf8");
  // A recovery source that is gone entirely is the loudest form of the failure
  // rule 1 reports, so it is treated as no declarations rather than as an ENOENT: the
  // throw would exit non-zero with the diagnostic lost, which is exactly the
  // tree where naming the missing entry point matters most.
  const readIfPresent = (relative) => {
    try {
      return read(relative);
    } catch {
      return "";
    }
  };
  const blocked = [];

  const releaseVersion = manifestVersion(read(RELEASE_MANIFEST));
  const bound = isCompatibilityRelease(releaseVersion);
  if (bound === undefined) {
    blocked.push(
      `${RELEASE_MANIFEST} has ${releaseVersion === undefined ? "no version" : `"${releaseVersion}"`}, which is not a release version this can compare against ${COMPATIBILITY_RELEASE}. Set it to a release version (major.minor.patch); until then this check cannot tell whether the reset is due.`,
    );
  }

  const declared = declaredRecordVersion(read(RECORD_VERSION_SOURCE));
  if (declared === undefined) {
    blocked.push(
      `${RECORD_VERSION_SOURCE}: EXCHANGE_RECORD_VERSION is not declared as a quoted string literal. Declare it as one, or update the pattern in ${CHECK_SOURCE} to read the new form; do not drop the check.`,
    );
  }

  const sources = Object.fromEntries(
    Object.keys(RECOVERY_ENTRY_POINTS).map((file) => [
      file,
      readIfPresent(file),
    ]),
  );

  const violations =
    blocked.length === 0
      ? [
          ...bumpViolations(declared, sources),
          ...resetViolations({
            bound,
            releaseVersion,
            declared,
            takenAtRelease: RESET_TAKEN_AT_RELEASE,
          }),
        ]
      : recoveryViolations(sources);

  return {
    bound,
    releaseVersion,
    declared,
    takenAtRelease: RESET_TAKEN_AT_RELEASE,
    violations,
    blocked,
  };
}

/** This check as its reports name it. */
const LABEL = "Exchange record version check";

// CLI entry: only runs when invoked directly, so the tests can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = inspect(obligationRoot(process.argv.slice(2), CHECK_SOURCE));
  const blocked = reportBlocked(LABEL, report.blocked);
  const failed = reportViolations(LABEL, report.violations);
  if (blocked || failed) process.exit(1);

  console.log(
    `check-exchange-record-version: EXCHANGE_RECORD_VERSION is "${RECORD_VERSION_PIN}", and the recovery path from a version-invalidated accounting is in place.`,
  );
  console.log(
    report.takenAtRelease !== undefined
      ? `check-exchange-record-version: the reset to "${RESET_RECORD_VERSION}" was taken at release ${report.takenAtRelease}, so EXCHANGE_RECORD_VERSION moves under its own rules from here.`
      : `check-exchange-record-version: ${RELEASE_MANIFEST} names ${report.releaseVersion}, below ${COMPATIBILITY_RELEASE}, so EXCHANGE_RECORD_VERSION "${report.declared}" is still a development counter. The release at ${COMPATIBILITY_RELEASE} or above ships "${RESET_RECORD_VERSION}" (${CHECKLIST_STEP}).`,
  );
}
