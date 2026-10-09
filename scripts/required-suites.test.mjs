import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CI_PROVISIONING_STEPS,
  DEFAULT_BASE,
  changedPaths,
  formatPlan,
  MissingBaseError,
  jobDisplayName,
  matchPaths,
  requiredPlan,
  scopePathspecs,
  suiteLegs,
} from "./required-suites.mjs";
import { parseWorkflow, workflowDocument } from "./lib/workflows.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_WORKFLOW = ".github/workflows/cli_build_and_test.yaml";
const WEB_WORKFLOW = ".github/workflows/web_build_and_test.yaml";

const BACKEND_AGNOSTIC =
  "npm run test:integration:backend-agnostic -w apps/cli";
const INTEROP = "npm run test:interop -w apps/web";
const WEB_BROWSER = "npm run test:integration:browser -w apps/web";
const BUILD_CORE = "npm run build -w packages/core";
const BUILD_CLI = "npm run build -w apps/cli";

const legCommands = (plan) =>
  plan.workflows.flatMap((workflow) => workflow.legs.map((leg) => leg.command));

describe("the plan for each path class, read from the live workflows", () => {
  it("runs the CLI integration tiers and interop for a CLI source change", () => {
    const plan = requiredPlan(ROOT, ["apps/cli/src/commands/exchange.ts"]);
    const commands = legCommands(plan);

    expect(commands).toContain(BACKEND_AGNOSTIC);
    expect(commands).toContain(INTEROP);
    expect(commands).not.toContain(WEB_BROWSER);
    expect(plan.builds).toContain(BUILD_CLI);
    expect(plan.builds).not.toContain(BUILD_CORE);
  });

  it("runs both apps' suites and rebuilds core for a core exchange change", () => {
    const plan = requiredPlan(ROOT, ["packages/core/src/exchange/run.ts"]);
    const commands = legCommands(plan);

    expect(commands).toContain(BACKEND_AGNOSTIC);
    expect(commands).toContain(WEB_BROWSER);
    expect(plan.builds[0]).toBe(BUILD_CORE);
  });

  it("runs the web integration and browser suite, after the web build, for web source", () => {
    const plan = requiredPlan(ROOT, ["apps/web/src/main.tsx"]);
    const commands = legCommands(plan);

    expect(commands).toContain(WEB_BROWSER);
    expect(commands).toContain(INTEROP);
    expect(commands).not.toContain(BACKEND_AGNOSTIC);
    expect(
      plan.builds.some((line) => line.endsWith("npm run build -w apps/web")),
    ).toBe(true);
  });

  it("lists a suite both workflows run once", () => {
    const plan = requiredPlan(ROOT, [
      "apps/cli/src/index.ts",
      "apps/web/src/main.tsx",
    ]);

    expect(legCommands(plan).filter((command) => command === INTEROP)).toEqual([
      INTEROP,
    ]);
  });

  it("rebuilds the CLI contract for a change to its sources", () => {
    const plan = requiredPlan(ROOT, ["packages/cli-contract/src/events.ts"]);

    expect(plan.builds).toContain("npm run build -w packages/cli-contract");
  });

  it("names only the gates for documentation and markdown under a scoped root", () => {
    const plan = requiredPlan(ROOT, ["docs/TESTING.md", "apps/web/README.md"]);

    expect(plan.builds).toEqual([]);
    expect(legCommands(plan)).toEqual([]);
    expect(plan.gates).toEqual(
      expect.arrayContaining(["npm run typecheck", "npm run check:all"]),
    );
    expect(plan.gates).not.toContain("npm run audit:production");
  });

  it("prefixes a leg's matrix-valued environment to its command", () => {
    const commands = legCommands(requiredPlan(ROOT, ["apps/cli/src/index.ts"]));

    expect(commands).toContain(
      "ALCOVE_REQUIRE_WORKER_BUILD=1 ALCOVE_SFTP_BACKEND=native npm run test:integration -w apps/cli",
    );
  });

  it("classifies every matrix-conditioned step of both suite jobs", () => {
    for (const path of [CLI_WORKFLOW, WEB_WORKFLOW]) {
      expect(() =>
        suiteLegs(
          workflowDocument(ROOT, path),
          path,
          CI_PROVISIONING_STEPS[path],
        ),
      ).not.toThrow();
    }
  });

  it("names only provisioning steps the workflows still have", () => {
    for (const [path, names] of Object.entries(CI_PROVISIONING_STEPS)) {
      const stepNames = workflowDocument(ROOT, path).jobs.suite.steps.map(
        (step) => step.name,
      );
      for (const name of names) expect(stepNames, path).toContain(name);
    }
  });
});

describe("reading a suite job", () => {
  const workflow = (extraStep) =>
    parseWorkflow(
      "fixture.yaml",
      `
jobs:
  suite:
    strategy:
      matrix:
        include:
          - suite: plain
            command: npm run test -w a
          - suite: built
            command: npm run test:built -w a
            build-a: "true"
            backend: native
    steps:
      - name: Build A
        if: matrix.build-a == 'true'
        run: npm run build -w a
${extraStep}
      - name: Run
        run: \${{ matrix.command }}
        env:
          BACKEND: \${{ matrix.backend }}
          FIXED: "1"
`,
    );

  it("attaches each build to the legs that enable it, and the matrix environment", () => {
    expect(suiteLegs(workflow(""), "fixture.yaml")).toEqual([
      { suite: "plain", command: "npm run test -w a", builds: [] },
      {
        suite: "built",
        command: "BACKEND=native npm run test:built -w a",
        builds: ["npm run build -w a"],
      },
    ]);
  });

  it("refuses a matrix-conditioned step that is neither a build nor provisioning", () => {
    const extra = `      - name: Start a server
        if: matrix.build-a == 'true'
        run: ./start-server.sh`;

    expect(() => suiteLegs(workflow(extra), "fixture.yaml")).toThrow(
      /"Start a server" runs on a matrix condition but is not a build/,
    );
    expect(() =>
      suiteLegs(workflow(extra), "fixture.yaml", ["Start a server"]),
    ).not.toThrow();
  });

  it("reads a conjunction of 'true' matrix keys and refuses any other matrix condition", () => {
    const step = (condition) => `      - name: Build B
        if: ${condition}
        run: npm run build -w b`;

    expect(
      suiteLegs(
        workflow(step("matrix.build-a == 'true' && matrix.backend == 'true'")),
        "fixture.yaml",
      ),
    ).toHaveLength(2);
    for (const condition of [
      "matrix.backend != 'true'",
      "matrix.backend == 'native'",
      "contains(matrix.backend, 'nat')",
      "matrix.backend == 'true' || matrix.build-a == 'true'",
    ]) {
      expect(() =>
        suiteLegs(workflow(step(condition)), "fixture.yaml"),
      ).toThrow(
        /fixture\.yaml: the suite step "Build B" has an unrecognized matrix condition/,
      );
    }
  });

  it("names a matrix job by the values its matrix lists", () => {
    expect(
      jobDisplayName("hardened", {
        name: "Hardened (${{ matrix.profile }})",
        strategy: { matrix: { profile: ["a", "b"] } },
      }),
    ).toBe("Hardened (a, b)");
  });
});

describe("builds of a leg another workflow already listed", () => {
  it("keeps the builds only the later leg enables", () => {
    const root = mkdtempSync(resolve(tmpdir(), "required-suites-"));
    const workflow = (name, build) => `name: ${name}
on:
  pull_request:
jobs:
  scope:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/path-scope
        with:
          paths: |
            fixture/**
  suite:
    needs: scope
    strategy:
      matrix:
        include:
          - suite: shared
            command: npm run test:shared -w fixture
            build-extra: "${build}"
    steps:
      - name: Build extra
        if: matrix.build-extra == 'true'
        run: npm run build -w extra
      - name: Run
        run: \${{ matrix.command }}
`;
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      mkdirSync(resolve(root, ".github/workflows"), { recursive: true });
      writeFileSync(
        resolve(root, ".github/workflows/a.yaml"),
        workflow("A", "false"),
      );
      writeFileSync(
        resolve(root, ".github/workflows/b.yaml"),
        workflow("B", "true"),
      );
      writeFileSync(
        resolve(root, ".github/workflows/static_checks.yaml"),
        "name: S\njobs: {}\n",
      );
      const plan = requiredPlan(root, ["fixture/x.ts"], []);

      expect(legCommands(plan)).toEqual(["npm run test:shared -w fixture"]);
      expect(plan.builds).toContain("npm run build -w extra");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("matching paths with git's pathspecs", () => {
  it("applies globs and exclusions as the path-scope action does", () => {
    const pathspecs = scopePathspecs([
      "apps/web/**",
      "lib/**",
      "Dockerfile",
      "!apps/web/**/*.md",
    ]);

    expect(
      matchPaths(
        ROOT,
        [
          "apps/web/src/a.ts",
          "apps/web/README.md",
          "lib/x.tgz",
          "Dockerfile",
          "Dockerfile.fips",
          "path with space/x.ts",
        ],
        pathspecs,
      ).sort(),
    ).toEqual(["Dockerfile", "apps/web/src/a.ts", "lib/x.tgz"]);
  });
});

describe("the changed paths of a checkout", () => {
  function git(dir, ...args) {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  }

  function write(dir, path, text) {
    mkdirSync(dirname(resolve(dir, path)), { recursive: true });
    writeFileSync(resolve(dir, path), text);
  }

  it("takes a range as given, and by default adds uncommitted and untracked work", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "required-suites-"));
    try {
      git(dir, "init", "-q", "-b", "staging");
      git(dir, "config", "user.email", "required-suites-test@example.invalid");
      git(dir, "config", "user.name", "Required Suites Test");
      write(dir, "base.txt", "base\n");
      write(dir, "edited.txt", "base\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "base");
      git(dir, "update-ref", `refs/remotes/${DEFAULT_BASE}`, "HEAD");
      git(dir, "checkout", "-q", "-b", "work");
      write(dir, "committed.txt", "work\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "work");
      write(dir, "edited.txt", "edited\n");
      write(dir, "new/untracked.txt", "new\n");

      expect(changedPaths(dir, `${DEFAULT_BASE}...HEAD`)).toEqual([
        "committed.txt",
      ]);
      expect(changedPaths(dir)).toEqual([
        "committed.txt",
        "edited.txt",
        "new/untracked.txt",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists a moved file's old and new paths", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "required-suites-"));
    try {
      git(dir, "init", "-q", "-b", "staging");
      git(dir, "config", "user.email", "required-suites-test@example.invalid");
      git(dir, "config", "user.name", "Required Suites Test");
      write(dir, "from/moved.txt", "content that stays the same\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "base");
      git(dir, "update-ref", `refs/remotes/${DEFAULT_BASE}`, "HEAD");
      mkdirSync(resolve(dir, "to"));
      git(dir, "mv", "from/moved.txt", "to/moved.txt");
      git(dir, "commit", "-q", "-m", "move");

      expect(changedPaths(dir, `${DEFAULT_BASE}...HEAD`)).toEqual([
        "from/moved.txt",
        "to/moved.txt",
      ]);
      expect(changedPaths(dir)).toEqual(["from/moved.txt", "to/moved.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops with a message naming the fix when the default base is missing", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "required-suites-"));
    try {
      git(dir, "init", "-q", "-b", "work");
      git(dir, "config", "user.email", "required-suites-test@example.invalid");
      git(dir, "config", "user.name", "Required Suites Test");
      write(dir, "a.txt", "a\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "base");

      expect(() => changedPaths(dir)).toThrow(MissingBaseError);
      expect(() => changedPaths(dir)).toThrow(
        /git fetch origin.*explicit range/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the printed plan", () => {
  it("puts the builds first and the gates last", () => {
    const text = formatPlan(
      requiredPlan(ROOT, ["apps/cli/src/index.ts"]),
      "a fixture",
    );
    const lines = text.split("\n");

    expect(lines[0]).toBe("# Required for a fixture.");
    expect(lines.indexOf(BUILD_CLI)).toBeLessThan(
      lines.indexOf(BACKEND_AGNOSTIC),
    );
    expect(lines.indexOf(BACKEND_AGNOSTIC)).toBeLessThan(
      lines.indexOf("npm run check:all"),
    );
  });

  it("says when no suite applies", () => {
    expect(formatPlan(requiredPlan(ROOT, ["docs/TESTING.md"]), "x")).toContain(
      "only the gates apply",
    );
  });
});
