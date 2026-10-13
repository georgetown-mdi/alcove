import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  WORDING_CHANGES_DIRECTORY,
  branchListFiles,
  compareRevisions,
  compareSpecFiles,
  defaultBase,
  formatFailures,
  formatWordingChanges,
  listFileFor,
  parseWordingChanges,
  specUnits,
  splitSentences,
  withoutLinkTargets,
} from "./check-spec-sentence-moves.mjs";
import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";
import { CHECKS, rootScripts } from "./run-checks.mjs";

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
function withMove(headFiles, run, baseFiles = {}) {
  withRepository((dir) => {
    write(dir, { "docs/spec/CHANNEL_SECURITY.md": HARD_WRAPPED, ...baseFiles });
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

const CHANGED_SENTENCE_LISTED = `- ${CHANGED_SENTENCE} -> ${CHANGED_SENTENCE.replace("MUST", "SHOULD")}\n`;

/** The list file of the branch `withMove` checks out. */
const BRANCH_LIST = `${WORDING_CHANGES_DIRECTORY}move.txt`;

/** A list file an earlier pull request left on staging. */
const EARLIER_LIST = `${WORDING_CHANGES_DIRECTORY}earlier.txt`;

const LIST_README = `${WORDING_CHANGES_DIRECTORY}README.txt`;

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
      const comparison = compareRevisions(dir, "staging", "HEAD");
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
      const { result } = compareRevisions(dir, "staging", "HEAD");
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

  it("passes the changed word once the branch lists it old -> new in its list file", () => {
    withMove(
      {
        ...ONE_WORD_CHANGED,
        [BRANCH_LIST]: `# A comment.\n\n${CHANGED_SENTENCE_LISTED}`,
      },
      (dir) => {
        const { listFiles, result } = compareRevisions(dir, "staging", "HEAD");
        expect(listFiles).toEqual([BRANCH_LIST]);
        expect(result).toEqual({ dropped: [], added: [], unmatched: [] });
      },
    );
  });

  it("does not read a list file the branch left as the merge base had it", () => {
    withMove(
      PURE_MOVE,
      (dir) => {
        const { listFiles, result } = compareRevisions(dir, "staging", "HEAD");
        expect(listFiles).toEqual([]);
        expect(result).toEqual({ dropped: [], added: [], unmatched: [] });
      },
      { [EARLIER_LIST]: "- Earlier. -> -\n" },
    );
  });

  it("reads the branch's own list file and ignores an earlier one it did not touch", () => {
    withMove(
      { ...ONE_WORD_CHANGED, [BRANCH_LIST]: CHANGED_SENTENCE_LISTED },
      (dir) => {
        const { listFiles, result } = compareRevisions(dir, "staging", "HEAD");
        expect(listFiles).toEqual([BRANCH_LIST]);
        expect(result).toEqual({ dropped: [], added: [], unmatched: [] });
      },
      { [EARLIER_LIST]: `- Earlier. -> -\n${CHANGED_SENTENCE_LISTED}` },
    );
  });

  it("reads every list file the branch added or modified, as one list", () => {
    const [dropped, added] = [
      `- ${CHANGED_SENTENCE} -> -\n`,
      `- - -> ${CHANGED_SENTENCE.replace("MUST", "SHOULD")}\n`,
    ];
    withMove(
      {
        ...ONE_WORD_CHANGED,
        [BRANCH_LIST]: dropped,
        [EARLIER_LIST]: added,
      },
      (dir) => {
        const { listFiles, result } = compareRevisions(dir, "staging", "HEAD");
        expect(listFiles).toEqual([EARLIER_LIST, BRANCH_LIST].sort());
        expect(result).toEqual({ dropped: [], added: [], unmatched: [] });
      },
      { [EARLIER_LIST]: "- Earlier. -> -\n" },
    );
  });

  it("reads only the lines the branch appended to a list file that already held merged entries", () => {
    const merged = "- One. -> -\n- Two. -> -\n- Three. -> -\n";
    const dropped = `- ${CHANGED_SENTENCE} -> -\n`;
    const added = `- - -> ${CHANGED_SENTENCE.replace("MUST", "SHOULD")}\n`;
    withMove(
      { ...ONE_WORD_CHANGED, [BRANCH_LIST]: `${merged}${dropped}${added}` },
      (dir) => {
        const { listFiles, result } = compareRevisions(dir, "staging", "HEAD");
        expect(listFiles).toEqual([BRANCH_LIST]);
        expect(result).toEqual({ dropped: [], added: [], unmatched: [] });
      },
      { [BRANCH_LIST]: merged },
    );
  });

  it("reads neither the directory's README nor a list file the branch deleted", () => {
    withMove(
      {
        ...PURE_MOVE,
        [LIST_README]: "- Not a list. -> -\n",
        [EARLIER_LIST]: null,
      },
      (dir) => {
        expect(branchListFiles(dir, "staging", "HEAD")).toEqual([]);
        const { result } = compareRevisions(dir, "staging", "HEAD");
        expect(result).toEqual({ dropped: [], added: [], unmatched: [] });
      },
      { [LIST_README]: "# The lists.\n", [EARLIER_LIST]: "- Earlier. -> -\n" },
    );
  });

  it("names a branch's list file by the branch, replacing any character outside A-Za-z0-9._-", () => {
    expect(listFileFor("spec-move_2.1")).toBe(
      `${WORDING_CHANGES_DIRECTORY}spec-move_2.1.txt`,
    );
    expect(listFileFor("feature/a b")).toBe(
      `${WORDING_CHANGES_DIRECTORY}feature-a-b.txt`,
    );
    expect(listFileFor(null)).toBe(`${WORDING_CHANGES_DIRECTORY}<branch>.txt`);
    expect(listFileFor("README")).toBe(
      `${WORDING_CHANGES_DIRECTORY}README-branch.txt`,
    );
  });

  it("does not require a unit whose only change is a link target", () => {
    const base = new Map([
      [
        "docs/spec/A.md",
        "The cap is fixed (see [frame cap](#inbound-frame-size-bound)).\n\n| [cap](#cap) | 16 |\n",
      ],
    ]);
    const head = new Map([
      [
        "docs/spec/B.md",
        'The cap is fixed (see [frame cap](limits.md#inbound-frame-size-bound "Bounds")).\n\n| [cap](limits.md#cap) | 16 |\n',
      ],
    ]);
    expect(compareSpecFiles(base, head, [])).toEqual({
      dropped: [],
      added: [],
      unmatched: [],
    });
    expect(
      compareSpecFiles(base, head, [
        "The cap is fixed (see [frame cap](#inbound-frame-size-bound)). -> -",
      ]).unmatched,
    ).toHaveLength(1);
  });

  it("requires a unit whose link text changed with its target", () => {
    const old = "The bounds are in [channel.md](channel.md#bounds).";
    const retargeted = "The bounds are in [limits.md](limits.md#bounds).";
    const base = new Map([["docs/spec/A.md", `${old}\n`]]);
    const head = new Map([["docs/spec/A.md", `${retargeted}\n`]]);
    expect(compareSpecFiles(base, head, [])).toMatchObject({
      dropped: [{ text: old }],
      added: [{ text: retargeted }],
    });
    expect(compareSpecFiles(base, head, [`${old} -> ${retargeted}`])).toEqual({
      dropped: [],
      added: [],
      unmatched: [],
    });
  });

  it("requires a unit whose other words changed beside a retargeted link", () => {
    const base = new Map([["docs/spec/A.md", "See [the cap](#cap) above.\n"]]);
    const head = new Map([
      ["docs/spec/A.md", "See [the cap](limits.md#cap).\n"],
    ]);
    expect(compareSpecFiles(base, head, [])).toMatchObject({
      dropped: [{ text: "See [the cap](#cap) above." }],
      added: [{ text: "See [the cap](limits.md#cap)." }],
    });
  });

  it("compares link-shaped text in a code span or a code line whole", () => {
    expect(withoutLinkTargets("Write `[a](b)` or [a](b) or ![i](c.png).")).toBe(
      "Write `[a](b)` or [a]() or ![i]().",
    );
    expect(withoutLinkTargets("Nest [`x`](a.md#y) and [a](f(x).md).")).toBe(
      "Nest [`x`]() and [a]().",
    );
    const base = new Map([["docs/spec/A.md", "```\n[a](b)\n```\n"]]);
    const head = new Map([["docs/spec/A.md", "```\n[a](c)\n```\n"]]);
    expect(compareSpecFiles(base, head, [])).toMatchObject({
      dropped: [{ kind: "code line", text: "[a](b)" }],
      added: [{ kind: "code line", text: "[a](c)" }],
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

  it("prints a sentence added twice twice, and requires both lines", () => {
    const base = new Map([["docs/spec/A.md", "Kept.\n"]]);
    const head = new Map([["docs/spec/A.md", "Kept.\n\nTwice.\n\nTwice.\n"]]);
    const result = compareSpecFiles(base, head, []);
    expect(result.added).toMatchObject([{ text: "Twice.", count: 2 }]);
    const listed = formatWordingChanges(result);
    expect(listed).toEqual(["- - -> Twice.", "- - -> Twice."]);
    expect(formatFailures(result).join("\n")).toContain(
      "added sentence (2 times) in docs/spec/A.md:",
    );

    expect(
      compareSpecFiles(base, head, parseWordingChanges(listed.join("\n"))),
    ).toEqual({ dropped: [], added: [], unmatched: [] });
    expect(compareSpecFiles(base, head, ["- -> Twice."]).added).toMatchObject([
      { text: "Twice.", count: 1 },
    ]);
  });

  it("reads each `- ` line of the list, skipping blank and `#` lines", () => {
    expect(
      parseWordingChanges(
        "# Header -> comment\r\n\r\n- c ->  d\r\n  - e -> f\n- - -> # a code comment\nstray -> line\n",
      ),
    ).toEqual(["c -> d", "e -> f", "- -> # a code comment", "stray -> line"]);
    expect(parseWordingChanges("# only a header\n")).toEqual([]);
  });
});

describe("the command", () => {
  function runScript(dir, args, env = {}) {
    const childEnv = { ...process.env };
    delete childEnv.GITHUB_BASE_REF;
    delete childEnv.GITHUB_HEAD_REF;
    Object.assign(childEnv, env);
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      env: childEnv,
      encoding: "utf8",
    });
  }

  it("fails the changed word, printing the lines to list, and passes once the branch lists them", () => {
    withMove(ONE_WORD_CHANGED, (dir) => {
      const failing = runScript(dir, ["--base", "staging"]);
      expect(failing.status, failing.stdout).toBe(1);
      expect(failing.stderr).toContain(
        `No file under ${WORDING_CHANGES_DIRECTORY} was added or modified since the merge base, so this branch lists no change; write its list to ${BRANCH_LIST}.`,
      );
      expect(failing.stderr).toContain(`list them in ${BRANCH_LIST},`);
      expect(failing.stderr).toContain(
        `- ${CHANGED_SENTENCE} -> -\n- - -> ${CHANGED_SENTENCE.replace("MUST", "SHOULD")}\n`,
      );

      write(dir, { [BRANCH_LIST]: CHANGED_SENTENCE_LISTED });
      commit(dir, "list");
      const listed = runScript(dir, ["--base", "staging"]);
      expect(listed.status, listed.stderr).toBe(0);
      expect(listed.stdout).toContain("passed over 2 changed files");
    });
  });

  it("names the list file by the pull request's head branch on the runner, and by a placeholder on a detached head", () => {
    withMove(ONE_WORD_CHANGED, (dir) => {
      const onRunner = runScript(dir, ["--base", "staging"], {
        GITHUB_HEAD_REF: "spec/reword",
      });
      expect(onRunner.status, onRunner.stdout).toBe(1);
      expect(onRunner.stderr).toContain(
        `write its list to ${WORDING_CHANGES_DIRECTORY}spec-reword.txt.`,
      );

      execFileSync("git", ["checkout", "-q", "--detach"], { cwd: dir });
      const detached = runScript(dir, ["--base", "staging"]);
      expect(detached.status, detached.stdout).toBe(1);
      expect(detached.stderr).toContain(
        `write its list to ${WORDING_CHANGES_DIRECTORY}<branch>.txt.`,
      );
    });
  });

  it("fails a list naming a change when no spec file changed", () => {
    withMove({ [BRANCH_LIST]: "- Gone. -> -\n" }, (dir) => {
      const result = runScript(dir, ["--base", "staging"]);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toContain("no Markdown file under docs/spec/");
      expect(result.stderr).toContain(
        `Listed in ${BRANCH_LIST} but matching no difference`,
      );
      expect(result.stderr).toContain("  - Gone. -> -");
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

  it("takes the pull request's base branch on the runner", () => {
    expect(defaultBase({ GITHUB_BASE_REF: "main" })).toBe("origin/main");
    expect(defaultBase({ GITHUB_BASE_REF: "" })).toBe("origin/staging");
    expect(defaultBase({})).toBe("origin/staging");
  });

  it("skips with one line on a pull request into a branch other than staging, and still checks one into staging", () => {
    withMove(ONE_WORD_CHANGED, (dir) => {
      const release = runScript(dir, [], { GITHUB_BASE_REF: "main" });
      expect(release.status, release.stderr).toBe(0);
      expect(release.stdout.trim().split("\n")).toHaveLength(1);
      expect(release.stdout).toContain("pull request into main");

      execFileSync(
        "git",
        ["update-ref", "refs/remotes/origin/staging", "staging"],
        { cwd: dir },
      );
      const intoStaging = runScript(dir, [], { GITHUB_BASE_REF: "staging" });
      expect(intoStaging.status, intoStaging.stdout).toBe(1);
      expect(intoStaging.stderr).toContain("merge base with origin/staging");
    });
  });

  it("merges two branches that each change docs/spec/ and write their own list into staging one after the other with no conflict", () => {
    const LIVENESS = "A silent peer is dropped after the idle bound.";
    const branches = [
      {
        branch: "reword",
        file: "docs/spec/CHANNEL_SECURITY.md",
        text: HARD_WRAPPED.replace(
          "receiver MUST reject",
          "receiver SHOULD reject",
        ),
        listed: CHANGED_SENTENCE_LISTED,
      },
      {
        branch: "liveness",
        file: "docs/spec/LIVENESS.md",
        text: LEFT_BEHIND.replace("idle bound", "idle timeout"),
        listed: `- ${LIVENESS} -> ${LIVENESS.replace("idle bound", "idle timeout")}\n`,
      },
    ];
    withRepository((dir) => {
      const gitIn = (args) =>
        spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      write(dir, {
        "docs/spec/CHANNEL_SECURITY.md": HARD_WRAPPED,
        "docs/spec/LIVENESS.md": LEFT_BEHIND,
        [LIST_README]: "# The lists.\n",
        [EARLIER_LIST]: "- Earlier. -> -\n",
      });
      commit(dir, "base");
      for (const { branch, file, text, listed } of branches) {
        gitIn(["checkout", "-q", "-b", branch, "staging"]);
        write(dir, { [file]: text, [listFileFor(branch)]: listed });
        commit(dir, branch);
      }

      for (const { branch } of branches) {
        gitIn(["checkout", "-q", branch]);
        const checked = runScript(dir, ["--base", "staging"]);
        expect(checked.status, checked.stderr).toBe(0);
        expect(checked.stdout).toContain("passed over 1 changed file");
        gitIn(["checkout", "-q", "staging"]);
        const merged = gitIn(["merge", "--no-ff", "-m", branch, branch]);
        expect(merged.status, merged.stdout + merged.stderr).toBe(0);
        expect(merged.stdout + merged.stderr).not.toMatch(/CONFLICT/);
      }
      expect(
        gitIn(["ls-tree", "--name-only", "HEAD", WORDING_CHANGES_DIRECTORY])
          .stdout.trim()
          .split("\n")
          .sort(),
      ).toEqual(
        [
          LIST_README,
          EARLIER_LIST,
          listFileFor("reword"),
          listFileFor("liveness"),
        ].sort(),
      );
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
});

describe("where it runs", () => {
  const scripts = rootScripts(ROOT);

  it("is a root check script that check:all runs", () => {
    expect(scripts["check:spec-sentences"]).toBe(
      "node scripts/check-spec-sentence-moves.mjs",
    );
    expect(CHECKS.map((check) => check.script)).toContain(
      "check:spec-sentences",
    );
  });

  it("runs in a CI job holding the history the merge base needs", () => {
    const job = workflowDocument(ROOT, `${WORKFLOW_DIR}/static_checks.yaml`)
      .jobs["repo-guards"];
    expect(job.steps.some((step) => step.run === "npm run check:all")).toBe(
      true,
    );
    const checkout = job.steps.find((step) =>
      step.uses?.startsWith("actions/checkout"),
    );
    expect(
      checkout.with?.["fetch-depth"],
      "the spec sentence comparison reads the base branch out of the checkout, which a single-commit fetch does not carry",
    ).toBe(0);
  });
});
