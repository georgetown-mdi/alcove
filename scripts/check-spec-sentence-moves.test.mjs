import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  compareRevisions,
  compareSpecFiles,
  formatFailures,
  parseWordingChanges,
  specUnits,
  splitSentences,
} from "./check-spec-sentence-moves.mjs";
import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";
import { rootScripts } from "./run-checks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts/check-spec-sentence-moves.mjs");

const HARD_WRAPPED = `---
title: "Channel security"
---

# Channel security

## Envelope

Every frame is sealed under the session key before it leaves the sender. The
receiver MUST reject a frame whose tag does not verify, and it closes the
channel. This holds only for frames after the handshake.

- A counter orders the frames, and a gap
  is fatal.
- The nonce is never reused.

| Field | Bytes |
| ----- | ----- |
| tag   | 16    |

\`\`\`json
{ "version": 1 }
\`\`\`

## Liveness

A silent peer is dropped after the idle bound.
`;

const MOVED_ENVELOPE = `---
title: "Channel security"
---

# Envelope

Every frame is sealed under the session key before it leaves the sender.
The receiver MUST reject a frame whose tag does not verify,
and it closes the channel.
This holds only for frames after the handshake.

1. A counter orders the frames, and a gap is fatal.
2. The nonce is never reused.

| Field | Bytes |
|---|---|
| tag | 16 |

  \`\`\`json
  { "version": 1 }
  \`\`\`
`;

const LEFT_BEHIND = `# Channel security

## Liveness

A silent peer is dropped after the idle bound.
`;

/** A throwaway repository, so real git decides every range. */
function withRepository(run) {
  const dir = mkdtempSync(resolve(tmpdir(), "spec-sentences-"));
  try {
    for (const args of [
      ["init", "-q", "-b", "staging"],
      ["config", "user.email", "spec-sentences-test@example.invalid"],
      ["config", "user.name", "Spec Sentences Test"],
    ]) {
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    if (text === null) {
      rmSync(resolve(dir, file));
      continue;
    }
    mkdirSync(resolve(dir, dirname(file)), { recursive: true });
    writeFileSync(resolve(dir, file), text);
  }
}

function commit(dir, message) {
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd: dir,
    stdio: "ignore",
  });
}

/** A repository whose staging holds the hard-wrapped file and HEAD a branch. */
function withMove(headFiles, run) {
  withRepository((dir) => {
    write(dir, { "docs/spec/CHANNEL_SECURITY.md": HARD_WRAPPED });
    commit(dir, "base");
    execFileSync("git", ["checkout", "-q", "-b", "move"], { cwd: dir });
    write(dir, headFiles);
    commit(dir, "move");
    run(dir);
  });
}

const PURE_MOVE = {
  "docs/spec/CHANNEL_SECURITY.md": LEFT_BEHIND,
  "docs/spec/ENVELOPE.md": MOVED_ENVELOPE,
};

const ONE_WORD_CHANGED = {
  "docs/spec/CHANNEL_SECURITY.md": LEFT_BEHIND,
  "docs/spec/ENVELOPE.md": MOVED_ENVELOPE.replace(
    "The receiver MUST reject",
    "The receiver SHOULD reject",
  ),
};

const CHANGED_SENTENCE =
  "The receiver MUST reject a frame whose tag does not verify, and it closes the channel.";

describe("the units of a document", () => {
  it("joins a hard-wrapped paragraph and splits it into sentences", () => {
    const sentences = specUnits(HARD_WRAPPED)
      .filter((unit) => unit.kind === "sentence")
      .map((unit) => unit.text);
    expect(sentences).toEqual([
      "Every frame is sealed under the session key before it leaves the sender.",
      CHANGED_SENTENCE,
      "This holds only for frames after the handshake.",
      "A counter orders the frames, and a gap is fatal.",
      "The nonce is never reused.",
      "A silent peer is dropped after the idle bound.",
    ]);
  });

  it("compares a heading by its text, a table row by its cells, and a code block by its lines", () => {
    const units = specUnits(HARD_WRAPPED);
    expect(units).toContainEqual({ kind: "heading", text: "Envelope" });
    expect(units).toContainEqual({ kind: "table row", text: "tag | 16" });
    expect(units).toContainEqual({
      kind: "code line",
      text: '{ "version": 1 }',
    });
    expect(units).toContainEqual({
      kind: "front matter",
      text: 'title: "Channel security"',
    });
    expect(units.some((unit) => unit.text.includes("-----"))).toBe(false);
  });

  it("splits after closing punctuation and keeps a mid-sentence period", () => {
    expect(
      splitSentences('It ends here." Then (a 1.5 KiB cap.) And `x.` done.'),
    ).toEqual(['It ends here."', "Then (a 1.5 KiB cap.)", "And `x.`", "done."]);
  });
});

describe("the comparison", () => {
  it("passes a pure move between files with a reflow to semantic line breaks", () => {
    withMove(PURE_MOVE, (dir) => {
      const comparison = compareRevisions(dir, "staging", "HEAD", []);
      expect(comparison.files.sort()).toEqual([
        "docs/spec/CHANNEL_SECURITY.md",
        "docs/spec/ENVELOPE.md",
      ]);
      expect(comparison.result).toEqual({
        dropped: [],
        added: [],
        unmatched: [],
      });
    });
  });

  it("fails one changed word, naming the sentence on both sides", () => {
    withMove(ONE_WORD_CHANGED, (dir) => {
      const { result } = compareRevisions(dir, "staging", "HEAD", []);
      expect(result.dropped.map((entry) => entry.text)).toEqual([
        CHANGED_SENTENCE,
      ]);
      expect(result.added.map((entry) => entry.text)).toEqual([
        CHANGED_SENTENCE.replace("MUST", "SHOULD"),
      ]);
      const report = formatFailures(result).join("\n");
      expect(report).toContain(
        `dropped sentence in docs/spec/CHANNEL_SECURITY.md:\n    ${CHANGED_SENTENCE}`,
      );
      expect(report).toContain(`- ${CHANGED_SENTENCE} -> -`);
    });
  });

  it("passes the changed word once the body lists it old -> new", () => {
    withMove(ONE_WORD_CHANGED, (dir) => {
      const body = `## Summary\n\nSplit the envelope out.\n\n## Wording changes\n\n<!-- one per line -->\n- ${CHANGED_SENTENCE} -> ${CHANGED_SENTENCE.replace("MUST", "SHOULD")}\n\n## Test plan\n\n- n/a -> n/a\n`;
      const { result } = compareRevisions(
        dir,
        "staging",
        "HEAD",
        parseWordingChanges(body),
      );
      expect(result).toEqual({ dropped: [], added: [], unmatched: [] });
    });
  });

  it("matches an added and a dropped sentence each listed against -", () => {
    const base = new Map([["docs/spec/A.md", "Kept. Dropped one.\n"]]);
    const head = new Map([["docs/spec/A.md", "Kept. Added one.\n"]]);
    expect(compareSpecFiles(base, head, [])).toMatchObject({
      dropped: [{ text: "Dropped one." }],
      added: [{ text: "Added one." }],
    });
    expect(
      compareSpecFiles(base, head, ["Dropped one. -> -", "- -> Added one."]),
    ).toEqual({ dropped: [], added: [], unmatched: [] });
  });

  it("splits a listed line at the separator that matches when a sentence holds one itself", () => {
    const base = new Map([["docs/spec/A.md", "Route it -> PROTOCOL.md.\n"]]);
    const head = new Map([["docs/spec/A.md", "Route it -> FILE_SYNC.md.\n"]]);
    expect(
      compareSpecFiles(base, head, [
        "Route it -> PROTOCOL.md. -> Route it -> FILE_SYNC.md.",
      ]),
    ).toEqual({ dropped: [], added: [], unmatched: [] });
  });

  it("fails a listed line matching no difference", () => {
    const files = new Map([["docs/spec/A.md", "Kept.\n"]]);
    const result = compareSpecFiles(files, files, ["Gone. -> -"]);
    expect(result.unmatched).toEqual(["Gone. -> -"]);
    expect(formatFailures(result).join("\n")).toContain("- Gone. -> -");
  });

  it("pairs a listed line with differences of one kind", () => {
    const base = new Map([
      ["docs/spec/A.md", "# Keys rotate\n\nKeys rotate\n"],
    ]);
    const head = new Map([["docs/spec/A.md", "Keys rotate daily\n"]]);
    expect(
      compareSpecFiles(base, head, ["Keys rotate -> Keys rotate daily"]),
    ).toEqual({
      dropped: [
        expect.objectContaining({ kind: "heading", text: "Keys rotate" }),
      ],
      added: [],
      unmatched: [],
    });
    expect(
      compareSpecFiles(base, head, [
        "Keys rotate -> -",
        "Keys rotate -> -",
        "- -> Keys rotate daily",
      ]),
    ).toEqual({ dropped: [], added: [], unmatched: [] });

    const headingOnly = new Map([["docs/spec/A.md", "# Keys rotate\n"]]);
    expect(
      compareSpecFiles(headingOnly, head, ["Keys rotate -> Keys rotate daily"])
        .unmatched,
    ).toEqual(["Keys rotate -> Keys rotate daily"]);
  });

  it("counts a sentence written twice as two units", () => {
    const base = new Map([["docs/spec/A.md", "Twice.\n\nTwice.\n"]]);
    const head = new Map([["docs/spec/A.md", "Twice.\n"]]);
    expect(compareSpecFiles(base, head, []).dropped).toMatchObject([
      { text: "Twice.", count: 1 },
    ]);
  });

  it("reads only the wording-changes section of the body", () => {
    expect(
      parseWordingChanges(
        "## Changes\n\n- a -> b\n\n## Wording changes\r\n\r\n- c ->  d\r\nprose\n### Note\n- e -> f\n## Checklist\n- g -> h\n",
      ),
    ).toEqual(["c -> d", "e -> f"]);
    expect(parseWordingChanges("## Summary\n\n- a -> b\n")).toEqual([]);
  });

  it("skips fenced blocks in the body", () => {
    expect(
      parseWordingChanges(
        "```\n## Wording changes\n- x -> y\n```\n\n## Wording changes\n\n- c -> d\n```sh\n# comment\n- a -> b\n```\n- e -> f\n\n## Checklist\n",
      ),
    ).toEqual(["c -> d", "e -> f"]);
  });
});

describe("the command", () => {
  function runScript(dir, args, env = {}) {
    const childEnv = { ...process.env };
    delete childEnv.GITHUB_ACTIONS;
    delete childEnv.PR_JSON;
    delete childEnv.PR_BODY;
    Object.assign(childEnv, env);
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      env: childEnv,
      encoding: "utf8",
    });
  }

  it("with no body, prints the section to paste and passes", () => {
    withMove(ONE_WORD_CHANGED, (dir) => {
      const result = runScript(dir, ["--base", "staging"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `## Wording changes\n\n- ${CHANGED_SENTENCE} -> -\n- - -> ${CHANGED_SENTENCE.replace("MUST", "SHOULD")}\n`,
      );
      expect(result.stdout.trim().split("\n").at(-1)).toContain(
        "PR Checklist workflow",
      );
    });
  });

  it("fails the changed word, naming the sentence, and passes it once PR_BODY lists it", () => {
    withMove(ONE_WORD_CHANGED, (dir) => {
      const failing = runScript(dir, ["--base", "staging"], { PR_BODY: "" });
      expect(failing.status, failing.stdout).toBe(1);
      expect(failing.stderr).toContain(CHANGED_SENTENCE);
      expect(failing.stderr).toContain("read from PR_BODY");

      const body = `## Wording changes\n\n- ${CHANGED_SENTENCE} -> ${CHANGED_SENTENCE.replace("MUST", "SHOULD")}\n`;
      const listed = runScript(dir, ["--base", "staging"], { PR_BODY: body });
      expect(listed.status, listed.stderr).toBe(0);
    });
  });

  it("reads the body from the pull request JSON at PR_JSON", () => {
    withMove(ONE_WORD_CHANGED, (dir) => {
      const scratch = mkdtempSync(resolve(tmpdir(), "spec-sentences-pr-"));
      try {
        const json = resolve(scratch, "pull-request.json");
        writeFileSync(
          json,
          JSON.stringify({
            body: `## Wording changes\r\n\r\n- ${CHANGED_SENTENCE} -> ${CHANGED_SENTENCE.replace("MUST", "SHOULD")}\r\n`,
          }),
        );
        const result = runScript(dir, ["--base", "staging"], {
          GITHUB_ACTIONS: "true",
          PR_JSON: json,
        });
        expect(result.status, result.stderr).toBe(0);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  });

  it("passes the pure move, and skips with one line when origin/staging does not resolve", () => {
    withMove(PURE_MOVE, (dir) => {
      const moved = runScript(dir, ["--base", "staging"]);
      expect(moved.status, moved.stderr).toBe(0);
      expect(moved.stdout).toContain("passed over 2 changed files");

      const unresolved = runScript(dir, []);
      expect(unresolved.status, unresolved.stderr).toBe(0);
      expect(unresolved.stdout.trim().split("\n")).toHaveLength(1);
      expect(unresolved.stdout).toContain("origin/staging does not resolve");
    });
  });

  it("passes with one line when no spec file changed", () => {
    const result = runScript(ROOT, ["--base", "HEAD"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no Markdown file under docs/spec/");
  });

  it("exits 2 on an explicit base that does not resolve", () => {
    const result = runScript(ROOT, ["--base", "no-such-ref-for-this-test"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("does not resolve");
  });

  it("passes with one line on the runner when no body is given", () => {
    const result = runScript(ROOT, [], { GITHUB_ACTIONS: "true" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).toContain("PR Checklist workflow");
  });
});

describe("where it runs", () => {
  const scripts = rootScripts(ROOT);

  it("is a root check script", () => {
    expect(scripts["check:spec-sentences"]).toBe(
      "node scripts/check-spec-sentence-moves.mjs",
    );
  });

  it("runs in the PR Checklist workflow with the base branch, the fetched body, and the history to hold both", () => {
    const job = workflowDocument(ROOT, `${WORKFLOW_DIR}/pr_checklist.yaml`)
      .jobs["pr-checklist"];
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout"),
    );
    expect(
      checkout.with?.["fetch-depth"],
      "the spec sentence comparison reads the base branch out of the checkout, which a single-commit fetch does not carry",
    ).toBe(0);
    const step = job.steps.find((candidate) =>
      candidate.run?.includes("npm run check:spec-sentences"),
    );
    expect(step.run).toContain('--base "origin/$GITHUB_BASE_REF"');
    expect(step.env?.PR_JSON).toBe("${{ runner.temp }}/pull-request.json");
  });
});
