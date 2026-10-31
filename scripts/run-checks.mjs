#!/usr/bin/env node
// The repository-wide check runner behind `npm run check:all`, and the one list
// the checks are named on. static_checks.yaml's `repo-guards` job is a single
// step invoking it. CHECKS has a line per check saying what it checks; each
// check's reasons are reached from its own script header. OUT_OF_CHECK_ALL
// lists the checks that stay off the list, each with what puts it there.
//
// Runs past a failure: the summary names every failure, and the exit code is 1
// if there was one. The `shared` checks run first, one at a time in list order
// with their output streamed; the `independent` checks then run in a bounded
// pool, each one's output buffered and printed whole when it ends, with a
// `[start]` line when it begins so a truncated log names the checks that were
// running. On SIGINT or SIGTERM the run prints each check still running with
// the output it had, stops them, and exits non-zero. A check
// marked `usesBuild` needs the production web build, and the run clears
// apps/web/dist/hosted first; one naming another in `buildFrom` reads that
// build and is skipped with a line saying so when the build fails.
// scripts/run-checks.test.mjs holds every `check:*` script in the root
// package.json to one list or the other, and the repo-guards job to this one
// step plus the dependency audit. Rationale: docs/notes/repo-check-scripts.md.

import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILD_OUTPUT } from "./check-deploy-trigger-graph.mjs";

/** A check that runs alone: see `group` on CHECKS. */
export const SHARED = "shared";

/** A check that may run beside the other independent checks. */
export const INDEPENDENT = "independent";

/**
 * The checks `npm run check:all` runs. `script` is a root package.json script
 * name; `command`, when present, is run instead of the npm script; `group` is
 * SHARED for a check that writes a tracked file or a build output, which runs
 * alone, and INDEPENDENT for one that writes nothing another check reads, which
 * runs beside the others in its group after every shared check has ended (the
 * one exception, the route tree the web tooling rewrites only when it is
 * stale: docs/notes/repo-check-scripts.md, Check runner);
 * `usesBuild` marks a check that reads the shared web build and `buildFrom`
 * names the check that makes it; `description` states in one line what the
 * check holds; `expiresOn` is the last date, YYYY-MM-DD, the entry stands
 * before it is renewed or deleted, held by scripts/check-expiry-dates.mjs as
 * on every entry in the two lists below. The pool starts its checks in list
 * order, so the longest independent check is listed first.
 */
export const CHECKS = [
  {
    script: "test:scripts",
    // At least four vitest workers, measured faster than the three the
    // four-CPU runner gave it: docs/notes/repo-check-scripts.md, Check runner.
    command: [
      "npm",
      "run",
      "test:scripts",
      "--",
      `--maxWorkers=${Math.max(4, availableParallelism() - 1)}`,
    ],
    group: INDEPENDENT,
    expiresOn: "2027-06-30",
    description:
      "The vitest projects outside the workspaces: scripts/, .claude/scripts/, the hooks, and the harness.",
  },
  {
    script: "check:config-integrity",
    group: INDEPENDENT,
    expiresOn: "2027-06-30",
    description:
      "The configs the gates rest on still say what they are held to: every guarded tsconfig resolves with its strictness options over every source file in its workspace, and every vitest config declares the projects its suites run under.",
  },
  {
    script: "linkcheck",
    group: INDEPENDENT,
    expiresOn: "2027-06-30",
    description:
      "Every Markdown link target and heading anchor across the repository resolves.",
  },
  {
    script: "check:no-legacy-names",
    group: INDEPENDENT,
    expiresOn: "2026-12-24",
    description:
      "No tracked file or path holds the product's earlier name outside the reasoned allowlist; past its expiry date the check fails until it is deleted.",
  },
  {
    script: "check:contributing",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "CONTRIBUTING.md stays a quickstart: no heading outside its allowlist, no node_modules/ source path.",
  },
  {
    script: "check:claudemd-budget",
    group: INDEPENDENT,
    expiresOn: "2027-06-30",
    description:
      "CLAUDE.md stays under the byte budget every agent session pays to load it, so a new rule relocates its own weight.",
  },
  {
    script: "check:comment-narration",
    group: INDEPENDENT,
    expiresOn: "2027-06-30",
    description:
      "No comment line a change adds or modifies narrates how the repository changed rather than stating what the code does.",
  },
  {
    script: "check:command-inventory",
    group: INDEPENDENT,
    expiresOn: "2027-06-30",
    description:
      "Every CLI subcommand the parser registers is named in docs/DESIGN.md and docs/CLI.md.",
  },
  {
    script: "check:image-capabilities",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "Every Alcove argument vector the file-drop support scripts use has an image_smoke.yaml capability gate exercising it.",
  },
  {
    script: "check:enforcement-claims",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "Every enforcement claim in CLAUDE.md and the orchestration ruleset names a hook that exists, is registered, and matches the tool the rule is about, and every hook has a test.",
  },
  {
    script: "check:expiry-dates",
    group: INDEPENDENT,
    expiresOn: "2027-06-30",
    description:
      "Every entry on these lists and every hook .claude/settings.json registers states an expiry date, and none has passed.",
  },
  {
    script: "check:rule-ledgers",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "CLAUDE.md and the orchestration ruleset share no enforcement claim and no heading, CLAUDE.md points at the ruleset once, and every front door loads it.",
  },
  {
    script: "check:rule-citations",
    group: INDEPENDENT,
    expiresOn: "2027-06-30",
    description:
      "Every `<file>, <section>` citation in CLAUDE.md, CONTRIBUTING.md and .claude/ names a heading the cited instruction file has.",
  },
  {
    script: "check:spec-citations",
    group: INDEPENDENT,
    expiresOn: "2027-06-30",
    description:
      "Every anchored, quoted-heading or heading-prefix citation of a docs/spec/ file outside Markdown names a heading or bold paragraph label the file has; the forms it does not resolve are in its --help.",
  },
  {
    script: "check:egress-claims",
    group: INDEPENDENT,
    expiresOn: "2027-06-30",
    description:
      "No absolute URL literal in shipped source outside the reasoned allowlist, which is what PRIVACY.md's no-egress statement rests on.",
  },
  {
    script: "check:workflow-agent-models",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "Every agent() call in a committed Workflow script pins a literal model tier and a literal effort rather than inheriting the session's.",
  },
  {
    script: "check:workflow-args-resolve",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "Every committed Workflow script reads its arguments through resolveWorkflowArgs, which fails closed on a shape it cannot use.",
  },
  {
    script: "check:action-pin-drift",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "Every action pin in .github/actions is mirrored by one in .github/workflows, the path Dependabot is configured against.",
  },
  {
    script: "check:checkout-ref-override",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "No workflow triggered by a pull request hands actions/checkout a ref or sha, so a gate runs the head merged with the base tip.",
  },
  {
    script: "check:merge-gate-identities",
    group: INDEPENDENT,
    expiresOn: "2027-06-30",
    description:
      "No gating job is renamed out from under the required check that names it, no path filter is added to a gating workflow, every gating workflow but the exempt ones runs on push to staging, and every workflow declaring a required job is on the list held filter-free. The branch-rule half needs a token and states a skip without one.",
  },
  {
    script: "check:dependabot-ignore-shape",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "Every github-actions pin under a within-major Dependabot ignore floats within its major, so the ignore does not freeze it.",
  },
  {
    script: "check:dependabot-pin-coverage",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "Every package with an upgrade checklist in docs/spec/DEPENDENCY_PINS.md is excluded from the batched npm Dependabot groups.",
  },
  {
    script: "check:nested-root-package",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "No package the committed lockfile installs at the root is also installed under a workspace.",
  },
  {
    script: "check:locked-dep-ranges",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "Every dependency the committed lockfile locks lies inside the range its dependent declared, outside the reasoned allowlist.",
  },
  {
    script: "check:routetree",
    group: SHARED,
    expiresOn: "2027-06-30",
    description:
      "The checked-in apps/web/src/routeTree.gen.ts matches what the pinned generator produces.",
  },
  {
    script: "check:web-config-native-load",
    group: SHARED,
    expiresOn: "2027-06-30",
    description:
      "apps/web/vite.config.ts and its import graph load under the strip-only type stripping Vite's native config loader and a plain node import use.",
  },
  {
    script: "check:web-config-image-load",
    group: SHARED,
    expiresOn: "2027-06-30",
    description:
      "apps/web/vite.config.ts loads from the file subset the Dockerfile builder stage copies, so the image build resolves no module the image does not have.",
  },
  {
    script: "check:bundle-notices",
    // The web builds write apps/web/.tanstack/ when it is absent or stale.
    group: SHARED,
    expiresOn: "2027-06-30",
    description:
      "Every chunk of core's dist, the SFTP relay bundle and the console server bundle has the license text of each third-party package it inlines, and the hosted app's and the console client's third-party-licenses.txt has that of every package their chunks and workers inline.",
  },
  {
    script: "check:core-barrel-wildcards",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "packages/core/src/main.ts publishes a named list, with no wildcard re-export putting a module's whole surface on the main entry.",
  },
  {
    script: "check:internal-fault-throws",
    group: INDEPENDENT,
    expiresOn: "2027-06-30",
    description:
      'No exhaustiveness branch or "internal error" guard in packages/core/src or apps/cli/src throws a plain Error, which the CLI would exit 69 rather than 70.',
  },
  {
    script: "check:vectors",
    group: SHARED,
    expiresOn: "2027-06-30",
    description:
      "Every known-answer vector under packages/core/test/vectors/ still reproduces from its generator.",
  },
  {
    script: "check:protocol-version-bump",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "A wire-format change from the first published release onward moves PROTOCOL_VERSION.",
  },
  {
    script: "check:exchange-record-version",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "EXCHANGE_RECORD_VERSION stands where the disclosure-accounting recovery was driven against it, and is the reset value at and above the release marker apps/cli/package.json states, not below.",
  },
  {
    script: "check:stun-default-claims",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "Every hand-written copy of the WebRTC library's built-in STUN default matches the one constant the CLI measures against the library.",
  },
  {
    script: "check:webrtc-provider-options-unread",
    group: INDEPENDENT,
    expiresOn: "2027-06-30",
    description:
      "No WebRTC transport or entry point on either side reads connection.provider_options, which the spec states is inert on that channel.",
  },
  {
    script: "check:run-failure-sink",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "Every render of a failed run's message or reported cause in apps/web/src goes through that piece's own sink, so no alert collapses a relayed cause chain onto one line.",
  },
  {
    script: "check:alert-roles",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "Every red or runtime-color Alert in apps/web/src sets a role a screen reader announces (alert, status, or alertRoleFor of its own color), except the documented sites whose text a separate live region announces.",
  },
  {
    script: "check:zero-setup-keys",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "Every built-in linkage key is built from the built-in field set, so a zero-setup exchange strands no party over a field its file lacks.",
  },
  {
    script: "check:init-template-coverage",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "Every configuration-schema option is documented in the template alcove init writes or listed with the reason it is left out, and the template documents no key the schema lacks.",
  },
  {
    script: "check:spec-sentences",
    group: INDEPENDENT,
    expiresOn: "2027-01-31",
    description:
      "Every sentence, heading, table row and code line the branch adds, drops or rewords across docs/spec/ is listed in the branch's own file under docs/spec/wording-changes/, so text moved between spec files arrives unchanged. On a failure it prints the lines to list.",
  },
  {
    script: "check:release-signing",
    group: INDEPENDENT,
    expiresOn: "2027-03-31",
    description:
      "The cosign verify command docs/RELEASES.md publishes, the release workflow's self-verify step, and the publish sequence name one release identity.",
  },
  {
    script: "check:deploy-trigger-graph",
    group: SHARED,
    usesBuild: true,
    expiresOn: "2027-06-30",
    description:
      "Every repository source the hosted static web build reads matches a push filter of pages_deploy.yaml, so an edit to the deployed site always triggers a deploy, and the upload jobs of that workflow and of site_deploy.yaml are the only jobs holding the deploy credentials and run no repository code.",
  },
];

/**
 * The checks `npm run check:all` does not run, each with what keeps it off the
 * list. A `check:*` script belongs here or in CHECKS; nothing else.
 */
export const OUT_OF_CHECK_ALL = [
  {
    script: "check:pr-checklist",
    expiresOn: "2027-06-30",
    reason:
      "Reads the pull request's body and head sha from the API, so it needs a token and a pull request. Run by pr_checklist.yaml.",
  },
  {
    script: "check:release-version",
    expiresOn: "2027-03-31",
    reason:
      "Reads the version out of the pushed release tag the run was triggered by, which a plain checkout does not have. Run by release.yaml.",
  },
  {
    script: "check:prebuild-provenance",
    expiresOn: "2027-03-31",
    reason:
      "Run by .github/actions/setup ahead of every install in every workflow, and reaches `gh attestation verify` and the network once arming is switched on.",
  },
  {
    script: "test:mutation",
    expiresOn: "2027-06-30",
    reason:
      "A minutes-long corpus kept off the merge path by design: nightly_mutation.yaml runs it on a schedule and a manual dispatch, never on a push or a pull request.",
  },
  {
    script: "test:mutation:cli",
    expiresOn: "2027-06-30",
    reason:
      "The CLI accept command's mutation run, about fourteen minutes: nightly_mutation.yaml runs it beside test:mutation, never on a push or a pull request.",
  },
];

/**
 * The commands the `repo-guards` job may run beside `npm run check:all`, and
 * why each stays a step of its own. Held against the workflow by the test
 * beside this file.
 *
 */
export const SEPARATE_WORKFLOW_STEPS = [
  {
    command: "npm run audit:production",
    expiresOn: "2027-06-30",
    reason:
      "Reaches the npm registry's advisory endpoint, so it does not run from an offline checkout, and it runs last so an advisory standing open over the production tree does not mask the guards' results.",
  },
];

/** Absolute path of the repository this file sits in. */
export function repositoryRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** The root package.json's `scripts` block. */
export function rootScripts(root = repositoryRoot()) {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
    .scripts;
}

/**
 * The one-minute load average, or null on Windows, where Node reports zero.
 */
export function oneMinuteLoad() {
  return process.platform === "win32" ? null : loadavg()[0];
}

// A working value: the CI runner has four CPUs, and test:scripts, in the pool,
// spreads over vitest workers of its own.
const POOL_CEILING = 4;

/** How many independent checks run at once on a machine of `cpuCount` CPUs. */
export function poolSize(cpuCount = availableParallelism()) {
  return Math.max(1, Math.min(cpuCount, POOL_CEILING));
}

/**
 * Runs one check and resolves with how it went and the one-minute load average
 * when it started. Its output is written through as it comes, or with `buffer`
 * collected into `output` in arrival order, stdout and stderr together. A
 * command that cannot be started fails the check with the reason in `output`.
 * `onStart`, when given, is called once the command is running with a handle
 * holding `kill()` and `output()`, the text collected so far.
 *
 */
export function runCheck(check, root, { buffer = false, onStart } = {}) {
  const load = oneMinuteLoad();
  const startedAt = Date.now();
  const [file, ...args] = check.command ?? ["npm", "run", check.script];
  return new Promise((settle) => {
    const chunks = [];
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      settle({
        script: check.script,
        ok,
        seconds: (Date.now() - startedAt) / 1000,
        load,
        output: Buffer.concat(chunks).toString("utf8"),
      });
    };
    const child = spawn(file, args, {
      cwd: root,
      stdio: buffer ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: process.platform === "win32",
    });
    if (buffer) {
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stderr.on("data", (chunk) => chunks.push(chunk));
    }
    onStart?.({
      kill: () => child.kill("SIGTERM"),
      output: () => Buffer.concat(chunks).toString("utf8"),
    });
    child.on("error", (error) => {
      chunks.push(Buffer.from(`\n${file} could not be started: ${error}\n`));
      finish(false);
    });
    child.on("close", (code) => finish(code === 0));
  });
}

/**
 * Throws unless every check names a known group and every `buildFrom` names a
 * shared check listed before it, which has ended before the pool starts.
 *
 */
export function assertRunnable(checks) {
  for (const [index, check] of checks.entries()) {
    if (check.group !== SHARED && check.group !== INDEPENDENT) {
      throw new Error(
        `${check.script} has group ${JSON.stringify(check.group)}; set it to SHARED or INDEPENDENT in scripts/run-checks.mjs.`,
      );
    }
    if (check.buildFrom === undefined) continue;
    const builder = checks.findIndex(
      (candidate) => candidate.script === check.buildFrom,
    );
    if (builder < 0 || builder >= index || checks[builder].group !== SHARED) {
      throw new Error(
        `${check.script} reads the build of ${check.buildFrom}, which is not a shared check listed before it.`,
      );
    }
  }
}

/**
 * Runs every check past any failure: the shared checks one at a time in list
 * order, then the independent checks `size` at a time, each printed whole when
 * it ends. A `run` that throws fails its own check and no other. Returns each
 * result in list order. With `signals` (the process, when the runner is
 * invoked directly), SIGINT or SIGTERM prints every check still running, with
 * the output it had so far, stops them, and calls `exit` with 128 plus the
 * signal's number.
 *
 */
export async function runAll(
  root,
  log = console.log,
  checks = CHECKS,
  run = runCheck,
  size = poolSize(),
  { signals = null, exit = process.exit } = {},
) {
  assertRunnable(checks);
  if (checks.some((check) => check.usesBuild)) {
    rmSync(resolve(root, BUILD_OUTPUT), { recursive: true, force: true });
  }
  const results = new Map();
  const header = (check) => {
    log(`\n[${checks.indexOf(check) + 1}/${checks.length}] ${check.script}`);
    log(`  ${check.description}`);
  };
  const running = new Map();
  const attempt = async (check, buffer) => {
    const builder = results.get(check.buildFrom);
    if (builder && !builder.ok) {
      return {
        script: check.script,
        ok: false,
        seconds: 0,
        output: `  skipped: the web build it reads failed in ${check.buildFrom}, whose output is above.`,
      };
    }
    const entry = { check, buffer };
    running.set(check.script, entry);
    try {
      return await run(check, root, {
        buffer,
        onStart: (handle) => Object.assign(entry, handle),
      });
    } catch (error) {
      return {
        script: check.script,
        ok: false,
        seconds: 0,
        output: `  the runner could not run it: ${error?.stack ?? error}`,
      };
    } finally {
      running.delete(check.script);
    }
  };
  const print = (result) => {
    if (result.output) log(result.output.replace(/\n$/, ""));
  };

  const interrupt = (signal, code) => {
    for (const { check, buffer, kill, output } of [...running.values()]) {
      if (buffer) header(check);
      log(
        `  interrupted by ${signal}: ${check.script} had not ended${buffer ? "; its output so far follows." : "."}`,
      );
      const partial = buffer ? (output?.() ?? "") : "";
      if (partial) log(partial.replace(/\n$/, ""));
      kill?.();
    }
    exit(code);
  };
  const handlers = signals
    ? [
        ["SIGINT", () => interrupt("SIGINT", 130)],
        ["SIGTERM", () => interrupt("SIGTERM", 143)],
      ]
    : [];
  for (const [signal, handler] of handlers) signals.on(signal, handler);

  try {
    for (const check of checks.filter((entry) => entry.group === SHARED)) {
      header(check);
      const result = await attempt(check, false);
      print(result);
      results.set(check.script, result);
    }

    const queue = checks.filter((entry) => entry.group === INDEPENDENT);
    const worker = async () => {
      for (let check = queue.shift(); check; check = queue.shift()) {
        log(`[start] ${check.script}`);
        const result = await attempt(check, true);
        header(check);
        print(result);
        results.set(check.script, result);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(Math.max(1, size), queue.length) }, worker),
    );
  } finally {
    for (const [signal, handler] of handlers) signals.off(signal, handler);
  }
  return checks.map((check) => results.get(check.script));
}

/**
 * Formats the closing summary: one line per check with the one-minute load
 * average it started under, then the failures. `cpuCount` puts the load in
 * scale; `wallSeconds`, when given, states how long the whole run took.
 *
 */
export function summarize(
  results,
  cpuCount = availableParallelism(),
  wallSeconds,
) {
  const width = Math.max(...results.map((result) => result.script.length));
  const loadText = (load) =>
    typeof load === "number" ? `load ${load.toFixed(2)}` : "load n/a";
  const lines = results.map(
    (result) =>
      `  ${result.ok ? "pass" : "FAIL"}  ${result.script.padEnd(width)}  ${`${result.seconds.toFixed(1)}s`.padStart(7)}  ${loadText(result.load)}`,
  );
  const total = results.reduce((sum, result) => sum + result.seconds, 0);
  const failed = results.filter((result) => !result.ok);
  lines.push(
    `\n${results.length - failed.length} of ${results.length} checks passed in ${total.toFixed(1)}s, on ${cpuCount} CPUs; each load is the one-minute load average when the check started.`,
  );
  if (typeof wallSeconds === "number") {
    lines.push(
      `The run took ${wallSeconds.toFixed(1)}s; the independent checks ran beside each other, so the times above add up to more.`,
    );
  }
  if (failed.length > 0) {
    lines.push(
      `Failed: ${failed.map((result) => result.script).join(", ")}. Each check's output is above, and its reasoning is in its own script header.`,
    );
  }
  return lines.join("\n");
}

/**
 * Formats the `--list` inventory: what runs, then what does not and why.
 *
 */
export function inventory() {
  const lines = [`${CHECKS.length} checks run by \`npm run check:all\`:\n`];
  for (const check of CHECKS) {
    lines.push(`  ${check.script}\n    ${check.description}`);
  }
  lines.push("\nNot run by it:\n");
  for (const check of OUT_OF_CHECK_ALL) {
    lines.push(`  ${check.script}\n    ${check.reason}`);
  }
  for (const step of SEPARATE_WORKFLOW_STEPS) {
    lines.push(`  ${step.command}\n    ${step.reason}`);
  }
  return lines.join("\n");
}

// Only runs when invoked directly, so the test can import the list and the pure
// functions without running the checks.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--list")) {
    console.log(inventory());
  } else {
    const startedAt = Date.now();
    const results = await runAll(
      repositoryRoot(),
      console.log,
      CHECKS,
      runCheck,
      poolSize(),
      { signals: process },
    );
    const summary = summarize(
      results,
      availableParallelism(),
      (Date.now() - startedAt) / 1000,
    );
    const failed = results.some((result) => !result.ok);
    (failed ? console.error : console.log)(`\n${summary}`);
    if (failed) process.exit(1);
  }
}
