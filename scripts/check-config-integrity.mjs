#!/usr/bin/env node
// Verification-config integrity check: `npm run check:config-integrity`, run
// by static_checks.yaml on every pull request. It drives `tsc --showConfig` and
// `vitest list --filesOnly` rather than reading the config files, and fails
// unless:
//
//   - Every tsconfig in GUARDED_TSCONFIGS resolves with its listed compiler
//     options at the listed values.
//   - Every one of them resolves over a file list covering every source file on
//     disk in its workspace's src/.
//   - Every vitest config in GUARDED_VITEST_CONFIGS still declares the named
//     projects, each with at least one test file.
//
// Exit 0 clean, 1 on a finding. Rationale and limits:
// docs/notes/repo-check-scripts.md.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHARED_PACKAGE_STRICTNESS = {
  strict: true,
  strictNullChecks: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  noFallthroughCasesInSwitch: true,
  noUncheckedSideEffectImports: true,
  forceConsistentCasingInFileNames: true,
};

/**
 * The tsconfigs this check holds, each with the compiler options that must
 * resolve at the stated value and the source directory its file list must
 * cover. packages/core and packages/cli-contract list their whole strictness
 * set: they are the packages both apps compile against. The others list
 * `strict`, the option whose loss silences the most.
 */
export const GUARDED_TSCONFIGS = [
  {
    tsconfig: "packages/core/tsconfig.json",
    sourceDirectory: "packages/core/src",
    options: { ...SHARED_PACKAGE_STRICTNESS },
  },
  {
    tsconfig: "packages/cli-contract/tsconfig.json",
    sourceDirectory: "packages/cli-contract/src",
    options: { ...SHARED_PACKAGE_STRICTNESS },
  },
  {
    tsconfig: "apps/cli/tsconfig.json",
    sourceDirectory: "apps/cli/src",
    options: { strict: true },
  },
  {
    tsconfig: "apps/web/tsconfig.json",
    sourceDirectory: "apps/web/src",
    options: { strict: true },
  },
  {
    tsconfig: "packages/peerjs-broker/tsconfig.json",
    sourceDirectory: "packages/peerjs-broker/src",
    options: { strict: true },
  },
];

/**
 * The vitest configs this check holds, each by the directory a run starts in
 * and the projects that run must declare. The root entry is what makes `npm run
 * test:scripts` cover the scripts and hooks outside the workspaces; a workspace
 * entry names the projects its own config splits its suites into. A project
 * name is the config's `name` where it sets one, and the package name where it
 * does not; a workspace project listed by a root run is named
 * "<package> (<name>)", and a browser project's name includes its instance.
 */
export const GUARDED_VITEST_CONFIGS = [
  {
    directory: ".",
    projects: [
      "@alcove/core (unit)",
      "@alcove/cli-contract (unit)",
      "alcove (unit)",
      "alcove-web (unit)",
      "harness",
      "scripts",
      "hooks",
      "repo-scripts",
    ],
  },
  { directory: "packages/core", projects: ["unit", "stress"] },
  { directory: "packages/cli-contract", projects: ["unit"] },
  {
    directory: "apps/cli",
    projects: ["unit", "integration", "webrtc", "backend-agnostic", "stress"],
  },
  {
    directory: "apps/web",
    projects: ["unit", "integration", "interop", "browser (chromium)"],
  },
];

/** Absolute path of the repository this file sits in. */
export function repositoryRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Runs `command` and returns its stdout, throwing with the tool's own output
 * when it fails, so a broken config reaches the caller as the tool's message
 * rather than a parse error.
 */
function toolOutput(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `\`${command} ${args.join(" ")}\` exited ${result.status}:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

/**
 * The config `tsc` resolves for `tsconfigPath`, as `{options, files}` with the
 * file list absolute. `cwd` is where the compiler is invoked from, which is
 * what makes the tool resolvable; the path may point outside it.
 */
export function resolveTsconfig(tsconfigPath, { cwd = repositoryRoot() } = {}) {
  const absolute = resolve(cwd, tsconfigPath);
  const shown = JSON.parse(
    toolOutput("npx", ["tsc", "-p", absolute, "--showConfig"], cwd),
  );
  const base = dirname(absolute);
  return {
    options: shown.compilerOptions ?? {},
    files: (shown.files ?? []).map((file) => resolve(base, file)),
  };
}

/**
 * Every TypeScript source file under `directory`, absolute. Declaration files
 * are left out: they are inputs a build emits or a dependency ships, not source
 * a workspace's own config is expected to list.
 */
export function sourceFilesUnder(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesUnder(path));
    else if (
      /\.(ts|tsx|mts|cts)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    )
      found.push(path);
  }
  return found;
}

/**
 * How `guard` is violated by the config `tsc` resolved for it and the source
 * files found on disk. One line per violation; empty when the config holds.
 */
export function tsconfigViolations(guard, resolved, sourceFiles) {
  const violations = [];
  for (const [option, expected] of Object.entries(guard.options)) {
    const actual = resolved.options[option];
    if (actual !== expected) {
      violations.push(
        `${guard.tsconfig}: ${option} resolves to ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}.`,
      );
    }
  }
  const listed = new Set(resolved.files);
  const uncovered = sourceFiles.filter((file) => !listed.has(file));
  if (sourceFiles.length === 0) {
    violations.push(
      `${guard.tsconfig}: ${guard.sourceDirectory} holds no TypeScript source, so the config compiles nothing from it.`,
    );
  } else if (uncovered.length > 0) {
    violations.push(
      `${guard.tsconfig}: ${uncovered.length} of ${sourceFiles.length} files under ${guard.sourceDirectory} are outside the resolved file list, starting with ${uncovered[0]}.`,
    );
  }
  return violations;
}

/**
 * The vitest projects a run started in `directory` declares, as project name ->
 * test file count. `--filesOnly` resolves the project graph without importing a
 * test file, so this costs a config load rather than a collection.
 */
export function listProjects(directory) {
  const listed = JSON.parse(
    toolOutput("npx", ["vitest", "list", "--filesOnly", "--json"], directory),
  );
  const counts = new Map();
  for (const entry of listed) {
    counts.set(entry.projectName, (counts.get(entry.projectName) ?? 0) + 1);
  }
  return counts;
}

/**
 * How `guard` is violated by the projects a run in its directory listed. One
 * line per violation; empty when the config holds.
 */
export function vitestViolations(guard, listed) {
  const missing = guard.projects.filter((project) => !listed.has(project));
  if (missing.length === 0) return [];
  const present = [...listed.keys()].sort();
  return [
    `${guard.directory}: vitest declares no project with a test file named ${missing.map((name) => `"${name}"`).join(", ")}. It listed ${present.length === 0 ? "no project" : present.map((name) => `"${name}"`).join(", ")}.`,
  ];
}

/**
 * Holds every guarded config against the tools, and reports `{ok, message}`.
 * The resolvers are injectable so a test can drive a config this repository
 * does not hold.
 */
export function checkConfigIntegrity({
  root = repositoryRoot(),
  tsconfigs = GUARDED_TSCONFIGS,
  vitestConfigs = GUARDED_VITEST_CONFIGS,
  resolveConfig = resolveTsconfig,
  listVitestProjects = listProjects,
  sourceFiles = sourceFilesUnder,
} = {}) {
  const violations = [];
  for (const guard of tsconfigs) {
    violations.push(
      ...tsconfigViolations(
        guard,
        resolveConfig(resolve(root, guard.tsconfig), { cwd: root }),
        sourceFiles(resolve(root, guard.sourceDirectory)),
      ),
    );
  }
  for (const guard of vitestConfigs) {
    violations.push(
      ...vitestViolations(
        guard,
        listVitestProjects(resolve(root, guard.directory)),
      ),
    );
  }
  if (violations.length === 0) {
    return {
      ok: true,
      message: `${tsconfigs.length} tsconfigs resolve with their strictness options over their whole source tree, and ${vitestConfigs.length} vitest configs declare every project their suites run under.`,
    };
  }
  return {
    ok: false,
    message: [
      "A config typecheck or test rests on no longer states what it is held to:",
      ...violations.map((violation) => `  ${violation}`),
      "Restore the config rather than the check: a gate over a config this thin reports nothing and still exits 0.",
    ].join("\n"),
  };
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions and the resolvers without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { ok, message } = checkConfigIntegrity();
  (ok ? console.log : console.error)(
    `config integrity check ${ok ? "passed" : "failed"}: ${message}`,
  );
  if (!ok) process.exit(1);
}
