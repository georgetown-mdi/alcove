import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { parseSource } from "./lib/typeScriptSources.mjs";
import {
  DOCS_DIR,
  GUIDES_DIR,
  LABEL_SOURCE_DIRS,
  NOT_LABELS,
  boldLabels,
  definesRegion,
  guideLabelFailures,
  includeDirectives,
  includeFailures,
  labelIndex,
  sourceStrings,
} from "./check-guide-labels.mjs";
import { CHECKS } from "./run-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-guide-labels.mjs");

const indexOf = (fileName, text) =>
  labelIndex(sourceStrings(parseSource(fileName, text)));

const APP = `
export function Panel({ noun, count }: { noun: string; count: number }) {
  return (
    <div>
      <Button aria-label="Copy the invitation">Save connection</Button>
      <Button>Show full {noun}</Button>
      <p>Exchange complete - {count} matched records</p>
      <p>{count} files</p>
    </div>
  );
}
export const heading = \`Run \${"it"} on a schedule\`;
export const remedy = "Ask your partner " + "for a new invitation.";
`;

describe("boldLabels", () => {
  it("reads bold spans outside code, with their lines", () => {
    const markdown = [
      "Choose **Save connection**.",
      "",
      "```",
      "**Not read**",
      "```",
      "Then `**not read**` and **Copy**.",
    ].join("\n");
    expect(boldLabels(markdown, "guide.md")).toEqual([
      { text: "Save connection", line: 1 },
      { text: "Copy", line: 6 },
    ]);
  });

  it("skips a lead-in and a span holding inline code", () => {
    const markdown =
      "**Your ID column.** Set it. **On SFTP:** read it. **For a folder,** add it. **`alcove.yaml`** stays.";
    expect(boldLabels(markdown, "guide.md")).toEqual([]);
  });
});

describe("labelIndex", () => {
  const index = indexOf("fixture.tsx", APP);

  it("matches JSX text, an aria label, and a run of whole words", () => {
    expect(index.has("Save connection")).toBe(true);
    expect(index.has("Copy the invitation")).toBe(true);
    expect(index.has("the invitation")).toBe(true);
    expect(index.has("ave connection")).toBe(false);
  });

  it("ignores case and runs of whitespace", () => {
    expect(index.has("SAVE  CONNECTION")).toBe(true);
  });

  it("fills an interpolated value with any text", () => {
    expect(index.has("Show full invitation")).toBe(true);
    expect(index.has("Exchange complete - 41 matched records")).toBe(true);
    expect(index.has("Run it on a schedule")).toBe(true);
    expect(index.has("Ask your partner for a new invitation.")).toBe(true);
  });

  it("does not let a string with one word of its own match anything", () => {
    expect(index.has("All files")).toBe(false);
  });

  it("matches no label the sources do not hold", () => {
    expect(index.has("Hide full invitation")).toBe(false);
  });
});

describe("guideLabelFailures", () => {
  const index = indexOf("fixture.tsx", APP);
  const guide = (text) => [{ file: "docs/guides/fixture.md", text }];

  it("passes a guide naming an existing label", () => {
    expect(
      guideLabelFailures(guide("Choose **Save connection**."), index, []),
    ).toEqual([]);
  });

  it("fails a guide naming a missing label, with its line", () => {
    const failures = guideLabelFailures(
      guide("First line.\nChoose **Save the connection**."),
      index,
      [],
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(
      /^docs\/guides\/fixture\.md:2: \*\*Save the connection\*\* matches no string/,
    );
  });

  it("excuses a listed span and fails a listed span no guide uses", () => {
    const notLabels = [
      { text: "Last Run Result", reason: "a Task Scheduler column" },
      { text: "Gone", reason: "no longer in a guide" },
    ];
    const failures = guideLabelFailures(
      guide("Read **Last Run Result**."),
      index,
      notLabels,
    );
    expect(failures).toEqual([
      expect.stringMatching(/^NOT_LABELS lists \*\*Gone\*\*/),
    ]);
  });
});

describe("includeDirectives", () => {
  const read = (text) =>
    includeDirectives(text).map(({ line, ...rest }) => rest);

  it("reads a path, a region and a line range, with the line", () => {
    const found = includeDirectives(
      "Text.\n<!--@include: ./_part.md#app-->\n<!-- @include: ../x.md{2,} -->",
    );
    expect(found).toEqual([
      {
        written: "<!--@include: ./_part.md#app-->",
        target: "./_part.md",
        region: "app",
        line: 2,
      },
      {
        written: "<!-- @include: ../x.md{2,} -->",
        target: "../x.md",
        region: null,
        line: 3,
      },
    ]);
  });

  it("reads a directive anywhere in a line, in code, and several to a line", () => {
    expect(
      read(
        "```md\n<!--@include: a.md-->\n```\nx <!--@include: b.md--> <!--@include: c.md#r-->",
      ),
    ).toHaveLength(3);
  });

  it("reads nothing VitePress leaves as a plain comment", () => {
    expect(read("<!--@Include: a.md-->")).toEqual([]);
    expect(read("<!--@include : a.md-->")).toEqual([]);
    expect(read("<!-- include: a.md -->")).toEqual([]);
  });

  it("keeps a malformed region or range in the path, so the file is missing", () => {
    expect(read("<!--@include: a.md#one#two-->")[0]).toMatchObject({
      target: "a.md#one",
      region: "two",
    });
    expect(read("<!--@include: a.md{7}-->")[0]).toMatchObject({
      target: "a.md{7}",
      region: null,
    });
    expect(read("<!--@include: a.md#two words-->")[0]).toMatchObject({
      target: "a.md#two words",
      region: null,
    });
  });
});

describe("definesRegion", () => {
  const region = (open, close = open.replace("region", "endregion")) =>
    `before\n${open}\ntext\n${close}\nafter`;

  it("finds a region marked with or without the hash", () => {
    expect(definesRegion(region("<!-- #region app -->"), "app")).toBe(true);
    expect(definesRegion(region("<!-- region app -->"), "app")).toBe(true);
    expect(definesRegion(region("  <!-- #region app -->  "), "app")).toBe(true);
  });

  it("finds a region whose two markers differ only in the hash", () => {
    expect(
      definesRegion(
        region("<!-- #region app -->", "<!-- endregion app -->"),
        "app",
      ),
    ).toBe(true);
  });

  it("does not find a region VitePress passes over", () => {
    const missing = [
      region("<!--#region app-->"),
      region("<!--  #region  app  -->"),
      region("<!-- #region app --> extra"),
      region("> <!-- #region app -->"),
      region("<!-- #region App -->"),
      region("<!-- #region app -->", "<!-- #endregion other -->"),
      region("<!-- #region app -->", "<!-- #endregion -->"),
      region("<!-- #region app -->", "<!-- #endregion app --> after"),
      "<!-- #region app -->\ntext",
      "<!-- #region app --> text <!-- #endregion app -->",
    ];
    for (const text of missing) expect(definesRegion(text, "app")).toBe(false);
  });
});

describe("includeFailures", () => {
  const roots = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const PART = "<!-- #region app -->\nShared.\n<!-- #endregion app -->\n";

  function tree(files) {
    const root = mkdtempSync(resolve(tmpdir(), "guide-includes-"));
    roots.push(root);
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(resolve(root, name)), { recursive: true });
      writeFileSync(resolve(root, name), text);
    }
    return root;
  }

  const failuresFor = (files, page = "docs/guides/page.md") => {
    const root = tree(files);
    return includeFailures(root, [{ file: page, text: files[page] }]);
  };

  it("passes an include that resolves, with and without a region", () => {
    const files = {
      "docs/guides/_part.md": PART,
      "docs/guides/page.md":
        "<!--@include: ./_part.md#app-->\n<!--@include: _part.md-->",
    };
    expect(failuresFor(files)).toEqual([]);
  });

  it("resolves a path from the including file, or from the source directory with an @ prefix", () => {
    const files = {
      "docs/shared/_part.md": PART,
      "docs/guides/page.md":
        "<!--@include: ../shared/_part.md#app-->\n<!--@include: @/docs/shared/_part.md#app-->\n<!--@include: @docs/shared/_part.md#app-->",
    };
    expect(failuresFor(files)).toEqual([]);
  });

  it("resolves a leading slash from the including file, as VitePress does", () => {
    const failures = failuresFor({
      "docs/shared/_part.md": PART,
      "docs/guides/page.md": "<!--@include: /docs/shared/_part.md#app-->",
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("names docs/guides/docs/shared/_part.md");
  });

  it("fails an include naming a missing file, with the page, line and include", () => {
    const failures = failuresFor({
      "docs/guides/page.md": "Text.\n<!--@include: ./_gone.md#app-->",
    });
    expect(failures).toEqual([
      "docs/guides/page.md:2: <!--@include: ./_gone.md#app--> names docs/guides/_gone.md, which does not exist, so VitePress leaves the include out without a warning. Correct the path.",
    ]);
  });

  it("fails an include naming a missing region", () => {
    const failures = failuresFor({
      "docs/guides/_part.md": PART,
      "docs/guides/page.md": "<!--@include: ./_part.md#cli-->",
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(
      /^docs\/guides\/page\.md:1: <!--@include: \.\/_part\.md#cli--> names region cli, which docs\/guides\/_part\.md does not define, so VitePress includes the whole file/,
    );
  });

  it("fails an include naming a directory", () => {
    const failures = failuresFor({
      "docs/guides/sub/_x.md": PART,
      "docs/guides/page.md": "<!--@include: ./sub-->",
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("which is not a file");
  });
});

describe("the script", () => {
  const roots = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixtureRoot(guideText) {
    const root = mkdtempSync(resolve(tmpdir(), "guide-labels-"));
    roots.push(root);
    for (const dir of LABEL_SOURCE_DIRS)
      mkdirSync(resolve(root, dir), { recursive: true });
    writeFileSync(resolve(root, LABEL_SOURCE_DIRS[0], "panel.tsx"), APP);
    mkdirSync(resolve(root, GUIDES_DIR), { recursive: true });
    const notLabels = NOT_LABELS.map(({ text }) => `**${text}**`).join(" ");
    writeFileSync(
      resolve(root, GUIDES_DIR, "guide.md"),
      `${guideText}\n\n${notLabels}\n`,
    );
    return root;
  }

  function run(root) {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, "--root", root], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      return {
        status: error.status,
        stdout: error.stdout,
        stderr: error.stderr,
      };
    }
  }

  it("passes a fixture guide naming an existing label", () => {
    const result = run(fixtureRoot("Choose **Save connection**."));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails a fixture guide naming a missing label", () => {
    const result = run(fixtureRoot("Choose **Save the connection**."));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "**Save the connection** matches no string",
    );
  });

  it("passes a fixture include that resolves", () => {
    const root = fixtureRoot("Choose **Save connection**.");
    writeFileSync(
      resolve(root, DOCS_DIR, "guides", "_part.md"),
      "<!-- #region app -->\nShared.\n<!-- #endregion app -->\n",
    );
    writeFileSync(
      resolve(root, DOCS_DIR, "other.md"),
      "<!--@include: ./guides/_part.md#app-->\n",
    );
    const result = run(root);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails a fixture include naming a missing file", () => {
    const root = fixtureRoot("Choose **Save connection**.");
    writeFileSync(
      resolve(root, DOCS_DIR, "other.md"),
      "<!--@include: ./guides/_gone.md#app-->\n",
    );
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/other.md:1: <!--@include: ./guides/_gone.md#app--> names docs/guides/_gone.md, which does not exist",
    );
  });

  it("fails a fixture include naming a missing region", () => {
    const root = fixtureRoot("Choose **Save connection**.");
    writeFileSync(
      resolve(root, DOCS_DIR, "guides", "_part.md"),
      "<!-- #region app -->\nShared.\n<!-- #endregion app -->\n",
    );
    writeFileSync(
      resolve(root, DOCS_DIR, "other.md"),
      "<!--@include: ./guides/_part.md#cli-->\n",
    );
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/other.md:1: <!--@include: ./guides/_part.md#cli--> names region cli, which docs/guides/_part.md does not define",
    );
  });

  it("passes this repository", () => {
    const result = run(repoRoot);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("is run by check:all", () => {
    expect(CHECKS.map(({ script }) => script)).toContain("check:guide-labels");
  });
});
