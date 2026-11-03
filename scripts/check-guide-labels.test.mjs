import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { parseSource } from "./lib/typeScriptSources.mjs";
import {
  GUIDES_DIR,
  LABEL_SOURCE_DIRS,
  NOT_LABELS,
  boldLabels,
  guideLabelFailures,
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

  it("passes this repository", () => {
    const result = run(repoRoot);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("is run by check:all", () => {
    expect(CHECKS.map(({ script }) => script)).toContain("check:guide-labels");
  });
});
