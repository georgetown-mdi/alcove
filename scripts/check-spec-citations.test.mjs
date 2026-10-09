import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  citableNames,
  citationProblems,
  citations,
  main,
} from "./check-spec-citations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The check reads this file too, so every fixture citation is assembled at
// run time and never appears in the source in a form it would read.
const NAME = ["GUIDE", "md"].join(".");
const SPEC = ["docs", "spec", NAME].join("/");
const GONE_SPEC = ["docs", "spec", ["GONE", "md"].join(".")].join("/");
const UNTRACKED_NAME = ["MISSING", "md"].join(".");
const TRACKED_NAME = ["DESIGN", "md"].join(".");

const GUIDE = [
  "# Guide",
  "",
  "## Upgrading the stack (ssh2 / sftp)",
  "",
  "## The memory ceiling, and the CSV intake cap",
  "",
  "### `warning`",
  "",
  "### Step 4 -- Report what you left",
  "",
  "**Enforcement sites.** Four checks read the field.",
  "",
  "- **A tmpfs for the scratch directory.** Keeps secrets off disk.",
  "",
  "**When an entry is written** under the accounting rules.",
  "",
  "```md",
  "## Not a heading",
  "```",
].join("\n");

const readSpec = (path) => (path === SPEC ? GUIDE : null);
const SPEC_NAMES = new Set([NAME]);

const check = (source, file = "src/example.ts") =>
  citationProblems(
    [{ file, source }],
    readSpec,
    SPEC_NAMES,
    (name) => name === TRACKED_NAME,
  );

describe("spec citation check", () => {
  it("passes on the repository and reports how many citations it resolved", () => {
    const { status, stdout, stderr } = spawnSync(
      "node",
      [resolve(root, "scripts/check-spec-citations.mjs")],
      { cwd: root, encoding: "utf8" },
    );
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toMatch(/passed: [1-9]\d* citations/);
  }, 60_000);

  it("prints the forms it reads and the ones it does not with --help", () => {
    const { status, stdout } = spawnSync(
      "node",
      [resolve(root, "scripts/check-spec-citations.mjs"), "--help"],
      { cwd: root, encoding: "utf8" },
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/^THE FORMS it reads/m);
    expect(stdout).toMatch(/^NOT RESOLVED/m);
    expect(stdout).not.toMatch(/^import /m);
  });

  it("collects headings and bold paragraph labels as slugs, not fenced lines", () => {
    const names = citableNames(GUIDE, SPEC);
    expect(names).toContain("upgrading-the-stack-ssh2--sftp");
    expect(names).toContain("step-4");
    expect(names).toContain("warning");
    expect(names).toContain("enforcement-sites");
    expect(names).toContain("a-tmpfs-for-the-scratch-directory");
    expect(names).toContain("when-an-entry-is-written");
    expect(names).not.toContain("not-a-heading");
  });

  describe("anchored", () => {
    it("resolves an anchor a heading takes", () => {
      expect(
        check(`// ${SPEC}#the-memory-ceiling-and-the-csv-intake-cap`),
      ).toEqual({ problems: [], resolved: 1 });
    });

    it("fails an anchor no heading takes, naming the file and line", () => {
      const { problems } = check(`// one\n// see ${SPEC}#gone-heading.`);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(
        /^src\/example\.ts:2: cites docs\/spec\/GUIDE\.md#gone-heading, but no heading/,
      );
    });
  });

  describe("quoted heading", () => {
    it.each([
      [`// ${SPEC}, "Upgrading the stack (ssh2 / sftp)".`],
      [`// ${NAME} "Upgrading the Stack" covers it.`],
      [`// (${SPEC} ("The memory ceiling and the CSV intake cap"))`],
      [`// ${NAME}'s "Enforcement sites" lists four.`],
      [`// \`${SPEC}\`, "A tmpfs for the scratch directory"`],
      [`// ${SPEC}, "Step 4 -- Report what you left"`],
    ])("resolves %s", (source) => {
      expect(check(source)).toEqual({ problems: [], resolved: 1 });
    });

    it("resolves two words that open a heading", () => {
      expect(check(`// ${SPEC}, "The memory".`)).toEqual({
        problems: [],
        resolved: 1,
      });
    });

    it("resolves a quote equal to a bold paragraph label", () => {
      expect(check(`// ${SPEC}, "When an entry is written".`)).toEqual({
        problems: [],
        resolved: 1,
      });
    });

    it("resolves a label's whole lead sentence", () => {
      expect(
        check(`// ${SPEC}, "Enforcement sites. Four checks read the field."`),
      ).toEqual({ problems: [], resolved: 1 });
    });

    it.each([
      ["one word that opens a longer heading", `"Upgrading"`],
      [
        "a quote that runs on past a heading",
        `"Step 4 -- Report what you left, and more"`,
      ],
    ])("fails %s", (_, quote) => {
      expect(check(`// ${SPEC}, ${quote}.`).problems).toHaveLength(1);
    });

    it("fails quoted text no heading or label matches, naming the file and line", () => {
      const { problems } = check(
        `/**\n * Detail: ${SPEC}, "Retained chunk-count cap".\n */`,
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(
        /^src\/example\.ts:2: cites docs\/spec\/GUIDE\.md, "Retained chunk-count cap", but no heading or bold paragraph label/,
      );
    });
  });

  describe("heading prefix", () => {
    it.each([
      [`// (${SPEC}, The memory ceiling and the CSV intake cap), so each set`],
      [`// (${NAME}, \`warning\`), the event`],
      [`// ${SPEC} (When an entry is written) states it.`],
      [`// See ${SPEC}, Enforcement sites.`],
      [`// See ${SPEC}, Upgrading the stack, for the checklist.`],
    ])("resolves %s", (source) => {
      expect(check(source)).toEqual({ problems: [], resolved: 1 });
    });

    it("fails prefix text that opens no heading or label, naming the file and line", () => {
      const { problems } = check(
        `x;\ny;\n// (${SPEC}, Dual-signed record file).`,
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(
        /^src\/example\.ts:3: cites docs\/spec\/GUIDE\.md, "Dual-signed record file", but no heading/,
      );
    });

    it("fails text that shares only its first word with a heading", () => {
      expect(check(`// ${SPEC}, Upgrading everything.`).problems).toHaveLength(
        1,
      );
    });
  });

  describe("what it does not read", () => {
    it.each([
      [`// ${SPEC}, the \`expires\` row.`],
      [`// The format is specified in ${SPEC}.`],
      [`// ${SPEC} states the rule.`],
      [`readFileSync("${SPEC}", "utf8");`],
      [`docs: ["${SPEC}", "docs/DESIGN.md"],`],
      [`// docs/README.md, Anything at all`],
      [`// ${TRACKED_NAME}, Architecture`],
    ])("passes %s without a citation", (source) => {
      expect(citations(source, SPEC_NAMES, (n) => n === TRACKED_NAME)).toEqual(
        [],
      );
    });
  });

  describe("wrapped citations", () => {
    it("joins quoted text across comment lines", () => {
      expect(
        check(
          `// see ${SPEC}, "The memory\n// ceiling, and the CSV intake cap".`,
        ),
      ).toEqual({ problems: [], resolved: 1 });
    });

    it("joins a section that starts on the next line", () => {
      expect(
        check(`/**\n * Why: ${SPEC},\n * Enforcement sites.\n */`),
      ).toEqual({ problems: [], resolved: 1 });
    });

    it("joins a word broken at a hyphen without a space", () => {
      const spec = GUIDE.replace(
        "Step 4",
        "Writable-and-readable-parent check",
      );
      const { problems, resolved } = citationProblems(
        [
          {
            file: "a.ts",
            source: `// ${SPEC}, "Writable-and-readable-\n// parent check".`,
          },
        ],
        (path) => (path === SPEC ? spec : null),
        SPEC_NAMES,
      );
      expect({ problems, resolved }).toEqual({ problems: [], resolved: 1 });
    });

    it("joins a string literal closed at the line end to the next one", () => {
      const source = [
        "const message = [",
        `  \`Background: ${SPEC}, "The memory ceiling\`,`,
        '  `and the CSV intake cap".`,',
        '  "See " + "x",',
        "];",
      ].join("\n");
      expect(check(source)).toEqual({ problems: [], resolved: 1 });
    });

    it("reports a wrapped dead citation at the line its file reference is on", () => {
      const { problems } = check(`// x\n// see ${SPEC},\n// Gone section.`);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^src\/example\.ts:2: /);
    });
  });

  describe("files that do not exist", () => {
    it("fails a citation into a docs/spec/ path that does not exist", () => {
      const { problems } = check(`// ${GONE_SPEC}#anything`);
      expect(problems).toEqual([
        `src/example.ts:1: cites ${GONE_SPEC}, which does not exist. Point the citation at the spec file that holds the section.`,
      ]);
    });

    it("fails a bare capitalized name no tracked Markdown file has", () => {
      const { problems } = check(`// ${UNTRACKED_NAME}, "Some heading"`);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/does not exist/);
    });
  });
});

describe("spec citation check over a planted tree", () => {
  let dir;

  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("fails on one dead citation of each form, naming each file and line", () => {
    dir = mkdtempSync(resolve(tmpdir(), "spec-citations-"));
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    const files = {
      [SPEC]: GUIDE,
      "src/planted.ts": [
        "// A file with one dead citation of each form.",
        `// ${SPEC}#gone-anchor`,
        "export const a = 1;",
        `// ${SPEC}, "Gone quoted heading"`,
        "export const b = 2;",
        `// See ${SPEC}, Gone prefix heading.`,
        `// See ${SPEC}, Enforcement sites.`,
      ].join("\n"),
    };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(resolve(dir, dirname(file)), { recursive: true });
      writeFileSync(resolve(dir, file), text);
    }
    const errors = [];
    vi.spyOn(console, "error").mockImplementation((line) => errors.push(line));
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(main(dir)).toBe(1);
    expect(errors.slice(0, 3)).toEqual([
      expect.stringMatching(/^src\/planted\.ts:2: cites .*#gone-anchor/),
      expect.stringMatching(
        /^src\/planted\.ts:4: cites .*"Gone quoted heading"/,
      ),
      expect.stringMatching(
        /^src\/planted\.ts:6: cites .*"Gone prefix heading"/,
      ),
    ]);
    expect(errors[3]).toMatch(/3 spec citation\(s\)/);
  });
});
