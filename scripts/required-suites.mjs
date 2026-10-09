#!/usr/bin/env node
// Prints the commands a diff requires before it goes to review: package builds,
// the suite legs CI runs for the touched paths, and the repo-wide gates, all
// read from the workflows each time. `node scripts/required-suites.mjs
// [<range>] [--stdin]`; with no range the diff is the merge base with
// origin/staging against the working tree plus untracked files. A workflow
// filtered by `on.pull_request.paths` instead of the path-scope action is not read.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILT_PACKAGES } from "./lib/distFreshness.mjs";
import {
  PATH_SCOPE_ACTION,
  WORKFLOW_DIR,
  pathScope,
  usesNodes,
  workflowDocument,
  workflowFiles,
} from "./lib/workflows.mjs";
import { SEPARATE_WORKFLOW_STEPS } from "./run-checks.mjs";

/** The workflow whose run steps are the repo-wide gates. */
export const GATE_WORKFLOW = `${WORKFLOW_DIR}/static_checks.yaml`;

/** The job in a path-scoped workflow whose matrix legs are the local suites. */
export const SUITE_JOB = "suite";

/** The base a diff is taken from when no range is given. */
export const DEFAULT_BASE = "origin/staging";

/**
 * Matrix-conditioned suite-job steps that only prepare a CI runner, by workflow
 * file then step name.
 */
export const CI_PROVISIONING_STEPS = {
  [`${WORKFLOW_DIR}/cli_build_and_test.yaml`]: [
    "Create the sshd privilege-separation directory",
  ],
  [`${WORKFLOW_DIR}/web_build_and_test.yaml`]: [
    "Assert the test-prerequisite gate is armed",
    "Bound apt network stalls",
    "Resolve the installed Playwright version",
    "Restore the Playwright browser build",
    "Verify the restored browser build",
    "Install Playwright Chromium",
    "Save the Playwright browser build",
  ],
};

const BUILD_LINE =
  /^(?:[A-Z_][A-Z0-9_]*=\S+\s+)*npm run build(?::[\w-]+)? -w \S+$/;
const MATRIX_TRUE = /^matrix\.([\w-]+) == 'true'$/;
const MATRIX_VALUE = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/;
const MATRIX_COMMAND = "${{ matrix.command }}";
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775a204c9d8ab391";

/** Absolute path of the repository this file sits in. */
export function repositoryRoot() {
  return resolve(fileURLToPath(new URL("..", import.meta.url)));
}

const git = (root, args, options = {}) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });

const nulSeparated = (text) => text.split("\0").filter((name) => name !== "");

/** The default-mode base ref is missing; the message says how to fix it. */
export class MissingBaseError extends Error {}

/**
 * The paths a diff touches. With a `range`, exactly `git diff --name-only
 * <range>`; without one, the merge base with {@link DEFAULT_BASE} against the
 * working tree, plus untracked files. Renames are not detected, so a moved
 * file lists its old and new path.
 */
export function changedPaths(root, range) {
  if (range !== undefined) {
    return nulSeparated(
      git(root, ["diff", "--name-only", "--no-renames", "-z", range, "--"]),
    );
  }
  let base;
  try {
    base = git(root, ["merge-base", DEFAULT_BASE, "HEAD"], {
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new MissingBaseError(
      `Cannot find ${DEFAULT_BASE} to diff against. Run \`git fetch origin\`, or pass an explicit range such as ${DEFAULT_BASE}...HEAD.`,
    );
  }
  const tracked = nulSeparated(
    git(root, ["diff", "--name-only", "--no-renames", "-z", base, "--"]),
  );
  const untracked = nulSeparated(
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  return [...new Set([...tracked, ...untracked])].sort();
}

/**
 * The path-scope action's pathspecs for its `paths` input: each glob as a
 * `:(glob)` pathspec and each `!` line as an excluding one.
 */
export function scopePathspecs(globs) {
  return globs.map((glob) =>
    glob.startsWith("!") ? `:(exclude,glob)${glob.slice(1)}` : `:(glob)${glob}`,
  );
}

/**
 * The subset of `paths` git matches against `pathspecs`. The names go into a
 * throwaway index so that git, not a reimplementation of its globbing, decides
 * each match, deleted and never-committed paths included.
 */
export function matchPaths(root, paths, pathspecs) {
  if (paths.length === 0 || pathspecs.length === 0) return [];
  const dir = mkdtempSync(join(tmpdir(), "required-suites-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
    git(root, ["update-index", "--index-info"], {
      env,
      input: paths.map((path) => `100644 ${EMPTY_BLOB}\t${path}\n`).join(""),
    });
    return nulSeparated(
      git(root, ["ls-files", "-z", "--", ...pathspecs], { env }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mentionsMatrix = (condition) =>
  String(condition ?? "").includes("matrix.");

/**
 * The matrix keys a step condition requires to be `'true'`. Throws on a
 * condition that mentions the matrix in any shape but a `&&` conjunction of
 * `matrix.<key> == 'true'`.
 */
function matrixKeysRequired(condition, where) {
  const keys = [];
  for (const part of String(condition).split("&&")) {
    const key = MATRIX_TRUE.exec(part.trim())?.[1];
    if (key === undefined) {
      throw new Error(
        `${where} has an unrecognized matrix condition: ${condition}; ` +
          `teach scripts/required-suites.mjs to read it, or name the step in CI_PROVISIONING_STEPS if it only prepares a CI runner.`,
      );
    }
    keys.push(key);
  }
  return keys;
}

const runLines = (run) =>
  String(run)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * The legs of a workflow's suite job, each `{suite, command, builds}`:
 * `command` is the matrix command with the step's matrix-valued environment
 * prefixed, `builds` the build commands of the matrix-conditioned steps the leg
 * enables. Throws on a matrix-conditioned step that is neither a build nor named
 * in `provisioning`.
 */
export function suiteLegs(document, path, provisioning = []) {
  const job = document?.jobs?.[SUITE_JOB];
  const legs = job?.strategy?.matrix?.include;
  if (!Array.isArray(legs)) {
    throw new Error(
      `${path}: no jobs.${SUITE_JOB}.strategy.matrix.include list`,
    );
  }
  const steps = job.steps ?? [];
  const runStep = steps.find((step) =>
    String(step.run).includes(MATRIX_COMMAND),
  );
  if (!runStep) {
    throw new Error(`${path}: no ${SUITE_JOB} step runs ${MATRIX_COMMAND}`);
  }
  const conditioned = steps.filter(
    (step) => step !== runStep && mentionsMatrix(step.if),
  );
  const buildSteps = [];
  for (const step of conditioned) {
    if (provisioning.includes(step.name)) continue;
    const keys = matrixKeysRequired(
      step.if,
      `${path}: the ${SUITE_JOB} step "${step.name}"`,
    );
    const lines = step.run === undefined ? [] : runLines(step.run);
    if (lines.length === 0 || !lines.every((line) => BUILD_LINE.test(line))) {
      throw new Error(
        `${path}: the ${SUITE_JOB} step "${step.name}" runs on a matrix condition but is not a build; ` +
          `add it to CI_PROVISIONING_STEPS in scripts/required-suites.mjs if it only prepares a CI runner, ` +
          `or teach the plan to run it.`,
      );
    }
    buildSteps.push({ keys, lines });
  }
  const envPrefix = (leg) =>
    Object.entries(runStep.env ?? {})
      .map(([name, value]) => [name, MATRIX_VALUE.exec(String(value))?.[1]])
      .filter(
        ([, key]) =>
          key !== undefined && leg[key] !== undefined && leg[key] !== "",
      )
      .map(([name, key]) => `${name}=${leg[key]} `)
      .join("");
  return legs.map((leg) => ({
    suite: leg.suite,
    command: `${envPrefix(leg)}${String(runStep.run).replace(MATRIX_COMMAND, leg.command)}`,
    builds: buildSteps
      .filter((step) => step.keys.every((key) => leg[key] === "true"))
      .flatMap((step) => step.lines),
  }));
}

/**
 * A job's display name with each `${{ matrix.<key> }}` replaced by the values
 * its matrix lists for that key.
 */
export function jobDisplayName(id, job) {
  return String(job.name ?? id).replace(
    /\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g,
    (expression, key) => {
      const values = job.strategy?.matrix?.[key];
      return Array.isArray(values) ? values.join(", ") : expression;
    },
  );
}

/**
 * The display names of the jobs a workflow gates on its path scope other than
 * the suite job, which the plan leaves to CI.
 */
export function ciOnlyJobs(document) {
  return Object.entries(document?.jobs ?? {})
    .filter(
      ([id, job]) =>
        id !== SUITE_JOB &&
        String(job.if ?? "").includes("needs.scope.outputs.run"),
    )
    .map(([id, job]) => jobDisplayName(id, job));
}

/** The repo-wide gate commands: the gate workflow's run steps less the separate ones. */
export function gateCommands(document) {
  const separate = new Set(SEPARATE_WORKFLOW_STEPS.map((step) => step.command));
  return Object.values(document?.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.run !== undefined)
    .flatMap((step) => runLines(step.run))
    .filter((line) => !separate.has(line));
}

const usesPathScope = (document) =>
  usesNodes(document).some((node) => node.uses === PATH_SCOPE_ACTION);

/**
 * What `paths` require, as `{builds, workflows, gates}`. `workflows` has one
 * entry per path-scoped workflow the paths touch, each `{path, name, legs,
 * ciOnly}`; a leg whose command an earlier workflow already listed is left out.
 * `packages` are the built packages whose sources trigger a build.
 */
export function requiredPlan(root, paths, packages = BUILT_PACKAGES) {
  const builds = [];
  for (const pkg of packages) {
    const dir = relative(root, pkg.dir).split("\\").join("/");
    const pathspecs = pkg.sources.flatMap((source) => [
      `:(glob)${dir}/${source}`,
      `:(glob)${dir}/${source}/**`,
    ]);
    if (matchPaths(root, paths, pathspecs).length > 0)
      builds.push(pkg.buildCommand);
  }

  const listed = new Set();
  const workflows = [];
  for (const path of workflowFiles(root)) {
    const document = workflowDocument(root, path);
    if (!usesPathScope(document)) continue;
    const touched = matchPaths(
      root,
      paths,
      scopePathspecs(pathScope(document, path)),
    );
    if (touched.length === 0) continue;
    const hasSuites = document.jobs?.[SUITE_JOB] !== undefined;
    const allLegs = hasSuites
      ? suiteLegs(document, path, CI_PROVISIONING_STEPS[path] ?? [])
      : [];
    for (const line of allLegs.flatMap((leg) => leg.builds)) {
      if (!builds.includes(line)) builds.push(line);
    }
    const legs = allLegs.filter((leg) => {
      if (listed.has(leg.command)) return false;
      listed.add(leg.command);
      return true;
    });
    workflows.push({
      path,
      name: String(document.name ?? path),
      legs,
      ciOnly: hasSuites
        ? ciOnlyJobs(document)
        : [String(document.name ?? path)],
    });
  }

  return {
    builds,
    workflows,
    gates: gateCommands(workflowDocument(root, GATE_WORKFLOW)),
  };
}

/** The plan as text: comment lines and the commands to run, in order. */
export function formatPlan(plan, source) {
  const lines = [`# Required for ${source}.`];
  if (plan.builds.length > 0) {
    lines.push("", "# Builds the suites below read", ...plan.builds);
  }
  const withLegs = plan.workflows.filter(
    (workflow) => workflow.legs.length > 0,
  );
  if (withLegs.length === 0) {
    lines.push(
      "",
      "# No suite workflow's path scope is touched: only the gates apply.",
    );
  }
  for (const workflow of withLegs) {
    lines.push("", `# ${workflow.name} (${workflow.path})`);
    lines.push(...workflow.legs.map((leg) => leg.command));
  }
  const ciOnly = plan.workflows.flatMap((workflow) => workflow.ciOnly);
  if (ciOnly.length > 0) {
    lines.push(
      "",
      `# CI also runs these jobs on the same paths, not listed above: ${ciOnly.join("; ")}.`,
    );
  }
  lines.push(
    "",
    `# Repo-wide gates, once, after the suites pass (${GATE_WORKFLOW})`,
  );
  lines.push(...plan.gates);
  return lines.join("\n");
}

const USAGE = `Usage: node scripts/required-suites.mjs [<range>] [--stdin]

Prints the builds, test suites and gates a diff requires, read from the
workflows CI runs.

  <range>   a git diff range, such as origin/staging...HEAD; without one, the
            merge base with ${DEFAULT_BASE} against the working tree, plus
            untracked files
  --stdin   read the changed paths from stdin, one per line`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const fromStdin = args.includes("--stdin");
  const positional = args.filter((arg) => arg !== "--stdin");
  if (positional.length > 1 || (fromStdin && positional.length > 0)) {
    console.error(USAGE);
    process.exit(64);
  }
  const root = repositoryRoot();
  let paths;
  let source;
  if (fromStdin) {
    paths = readFileSync(0, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    source = `${paths.length} path(s) read from stdin`;
  } else {
    const range = positional[0];
    try {
      paths = changedPaths(root, range);
    } catch (error) {
      if (!(error instanceof MissingBaseError)) throw error;
      console.error(error.message);
      process.exit(2);
    }
    source =
      range === undefined
        ? `${paths.length} path(s) changed since the merge base with ${DEFAULT_BASE}, uncommitted and untracked included`
        : `${paths.length} path(s) changed in ${range}`;
  }
  console.log(formatPlan(requiredPlan(root, paths), source));
}
