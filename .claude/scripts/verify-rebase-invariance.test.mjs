import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createGitFixtures } from "./lib/gitFixture.mjs";
import {
  branchChangedPaths,
  claimFilesOf,
  claimNames,
  collectInvariance,
  hunkIdentity,
  isAncestor,
  parseArguments,
  rebaseShapeError,
  rollUpVerdicts,
  summarizeInvariance,
  violationLine,
} from "./verify-rebase-invariance.mjs";

// The verdicts here rest on real rebases rather than on a model of one: each
// case builds a repository, moves staging under a branch, runs `git rebase`,
// resolves whatever conflict that produces, and asks the verifier about the
// four shas. What the rebase actually did to the branch's diff is the whole
// subject, and it is not something a hand-written diff record can stand in for.
//
// The comparison itself -- comment suppression, the markdown exemption, the
// YAML materialization, and the two cheaper primitives measured wrong -- is
// pinned next door in verify-nonexecutable-delta.test.mjs and is not re-pinned
// here.

const { makeFixture: makeBareFixture, cleanup } = createGitFixtures();

afterEach(cleanup);

const byPath = (results) =>
  Object.fromEntries(results.map((r) => [r.path, r.verdict]));

const NO_CLAIMS = new Set();

/** Seven one-line declarations, the first holding `first`. */
const spaced = (first) =>
  `export const a = ${first};\n` +
  "export const b = 2;\nexport const c = 3;\nexport const d = 4;\n" +
  "export const e = 5;\nexport const f = 6;\nexport const g = 7;\n";

const shared = ({ fixture, oldHead, newBase, newHead, claimFiles }) =>
  collectInvariance({
    oldBase: fixture.oldBase,
    oldHead,
    newBase,
    newHead,
    git: fixture.git,
    claimFiles: claimFiles ?? NO_CLAIMS,
  });

/**
 * A repository whose `staging` branch holds one base commit, with `branch` cut
 * from it and checked out. `oldBase` is the sha the branch was cut from.
 */
function rebaseFixture(baseFiles) {
  const fixture = makeBareFixture("rebase-invariance-");
  for (const [path, text] of Object.entries(baseFiles))
    fixture.write(path, text);
  fixture.commit("Base");
  fixture.git(["branch", "-m", "staging"]);
  fixture.git(["switch", "-q", "-c", "branch"]);
  return { ...fixture, oldBase: fixture.head() };
}

/**
 * Rebase `branch` onto `staging` and return the new head. `resolve` writes the
 * conflict resolution; omitting it asserts the rebase applied cleanly.
 */
function rebaseOntoStaging(fixture, resolve) {
  fixture.git(["switch", "-q", "branch"]);
  const attempt = fixture.run(["rebase", "staging"]);
  if (resolve === undefined) {
    expect(attempt.status).toBe(0);
    return fixture.head();
  }
  expect(attempt.status).not.toBe(0);
  expect(attempt.stdout + attempt.stderr).toMatch(/CONFLICT/);
  resolve();
  fixture.git(["add", "-A"]);
  const continued = fixture.run(["rebase", "--continue"]);
  expect(continued.status).toBe(0);
  return fixture.head();
}

describe("across a real rebase", () => {
  it("holds when the staging range moved code the branch does not touch and only markdown conflicted", () => {
    const fixture = rebaseFixture({
      "src/shared.ts": "export const a = 1;\n",
      "docs/notes.md": "# Notes\n\nThe base line.\n",
    });
    fixture.write("src/branch.ts", "export const b = 1;\n");
    fixture.write("docs/notes.md", "# Notes\n\nThe branch's line.\n");
    const oldHead = fixture.commit("Branch work");

    fixture.git(["switch", "-q", "staging"]);
    fixture.write("src/shared.ts", "export const a = 2;\n");
    fixture.write("docs/notes.md", "# Notes\n\nStaging's line.\n");
    const newBase = fixture.commit("Staging moves on");

    const newHead = rebaseOntoStaging(fixture, () =>
      fixture.write(
        "docs/notes.md",
        "# Notes\n\nStaging's line.\n\nThe branch's line.\n",
      ),
    );

    const { results } = collectInvariance({
      oldBase: fixture.oldBase,
      oldHead,
      newBase,
      newHead,
      git: fixture.git,
      claimFiles: NO_CLAIMS,
    });
    expect(byPath(results)).toEqual({
      "docs/notes.md": "exempt",
      "src/branch.ts": "identical",
    });
    expect(summarizeInvariance(results)).toMatchObject({
      holds: true,
      exitCode: 0,
    });

    // The moved code is what the two heads disagree on, and it is outside the
    // branch's own diff: this is the composition with unread staging content
    // that `.claude/commands/assess-review.md`, Step 4, admits, stated here as a measurement rather
    // than left implicit in a passing verdict.
    expect(
      fixture.git(["diff", "--name-only", oldHead, newHead]).split("\n"),
    ).toContain("src/shared.ts");
  });

  it("holds when the branch rewrites its spec wording-change list as it rebases cleanly onto another branch's list", () => {
    const list = "docs/spec/wording-changes/branch.txt";
    const fixture = rebaseFixture({
      "docs/spec/wording-changes/README.txt": "# The lists.\n",
      "src/shared.ts": "export const a = 1;\n",
    });
    fixture.write(list, "- old -> branch\n");
    const oldHead = fixture.commit("Branch list");

    fixture.git(["switch", "-q", "staging"]);
    fixture.write("docs/spec/wording-changes/other.txt", "- old -> other\n");
    const newBase = fixture.commit("Another branch's list");

    rebaseOntoStaging(fixture);
    fixture.write(list, "- old -> branch, reworded\n");
    fixture.git(["commit", "-q", "--amend", "-a", "--no-edit"]);
    const newHead = fixture.head();

    const { results, unreadable } = collectInvariance({
      oldBase: fixture.oldBase,
      oldHead,
      newBase,
      newHead,
      git: fixture.git,
      claimFiles: NO_CLAIMS,
    });
    expect(unreadable).toEqual([]);
    expect(byPath(results)).toEqual({ [list]: "exempt" });
    expect(summarizeInvariance(results)).toMatchObject({
      holds: true,
      exitCode: 0,
    });
  });

  it("holds when the branch deletes the legacy wording-change file that the staging range also changed", () => {
    const legacy = "docs/spec/wording-changes.txt";
    const list = "docs/spec/wording-changes/branch.txt";
    const fixture = rebaseFixture({
      [legacy]: "- old -> base\n",
      "src/shared.ts": "export const a = 1;\n",
    });
    fixture.remove(legacy);
    fixture.write(list, "- old -> branch\n");
    const oldHead = fixture.commit("Move the list");

    fixture.git(["switch", "-q", "staging"]);
    fixture.write(legacy, "- old -> staging\n");
    const newBase = fixture.commit("Staging rewrites the legacy list");

    const newHead = rebaseOntoStaging(fixture, () => fixture.remove(legacy));

    const { results, unreadable } = collectInvariance({
      oldBase: fixture.oldBase,
      oldHead,
      newBase,
      newHead,
      git: fixture.git,
      claimFiles: NO_CLAIMS,
    });
    expect(unreadable).toEqual([]);
    expect(byPath(results)).toEqual({
      [legacy]: "exempt",
      [list]: "identical",
    });
    expect(summarizeInvariance(results)).toMatchObject({
      holds: true,
      exitCode: 0,
    });
  });

  it("holds when the branch modifies the legacy wording-change file that staging deleted and the resolution moves it to a per-branch list", () => {
    const legacy = "docs/spec/wording-changes.txt";
    const list = "docs/spec/wording-changes/branch.txt";
    const fixture = rebaseFixture({
      [legacy]: "- old -> base\n",
      "src/shared.ts": "export const a = 1;\n",
    });
    fixture.write(legacy, "- old -> branch\n");
    const oldHead = fixture.commit("Branch list");

    fixture.git(["switch", "-q", "staging"]);
    fixture.remove(legacy);
    fixture.write("docs/spec/wording-changes/README.txt", "# The lists.\n");
    const newBase = fixture.commit("Staging splits the list");

    const newHead = rebaseOntoStaging(fixture, () => {
      fixture.remove(legacy);
      fixture.write(list, "- old -> branch\n");
    });

    const { results, unreadable } = collectInvariance({
      oldBase: fixture.oldBase,
      oldHead,
      newBase,
      newHead,
      git: fixture.git,
      claimFiles: NO_CLAIMS,
    });
    expect(unreadable).toEqual([]);
    expect(byPath(results)).toEqual({
      [legacy]: "exempt",
      [list]: "exempt",
    });
    expect(summarizeInvariance(results)).toMatchObject({
      holds: true,
      exitCode: 0,
    });
  });

  it("violates when the conflict resolution changed an executable line", () => {
    const fixture = rebaseFixture({
      "src/shared.ts": "// the shared note\nexport const a = 1;\n",
    });
    fixture.write(
      "src/shared.ts",
      "// the branch's own note\nexport const a = 1;\n",
    );
    const oldHead = fixture.commit("Reword the note");

    fixture.git(["switch", "-q", "staging"]);
    fixture.write(
      "src/shared.ts",
      "// staging's own note\nexport const a = 1;\n",
    );
    const newBase = fixture.commit("Reword it differently");

    const newHead = rebaseOntoStaging(fixture, () =>
      fixture.write(
        "src/shared.ts",
        "// the merged note\nexport const a = 2;\n",
      ),
    );

    const { results } = collectInvariance({
      oldBase: fixture.oldBase,
      oldHead,
      newBase,
      newHead,
      git: fixture.git,
      claimFiles: NO_CLAIMS,
    });
    expect(byPath(results)).toEqual({ "src/shared.ts": "executable-delta" });
    const summary = summarizeInvariance(results);
    expect(summary).toMatchObject({ holds: false, exitCode: 1 });
    expect(summary.first).toMatchObject({
      path: "src/shared.ts",
      where: "head",
    });
  });

  it("holds when the staging range changed a file the branch also changed, outside the branch's hunks", () => {
    const fixture = rebaseFixture({ "src/shared.ts": spaced(1) });
    fixture.write("src/shared.ts", spaced(1) + "export const h = 8;\n");
    const oldHead = fixture.commit("Append to the shared file");

    fixture.git(["switch", "-q", "staging"]);
    fixture.write("src/shared.ts", spaced(11));
    const newBase = fixture.commit("Change the same file at the top");

    // Far enough apart that the rebase applies with no conflict: the branch's
    // own patch is untouched, and the file it lands on is not.
    const newHead = rebaseOntoStaging(fixture);

    const { results } = shared({ fixture, oldHead, newBase, newHead });
    expect(byPath(results)).toEqual({ "src/shared.ts": "same-hunks" });
    expect(summarizeInvariance(results)).toMatchObject({
      holds: true,
      exitCode: 0,
    });
  });

  it("violates when a review claim names the shared file, though the branch's hunks are unchanged", () => {
    const fixture = rebaseFixture({ "src/shared.ts": spaced(1) });
    fixture.write("src/shared.ts", spaced(1) + "export const h = 8;\n");
    const oldHead = fixture.commit("Append to the shared file");
    fixture.git(["switch", "-q", "staging"]);
    fixture.write("src/shared.ts", spaced(11));
    const newBase = fixture.commit("Change the same file at the top");
    const newHead = rebaseOntoStaging(fixture);

    const claimFiles = claimFilesOf(
      JSON.stringify({ round: 1, kind: "light", clusters: [] }) +
        "\n" +
        JSON.stringify({
          round: 2,
          kind: "security-reviewer",
          claims: [{ claim: "c", verdict: "HOLDS", file: "src/shared.ts" }],
        }) +
        "\n",
    );
    const { results } = shared({
      fixture,
      oldHead,
      newBase,
      newHead,
      claimFiles,
    });
    expect(byPath(results)).toEqual({ "src/shared.ts": "claim-named" });
    const summary = summarizeInvariance(results);
    expect(summary).toMatchObject({ holds: false, exitCode: 1 });
    expect(violationLine(summary.first)).toMatch(/a review claim names it/);
  });

  it("violates when the staging change overlaps a branch hunk's context and the rebase still applies", () => {
    const fixture = rebaseFixture({ "src/shared.ts": spaced(1) });
    fixture.write(
      "src/shared.ts",
      spaced(1).replace("export const d = 4;\n", "export const d = 44;\n"),
    );
    const oldHead = fixture.commit("Change d");

    fixture.git(["switch", "-q", "staging"]);
    fixture.write(
      "src/shared.ts",
      spaced(1).replace("export const b = 2;\n", "export const b = 22;\n"),
    );
    const newBase = fixture.commit("Change b, two lines above d");

    const newHead = rebaseOntoStaging(fixture);

    const { results } = shared({ fixture, oldHead, newBase, newHead });
    expect(byPath(results)).toEqual({ "src/shared.ts": "executable-delta" });
    const summary = summarizeInvariance(results);
    expect(summary).toMatchObject({ holds: false, exitCode: 1 });
    expect(summary.first).toMatchObject({ where: "hunks" });
  });

  it("violates when the conflict resolution changed a branch hunk in a file the staging range changed", () => {
    const fixture = rebaseFixture({ "src/shared.ts": spaced(1) });
    fixture.write("src/shared.ts", spaced(1).replace("= 1;", "= 100;"));
    const oldHead = fixture.commit("Change a");

    fixture.git(["switch", "-q", "staging"]);
    fixture.write("src/shared.ts", spaced(11));
    const newBase = fixture.commit("Change a differently");

    const newHead = rebaseOntoStaging(fixture, () =>
      fixture.write("src/shared.ts", spaced(111)),
    );

    const { results } = shared({ fixture, oldHead, newBase, newHead });
    expect(byPath(results)).toEqual({ "src/shared.ts": "executable-delta" });
    expect(summarizeInvariance(results)).toMatchObject({
      holds: false,
      exitCode: 1,
    });
  });

  it("violates when the rebased branch adds a hunk to a shared file that it did not change before", () => {
    const fixture = rebaseFixture({
      "src/shared.ts": spaced(1),
      "src/branch.ts": "export const b = 1;\n",
    });
    fixture.write("src/branch.ts", "export const b = 2;\n");
    const oldHead = fixture.commit("Branch work");

    fixture.git(["switch", "-q", "staging"]);
    fixture.write("src/shared.ts", spaced(11));
    const newBase = fixture.commit("Staging changes the shared file");

    rebaseOntoStaging(fixture);
    fixture.write("src/shared.ts", spaced(11) + "export const h = 8;\n");
    const newHead = fixture.commit("Further branch work");

    const { results } = shared({ fixture, oldHead, newBase, newHead });
    expect(byPath(results)).toEqual({
      "src/branch.ts": "identical",
      "src/shared.ts": "executable-delta",
    });
  });

  it("holds when the only change beside a branch hunk is a staging comment", () => {
    const fixture = rebaseFixture({ "src/shared.ts": spaced(1) });
    fixture.write(
      "src/shared.ts",
      spaced(1).replace("export const d = 4;\n", "export const d = 44;\n"),
    );
    const oldHead = fixture.commit("Change d");

    fixture.git(["switch", "-q", "staging"]);
    fixture.write(
      "src/shared.ts",
      "// staging's note\n" +
        spaced(1).replace(
          "export const b = 2;\n",
          "export const b = 2; // why\n",
        ) +
        "export const z = 9;\n",
    );
    const newBase = fixture.commit("Append z, and comment two lines above d");

    const newHead = rebaseOntoStaging(fixture);

    const { results } = shared({ fixture, oldHead, newBase, newHead });
    expect(byPath(results)).toEqual({ "src/shared.ts": "same-hunks" });
  });

  it("violates when the branch's string literal lost only whitespace across the rebase", () => {
    const fixture = rebaseFixture({ "src/shared.ts": spaced(1) });
    fixture.write("src/shared.ts", spaced(1) + 'export const s = "a b";\n');
    const oldHead = fixture.commit("Add s");

    fixture.git(["switch", "-q", "staging"]);
    fixture.write("src/shared.ts", spaced(11));
    const newBase = fixture.commit("Change a");

    rebaseOntoStaging(fixture);
    fixture.write("src/shared.ts", spaced(11) + 'export const s = "ab";\n');
    fixture.git(["commit", "-q", "--amend", "-a", "--no-edit"]);
    const newHead = fixture.head();

    const { results } = shared({ fixture, oldHead, newBase, newHead });
    expect(byPath(results)).toEqual({ "src/shared.ts": "executable-delta" });
  });

  it("fails closed on a shared source file that does not parse at one end", () => {
    const fixture = rebaseFixture({ "src/shared.ts": spaced(1) });
    fixture.write("src/shared.ts", spaced(1) + "export const h = 8;\n");
    const oldHead = fixture.commit("Append to the shared file");

    fixture.git(["switch", "-q", "staging"]);
    fixture.write("src/shared.ts", "export const = ;\n" + spaced(1));
    const newBase = fixture.commit("Break the top of the file");

    const newHead = rebaseOntoStaging(fixture);

    const { results } = shared({ fixture, oldHead, newBase, newHead });
    expect(byPath(results)).toEqual({ "src/shared.ts": "unverifiable" });
  });

  it("keeps the two-ended comparison for a shared YAML file", () => {
    const yamlLines = (first) =>
      `a: ${first}\nb: 2\nc: 3\nd: 4\ne: 5\nf: 6\ng: 7\n`;
    const fixture = rebaseFixture({ "config.yaml": yamlLines(1) });
    fixture.write("config.yaml", yamlLines(1) + "h: 8\n");
    const oldHead = fixture.commit("Append to the shared file");

    fixture.git(["switch", "-q", "staging"]);
    fixture.write("config.yaml", yamlLines(11));
    const newBase = fixture.commit("Change the same file at the top");

    const newHead = rebaseOntoStaging(fixture);

    const { results } = shared({ fixture, oldHead, newBase, newHead });
    expect(byPath(results)).toEqual({ "config.yaml": "executable-delta" });
  });

  it("fails closed on a path it cannot read for executable content", () => {
    const fixture = rebaseFixture({
      "package.json": '{\n  "name": "fixture",\n  "private": true\n}\n',
    });
    fixture.write(
      "package.json",
      '{\n  "name": "fixture",\n  "private": true,\n  "version": "1.0.0"\n}\n',
    );
    const oldHead = fixture.commit("Add a version");

    fixture.git(["switch", "-q", "staging"]);
    fixture.write(
      "package.json",
      '{\n  "name": "renamed",\n  "private": true\n}\n',
    );
    const newBase = fixture.commit("Rename the package");

    const newHead = rebaseOntoStaging(fixture, () =>
      fixture.write(
        "package.json",
        '{\n  "name": "renamed",\n  "private": true,\n  "version": "1.0.0"\n}\n',
      ),
    );

    const { results } = collectInvariance({
      oldBase: fixture.oldBase,
      oldHead,
      newBase,
      newHead,
      git: fixture.git,
      claimFiles: NO_CLAIMS,
    });
    expect(byPath(results)).toEqual({ "package.json": "unverifiable" });
    expect(summarizeInvariance(results)).toMatchObject({
      holds: false,
      exitCode: 1,
    });
  });

  it("compares nothing, and holds, for a branch whose own diff is empty", () => {
    const fixture = rebaseFixture({ "src/shared.ts": "export const a = 1;\n" });
    fixture.git(["commit", "-q", "--allow-empty", "-m", "Empty branch work"]);
    const oldHead = fixture.head();

    fixture.git(["switch", "-q", "staging"]);
    fixture.write("src/shared.ts", "export const a = 2;\n");
    const newBase = fixture.commit("Staging moves on");

    const newHead = rebaseOntoStaging(fixture);

    // The staging range moved code, so a comparison that fell back to every
    // path would report a delta here.
    const { results } = collectInvariance({
      oldBase: fixture.oldBase,
      oldHead,
      newBase,
      newHead,
      git: fixture.git,
      claimFiles: NO_CLAIMS,
    });
    expect(results).toEqual([]);
    expect(summarizeInvariance(results)).toMatchObject({
      holds: true,
      exitCode: 0,
    });
  });
});

describe("the shape the path applies to", () => {
  /** A branch, its attested head, and a staging commit under it, unrebased. */
  function divergedFixture() {
    const fixture = rebaseFixture({ "src/shared.ts": "export const a = 1;\n" });
    fixture.write("src/branch.ts", "export const b = 1;\n");
    const oldHead = fixture.commit("Branch work");
    fixture.git(["switch", "-q", "staging"]);
    fixture.write("docs/notes.md", "# Notes\n");
    const newBase = fixture.commit("Staging moves on");
    fixture.git(["switch", "-q", "branch"]);
    return { ...fixture, oldHead, newBase };
  }

  it("accepts a rebase", () => {
    const fixture = divergedFixture();
    const newHead = rebaseOntoStaging(fixture);
    expect(
      rebaseShapeError({
        oldBase: fixture.oldBase,
        oldHead: fixture.oldHead,
        newBase: fixture.newBase,
        newHead,
        git: fixture.git,
      }),
    ).toBeNull();
  });

  it("refuses a base-sync merge, whose head descends from the attested one", () => {
    const fixture = divergedFixture();
    fixture.git(["merge", "-q", "--no-ff", "-m", "Merge staging", "staging"]);
    const newHead = fixture.head();
    expect(
      rebaseShapeError({
        oldBase: fixture.oldBase,
        oldHead: fixture.oldHead,
        newBase: fixture.newBase,
        newHead,
        git: fixture.git,
      }),
    ).toMatch(/is an ancestor of .* by a merge or by added work/);
  });

  it("refuses a base that is not its head's base", () => {
    const fixture = divergedFixture();
    const newHead = rebaseOntoStaging(fixture);
    expect(
      rebaseShapeError({
        oldBase: fixture.newBase,
        oldHead: fixture.oldHead,
        newBase: fixture.newBase,
        newHead,
        git: fixture.git,
      }),
    ).toMatch(/is not an ancestor of the pre-rebase head/);
  });

  it("refuses the two ends given in the wrong order", () => {
    const fixture = divergedFixture();
    const newHead = rebaseOntoStaging(fixture);
    expect(
      rebaseShapeError({
        oldBase: fixture.newBase,
        oldHead: newHead,
        newBase: fixture.oldBase,
        newHead: fixture.oldHead,
        git: fixture.git,
      }),
    ).toMatch(/does not descend from the pre-rebase base/);
  });

  it("throws a git error rather than answering the ancestry question false", () => {
    const fixture = divergedFixture();
    expect(
      isAncestor({
        ancestor: fixture.oldBase,
        descendant: fixture.oldHead,
        git: fixture.git,
      }),
    ).toBe(true);
    expect(() =>
      isAncestor({
        ancestor: "no-such-ref-9f3c1a",
        descendant: fixture.oldHead,
        git: fixture.git,
      }),
    ).toThrow();
  });
});

describe("path collection", () => {
  it("leaves the run with no verdicts when a diff record has a shape it cannot read", () => {
    const git = (args) =>
      args[0] === "diff" ? ":100644 100644 aaa bbb Xnn\0src/a.ts\0" : "";
    expect(
      branchChangedPaths({ base: "a", head: "b", git }).unreadable,
    ).toEqual([":100644 100644 aaa bbb Xnn"]);
    const collected = collectInvariance({
      oldBase: "a",
      oldHead: "b",
      newBase: "c",
      newHead: "d",
      git,
      claimFiles: NO_CLAIMS,
    });
    expect(collected.results).toEqual([]);
    expect(collected.unreadable).toHaveLength(2);
  });
});

describe("hunk identity, as real git patch-id computes it", () => {
  const add = (text) =>
    text.replace("export const d = 4;\n", "$&const x = 1;\n");

  it("is empty for an unchanged text, and ignores where in the file a hunk sits", () => {
    expect(hunkIdentity(spaced(1), spaced(1))).toBe("");
    const shifted = "export const z = 0;\n".repeat(9) + spaced(1);
    expect(hunkIdentity(spaced(1), add(spaced(1)))).toMatch(/^[0-9a-f]{40}$/);
    expect(hunkIdentity(shifted, add(shifted))).toBe(
      hunkIdentity(spaced(1), add(spaced(1))),
    );
  });

  it("counts the three context lines on each side and nothing past them", () => {
    const inContext = spaced(1).replace("= 2;", "= 22;");
    const pastContext = spaced(11);
    const id = hunkIdentity(spaced(1), add(spaced(1)));
    expect(hunkIdentity(inContext, add(inContext))).not.toBe(id);
    expect(hunkIdentity(pastContext, add(pastContext))).toBe(id);
  });
});

describe("the claims a ledger names", () => {
  it("collects every claim's file from every row, and throws on a line that is not an object", () => {
    const ledger =
      [
        { round: 1, kind: "light", clusters: [{ file: "src/lens.ts" }] },
        {
          round: 2,
          kind: "security-reviewer",
          claims: [
            { claim: "c", verdict: "HOLDS", file: "src/a.ts" },
            { claim: "d", verdict: "HOLDS", file: "" },
          ],
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n";
    expect(claimFilesOf(ledger)).toEqual(new Set(["src/a.ts"]));
    expect(() => claimFilesOf(ledger + "[1]\n")).toThrow(/line 3/);
    expect(() => claimFilesOf("not json\n")).toThrow();
  });

  it("matches a claim whose file contains the path", () => {
    const files = new Set(["src/a.ts:10-20", "src/b.ts"]);
    expect(claimNames(files, "src/a.ts")).toBe(true);
    expect(claimNames(files, "src/b.ts")).toBe(true);
    expect(claimNames(files, "src/c.ts")).toBe(false);
  });
});

describe("the command line", () => {
  it("takes four refs and a ledger in either order", () => {
    const want = {
      oldBase: "a",
      oldHead: "b",
      newBase: "c",
      newHead: "d",
      ledger: "l",
    };
    expect(parseArguments([..."abcd", "--ledger", "l"])).toEqual(want);
    expect(parseArguments(["--ledger", "l", ..."abcd"])).toEqual(want);
    expect(parseArguments([..."abcd"])).toBeNull();
    expect(
      parseArguments([..."abcd", "--ledger", "l", "--ledger", "m"]),
    ).toBeNull();
  });
});

describe("rolling the two comparisons into one verdict per path", () => {
  const roll = (base, head) =>
    rollUpVerdicts({ paths: new Set(["p"]), base, head });

  it("treats a path neither comparison reports as identical", () => {
    expect(roll([], [])).toEqual([
      { path: "p", verdict: "identical", where: null },
    ]);
  });

  it("takes the worse of the two ends, and names which end it came from", () => {
    expect(
      roll(
        [{ path: "p", verdict: "comment-only" }],
        [{ path: "p", verdict: "executable-delta" }],
      ),
    ).toEqual([{ path: "p", verdict: "executable-delta", where: "head" }]);
    expect(
      roll(
        [{ path: "p", verdict: "unverifiable", reason: "why" }],
        [{ path: "p", verdict: "executable-delta" }],
      ),
    ).toEqual([
      { path: "p", verdict: "unverifiable", where: "base", reason: "why" },
    ]);
  });

  it("holds only where every path is identical, exempt, or comment-only", () => {
    expect(
      summarizeInvariance([
        { path: "a", verdict: "identical" },
        { path: "b", verdict: "exempt" },
        { path: "c", verdict: "comment-only" },
      ]),
    ).toMatchObject({ holds: true, exitCode: 0, first: null });
    expect(
      summarizeInvariance([
        { path: "a", verdict: "comment-only" },
        { path: "b", verdict: "unverifiable" },
      ]).first,
    ).toMatchObject({ path: "b" });
  });

  it("names what the violated end could not say about the path", () => {
    expect(
      violationLine({
        path: "a.ts",
        verdict: "executable-delta",
        where: "base",
      }),
    ).toBe("a.ts changed at the branch's base");
    expect(
      violationLine({ path: "a.ts", verdict: "unverifiable", where: "head" }),
    ).toBe("a.ts could not be verified at the branch's head");
  });
});

const SCRIPT = fileURLToPath(
  new URL("./verify-rebase-invariance.mjs", import.meta.url),
);

const runScript = (args, cwd = dirname(SCRIPT)) => {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    return { status: error.status, stdout: error.stdout, stderr: error.stderr };
  }
};

/** A ledger file whose rows name no claim, in a directory the suite removes. */
const emptyLedger = () => {
  const fixture = makeBareFixture("rebase-ledger-");
  fixture.write("ledger.jsonl", '{"round": 1, "kind": "light"}\n');
  return join(fixture.dir, "ledger.jsonl");
};

describe("the script as an agent runs it", () => {
  // Five cold Node spawns in one case: 1.4s together alone against vitest's 5s
  // default, and 11.4s with the rest of the script suites competing for the same
  // cores, which is the contention that reddened it. Sized well past that worst
  // measurement, this stays a hang safety check rather than a claim about how
  // fast a process starts.
  const USAGE_SPAWN_TIMEOUT_MS = 60_000;

  it(
    "prints usage and exits 2 unless given exactly four refs and a ledger",
    () => {
      for (const args of [
        [],
        "abcd".split(""),
        ["a", "b", "c", "--ledger", "l"],
        [..."abcde", "--ledger", "l"],
        [..."abcd", "--ledger"],
      ]) {
        const result = runScript(args);
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(
          /^Usage: node \.claude\/scripts\/verify-rebase-invariance\.mjs /,
        );
        expect(result.stdout).toBe("");
      }
    },
    USAGE_SPAWN_TIMEOUT_MS,
  );

  // Measured alone at 360-490ms across repeated runs, and past vitest's 5s
  // default -- an outright timeout -- once under contention with the full
  // `npm test` fan-out. Sized at roughly five times that default.
  const SOUNDNESS_PROBE_TIMEOUT_MS = 30_000;

  it(
    "exits 2 when a ref does not resolve, rather than reporting a verdict",
    { timeout: SOUNDNESS_PROBE_TIMEOUT_MS },
    () => {
      const result = runScript([
        "HEAD",
        "HEAD",
        "HEAD",
        "no-such-ref-9f3c1a",
        "--ledger",
        emptyLedger(),
      ]);
      expect(result.status).toBe(2);
      expect(result.stdout).not.toMatch(/HOLDS|VIOLATES/);
    },
  );

  it(
    "exits 2 on a ledger line that is not a JSON object, rather than reading it as naming no path",
    { timeout: SOUNDNESS_PROBE_TIMEOUT_MS },
    () => {
      const fixture = makeBareFixture("rebase-ledger-");
      fixture.write("ledger.jsonl", '{"round": 1}\nnot json\n');
      const result = runScript([
        "HEAD",
        "HEAD",
        "HEAD",
        "HEAD",
        "--ledger",
        join(fixture.dir, "ledger.jsonl"),
      ]);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/cannot read the claims in /);
      expect(result.stdout).not.toMatch(/HOLDS|VIOLATES/);
    },
  );

  it("reports HOLDS in the tree it was run from, naming that tree", () => {
    const fixture = rebaseFixture({
      "src/shared.ts": "export const a = 1;\n",
      "docs/notes.md": "# Notes\n",
    });
    fixture.write("src/branch.ts", "export const b = 1;\n");
    const oldHead = fixture.commit("Branch work");
    fixture.git(["switch", "-q", "staging"]);
    fixture.write("src/shared.ts", "export const a = 2;\n");
    const newBase = fixture.commit("Staging moves on");
    const newHead = rebaseOntoStaging(fixture);

    const result = runScript(
      [fixture.oldBase, oldHead, newBase, newHead, "--ledger", emptyLedger()],
      fixture.dir,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /soundness probes: (\d+)\/\1 passed on typescript /,
    );
    expect(result.stdout).toContain(
      fixture.git(["rev-parse", "--show-toplevel"]).trim(),
    );
    expect(result.stdout).toMatch(/rebase-invariance property: HOLDS/);
    expect(result.stdout).toContain("src/branch.ts");
  });

  it("reports VIOLATES naming the first path that moved, and exits 1", () => {
    const fixture = rebaseFixture({ "src/shared.ts": "export const a = 1;\n" });
    fixture.write(
      "src/shared.ts",
      "export const a = 1;\nexport const b = 2;\n",
    );
    const oldHead = fixture.commit("Branch work");
    fixture.git(["switch", "-q", "staging"]);
    fixture.write("src/shared.ts", "export const a = 3;\n");
    const newBase = fixture.commit("Staging moves on");
    const newHead = rebaseOntoStaging(fixture, () =>
      fixture.write(
        "src/shared.ts",
        "export const a = 3;\nexport const b = 2;\n",
      ),
    );

    const result = runScript(
      [fixture.oldBase, oldHead, newBase, newHead, "--ledger", emptyLedger()],
      fixture.dir,
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(
      /rebase-invariance property: VIOLATES -- src\/shared\.ts changed at the branch's own hunks/,
    );
  });

  it("exits 2 on a head the rebase path does not apply to", () => {
    const fixture = rebaseFixture({ "src/shared.ts": "export const a = 1;\n" });
    fixture.write("src/branch.ts", "export const b = 1;\n");
    const oldHead = fixture.commit("Branch work");
    fixture.git(["switch", "-q", "staging"]);
    fixture.write("docs/notes.md", "# Notes\n");
    const newBase = fixture.commit("Staging moves on");
    fixture.git(["switch", "-q", "branch"]);
    fixture.git(["merge", "-q", "--no-ff", "-m", "Merge staging", "staging"]);

    const result = runScript(
      [
        fixture.oldBase,
        oldHead,
        newBase,
        fixture.head(),
        "--ledger",
        emptyLedger(),
      ],
      fixture.dir,
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(
      /by a merge or by added work rather than by a rebase/,
    );
    expect(result.stdout).not.toMatch(/HOLDS|VIOLATES/);
  });
});
