#!/usr/bin/env node
// Fix-shape verifier, run by the /light-review booking step
// (.claude/commands/light-review.md, Step 3) before it drafts a fix brief:
// decides whether each lens cluster the consolidator gave edits for is
// mechanical, which holds only when every edit's `oldText` occurs exactly once
// in its file at the target ref.
//
// Usage: node .claude/scripts/verify-fix-shape.mjs <targetRef>
// <workflow-result.json> [--worktree <path>]. The result file holds the
// Workflow's lens-mode result, either wrapped as `{"result": {...}}` the way
// the task output file holds it or bare. Each file is read with
// `git [-C <path>] show <targetRef>:<file>`. One line per cluster carrying
// edits: `mechanical <name>` or `judgment <name> -- <reason>`.
//
// The check lives here rather than in light-review-workflow.mjs because the
// Workflow tool refuses at launch a script whose body contains `import(`, so a
// workflow script cannot read a file or run git; the no-import assertion in
// .claude/scripts/light-review-script.test.mjs holds that the script has none.
//
// Exit codes: 0 every cluster carrying edits is mechanical; 1 at least one is
// judgment; 2 usage, or a result file that cannot be read as a lens result.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The clusters of a saved Workflow result, wrapped or bare; null when absent. */
export function clustersOf(saved) {
  const result =
    saved !== null && typeof saved === "object" && "result" in saved
      ? saved.result
      : saved;
  return Array.isArray(result?.clusters) ? result.clusters : null;
}

/**
 * Why one edit is not mechanical, or null when it is. `show(file)` returns the
 * file's content at the target ref and throws when git cannot show it.
 */
export function editProblem(edit, show) {
  if (typeof edit?.file !== "string" || edit.file.length === 0) {
    return "an edit names no file";
  }
  if (typeof edit.oldText !== "string" || edit.oldText.length === 0) {
    return `the edit to ${edit.file} has no old text`;
  }
  let content;
  try {
    content = show(edit.file);
  } catch (error) {
    return `git cannot show ${edit.file}: ${firstLine(error)}`;
  }
  const first = content.indexOf(edit.oldText);
  if (first === -1) return `the old text is not in ${edit.file}`;
  if (content.indexOf(edit.oldText, first + 1) !== -1) {
    return `the old text occurs more than once in ${edit.file}`;
  }
  return null;
}

/** One verdict per cluster carrying edits: `{name, mechanical, reason}`. */
export function verifyClusters(clusters, show) {
  return clusters
    .filter((cluster) => Array.isArray(cluster?.edits) && cluster.edits.length)
    .map((cluster) => {
      let reason = null;
      for (const edit of cluster.edits) {
        reason = editProblem(edit, show);
        if (reason !== null) break;
      }
      return { name: cluster.name, mechanical: reason === null, reason };
    });
}

function firstLine(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  return (stderr || String(error?.message ?? error)).split("\n")[0];
}

function usage(message) {
  process.stderr.write(
    `${message}\nUsage: node .claude/scripts/verify-fix-shape.mjs <targetRef> <workflow-result.json> [--worktree <path>]\n`,
  );
  process.exit(2);
}

// Not run on import, so the test can load the pure functions.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const positional = [];
  let worktree = null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--worktree") {
      worktree = argv[i + 1];
      i += 1;
      if (!worktree) usage("--worktree needs a path.");
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 2) usage("Name a target ref and a result file.");
  const [targetRef, resultFile] = positional;

  let clusters;
  try {
    clusters = clustersOf(JSON.parse(readFileSync(resultFile, "utf8")));
  } catch (error) {
    usage(`Cannot read ${resultFile} as JSON: ${error.message}`);
  }
  if (clusters === null) {
    usage(`${resultFile} holds no lens-mode result with a clusters list.`);
  }

  const show = (file) =>
    execFileSync(
      "git",
      [...(worktree ? ["-C", worktree] : []), "show", `${targetRef}:${file}`],
      {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

  const verdicts = verifyClusters(clusters, show);
  if (verdicts.length === 0) process.stdout.write("no cluster carries edits\n");
  for (const { name, mechanical, reason } of verdicts) {
    process.stdout.write(
      mechanical ? `mechanical ${name}\n` : `judgment ${name} -- ${reason}\n`,
    );
  }
  process.exit(verdicts.every((verdict) => verdict.mechanical) ? 0 : 1);
}
