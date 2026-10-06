import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  citationProblems,
  citations,
  headingNames,
  isCitingFile,
  isInstructionFile,
} from "./check-rule-citations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RULESET = [
  "# Ruleset",
  "",
  "## Models and spawns",
  "",
  "## Step 4 -- Report what you left, and readiness",
  "",
  "```md",
  "## Not a heading",
  "```",
].join("\n");

const readTarget = (path) =>
  path === ".claude/orchestration/ruleset.md" ? RULESET : null;

const check = (source, file = ".claude/commands/example.md") =>
  citationProblems([{ file, source }], readTarget);

describe("rule citation check", () => {
  it("passes on the repository and reports how many citations it resolved", () => {
    const { status, stdout, stderr } = spawnSync(
      "node",
      [resolve(root, "scripts/check-rule-citations.mjs")],
      { cwd: root, encoding: "utf8" },
    );
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toMatch(/passed: [1-9]\d* citations/);
  });

  it("resolves a citation naming an existing heading", () => {
    const result = check(
      "Ask first (`.claude/orchestration/ruleset.md`, Models and spawns).",
    );
    expect(result).toEqual({ problems: [], resolved: 1 });
  });

  it("resolves a citation by the heading's name before its ' -- '", () => {
    const result = check(
      "See `.claude/orchestration/ruleset.md`, Step 4, for the shapes.",
    );
    expect(result).toEqual({ problems: [], resolved: 1 });
  });

  it("fails a citation naming a heading the file does not have", () => {
    const { problems, resolved } = check(
      "Intro.\nAsk first (`.claude/orchestration/ruleset.md`, Agent conventions).",
    );
    expect(resolved).toBe(0);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^\.claude\/commands\/example\.md:2: cites `\.claude\/orchestration\/ruleset\.md`, "Agent conventions\)\."/,
    );
    expect(problems[0]).toContain("Name the heading that holds the rule");
  });

  it("fails a citation whose text only starts like a heading", () => {
    const { problems } = check(
      "See `.claude/orchestration/ruleset.md`, Models and spawnsmanship.",
    );
    expect(problems).toHaveLength(1);
  });

  it("does not resolve a heading that sits in a fenced code block", () => {
    const { problems } = check(
      "See `.claude/orchestration/ruleset.md`, Not a heading.",
    );
    expect(problems).toHaveLength(1);
  });

  it("fails a citation naming a file that does not exist", () => {
    const { problems } = check("See `.claude/gone.md`, Some section.");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("`.claude/gone.md`, which does not exist");
  });

  it("joins section text wrapped onto the next line", () => {
    expect(
      citations(
        "rule in `.claude/orchestration/ruleset.md`,\nModels and spawns, holds it.",
        "x.md",
      ),
    ).toEqual([
      {
        line: 1,
        target: ".claude/orchestration/ruleset.md",
        section: "Models and spawns, holds it.",
      },
    ]);
    expect(
      check(
        "// in `.claude/orchestration/ruleset.md`, Models\n// and spawns.",
        ".claude/hooks/example.mjs",
      ),
    ).toEqual({ problems: [], resolved: 1 });
  });

  it("reads a citation inside a template literal's escaped backticks", () => {
    expect(
      check(
        "`see \\`.claude/orchestration/ruleset.md\\`, Models and spawns.`",
        ".claude/hooks/example.mjs",
      ),
    ).toEqual({ problems: [], resolved: 1 });
  });

  it("does not read prose that only mentions a file", () => {
    for (const source of [
      "Read `CLAUDE.md` and `CONTRIBUTING.md` first.",
      "Read `CLAUDE.md`, `CONTRIBUTING.md`, and the ruleset.",
      "Read `CLAUDE.md`, then the ruleset.",
      "Read `CLAUDE.md`, CONTRIBUTING.md and the ruleset.",
      "Read CLAUDE.md, Agent conventions.",
      "Read [CLAUDE.md](CLAUDE.md), Agent conventions.",
      "Run `scripts/run-checks.mjs`, Then stop.",
    ]) {
      expect(citations(source, "x.md"), source).toEqual([]);
    }
  });

  it("skips citations inside a fenced code block of a Markdown file", () => {
    expect(
      citations(
        "```\nsee `.claude/orchestration/ruleset.md`, Gone.\n```\n",
        "x.md",
      ),
    ).toEqual([]);
  });

  it("names each heading by its whole text and its short name", () => {
    const names = headingNames(
      "## Step 5 -- Recommend the review tier\n#### The width bound: a cap\n",
    );
    expect([...names]).toEqual([
      "Step 5 -- Recommend the review tier",
      "Step 5",
      "The width bound: a cap",
      "The width bound",
    ]);
  });

  it("reads the instruction files and skips tests", () => {
    expect(isCitingFile("CLAUDE.md")).toBe(true);
    expect(isCitingFile(".claude/hooks/block-sleep-poll.mjs")).toBe(true);
    expect(isCitingFile(".claude/hooks/block-sleep-poll.test.mjs")).toBe(false);
    expect(isCitingFile("docs/DESIGN.md")).toBe(false);
    expect(isInstructionFile("docs/spec/PROTOCOL.md")).toBe(true);
    expect(isInstructionFile("README.md")).toBe(false);
  });
});
