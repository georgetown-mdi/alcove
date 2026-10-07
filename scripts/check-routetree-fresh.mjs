#!/usr/bin/env node
// Route tree freshness check: `npm run check:routetree`, run by
// static_checks.yaml on every pull request. The checked-in
// apps/web/src/routeTree.gen.ts must match, byte for byte, what the TanStack
// Router codegen the lockfile pins produces. The codegen is triggered by
// REGENERATE_COMMAND, a `vitest list` that loads apps/web/vite.config.ts, over a
// copy of the file with a probe line appended; a probe still there afterwards
// fails the check, since the codegen did not run. The working-tree bytes are
// written back whatever the outcome, on SIGINT and SIGTERM too, through
// scripts/lib/regenerationChecks.mjs. Not safe against another process running
// the web tooling at the same time, such as a live `npm run dev`.
//
// Exit 0 clean, 1 when the file is absent or differs, or the codegen fails or
// did not run. Rationale and limits: docs/notes/repo-check-scripts.md.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  firstDifferingLine,
  withRestoreOnSignal,
} from "./lib/regenerationChecks.mjs";

/** The generated file this check guards, relative to the repository root. */
export const ROUTE_TREE = "apps/web/src/routeTree.gen.ts";

// The invocation that regenerates it: the cheapest one that loads
// apps/web/vite.config.ts and so runs the TanStack Router plugin's codegen. Held
// as argv and joined for display so the command this runs and the command the
// failure messages tell a contributor to run cannot drift apart.
const REGENERATE_ARGV = [
  "npm",
  "exec",
  "--workspace",
  "apps/web",
  "--",
  "vitest",
  "list",
  "--project",
  "unit",
];

/** The regeneration invocation, as a contributor would type it. */
export const REGENERATE_COMMAND = REGENERATE_ARGV.join(" ");

/**
 * The marker appended to the copy the codegen is handed. Its survival is what
 * tells this check the codegen never ran; its wording is addressed to whoever
 * finds it in a committed file after a run was killed outright.
 */
export const PROBE =
  "Alcove route tree freshness probe -- an interrupted `npm run check:routetree` left this line; regenerate the file";

const PROBE_LINE = `\n// ${PROBE}\n`;

/** Run the real codegen under `root`, throwing with its output on a non-zero exit. */
export function runCodegen(root) {
  const [command, ...args] = REGENERATE_ARGV;
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Regenerate the route tree over a probe-marked copy and report whether the
 * generator reproduces the working-tree bytes, as `{ok, status, message}`. The
 * original bytes are always back in place when this returns; `regenerate` is
 * injectable so a test can drive the outcomes without paying for the real
 * codegen.
 *
 * Statuses: `fresh` (ok), `missing`, `codegen-failed`, `codegen-did-not-run`,
 * `stale`.
 */
export function checkRouteTreeFreshness({
  root,
  regenerate = runCodegen,
} = {}) {
  const file = resolve(root, ROUTE_TREE);
  if (!existsSync(file)) {
    return {
      ok: false,
      status: "missing",
      message: `${ROUTE_TREE} is absent. It is a checked-in generated file -- restore it with \`git checkout -- ${ROUTE_TREE}\`, or regenerate it with \`${REGENERATE_COMMAND}\`.`,
    };
  }

  const original = readFileSync(file);
  const backupDirectory = mkdtempSync(join(tmpdir(), "routetree-fresh-"));
  const backup = join(backupDirectory, "routeTree.gen.ts");
  writeFileSync(backup, original);

  const restore = () => {
    try {
      writeFileSync(file, original);
    } catch (cause) {
      throw new Error(
        `could not restore ${ROUTE_TREE}; the original copy is at ${backup}`,
        { cause },
      );
    }
    rmSync(backupDirectory, { recursive: true, force: true });
  };

  return withRestoreOnSignal(restore, () => {
    writeFileSync(file, Buffer.concat([original, Buffer.from(PROBE_LINE)]));
    try {
      regenerate(root);
    } catch (error) {
      const output = [error.stdout, error.stderr, error.message]
        .filter((part) => typeof part === "string" && part.trim() !== "")
        .join("\n")
        .trim();
      return {
        ok: false,
        status: "codegen-failed",
        message: `\`${REGENERATE_COMMAND}\` failed, so the route tree could not be regenerated and its freshness is unknown:\n\n${output}`,
      };
    }

    const regenerated = existsSync(file) ? readFileSync(file) : null;
    if (regenerated === null || regenerated.includes(PROBE)) {
      const symptom =
        regenerated === null
          ? "the file is gone"
          : "the probe line this check wrote is still there";
      return {
        ok: false,
        status: "codegen-did-not-run",
        message: `\`${REGENERATE_COMMAND}\` did not rewrite ${ROUTE_TREE} (${symptom}). This check means nothing unless that invocation runs the TanStack Router codegen, so it fails rather than pass a comparison it never made -- find an invocation that does regenerate the route tree and update REGENERATE_ARGV in scripts/check-routetree-fresh.mjs.`,
      };
    }

    if (regenerated.equals(original)) {
      return {
        ok: true,
        status: "fresh",
        message: `${ROUTE_TREE} matches what the pinned TanStack Router generator produces.`,
      };
    }

    const line = firstDifferingLine(
      original.toString("utf8"),
      regenerated.toString("utf8"),
    );
    return {
      ok: false,
      status: "stale",
      message: `${ROUTE_TREE} is not what the pinned TanStack Router generator produces (first difference at line ${line}). Left stale, it rewrites itself under the next web-tooling run and lands as an unrelated modification in whatever branch is checked out. Refresh it in its own commit:\n\n  ${REGENERATE_COMMAND}\n  git add ${ROUTE_TREE}`,
    };
  });
}

// CLI entry: only runs when invoked directly, so the test can import the
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = checkRouteTreeFreshness({ root });
  if (!result.ok) {
    console.error(`Route tree freshness check failed: ${result.message}`);
    process.exit(1);
  }
  console.log(`Route tree freshness check passed: ${result.message}`);
}
