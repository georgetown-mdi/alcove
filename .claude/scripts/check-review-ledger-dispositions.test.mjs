import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createGitFixtures } from "./lib/gitFixture.mjs";
import {
  LEGACY_CUTOFF_DATE,
  LIMIT_RULE_DATE,
  checkLedger,
  parseLedger,
  remapFixCommits,
} from "./check-review-ledger-dispositions.mjs";

// Containment is decided by real git over repositories built here, including
// real rebases onto a moved base: whether a rebased fix still counts as the
// same fix is what `git cherry` and the rebase decide, not a model of them.

const SCRIPT = fileURLToPath(
  new URL("./check-review-ledger-dispositions.mjs", import.meta.url),
);
const { makeFixture, makeTempDir, cleanup } = createGitFixtures();

afterEach(cleanup);

const DATE = LEGACY_CUTOFF_DATE;
const LIMIT_DATE = LIMIT_RULE_DATE;
const FILE = "a\n1\n2\n3\n4\n5\nb\nc\n";

/**
 * A repository whose `staging` holds one base commit and whose `branch`, cut
 * from it, holds a fix commit and a later unrelated commit.
 */
function branchWithFix() {
  const fixture = makeFixture("ledger-dispositions-");
  fixture.write("src/f.ts", FILE);
  fixture.write(
    "docs/spec/LIMITS.md",
    "# Limits\n\nThe exchange skips blank rows.\n",
  );
  const oldBase = fixture.commit("Base");
  fixture.git(["branch", "-m", "staging"]);
  fixture.git(["switch", "-q", "-c", "branch"]);
  fixture.write("src/f.ts", FILE.replace("b\n", "B\n"));
  const fix = fixture.commit("Fix the b line");
  fixture.write("src/g.ts", "export const g = 1;\n");
  const oldHead = fixture.commit("Other work");
  return { fixture, oldBase, fix, oldHead };
}

/** Move staging with `content` for src/f.ts, then rebase the branch onto it. */
function moveStagingAndRebase(fixture, content, resolveTo) {
  fixture.git(["switch", "-q", "staging"]);
  fixture.write("src/f.ts", content);
  const newBase = fixture.commit("Staging moves on");
  fixture.git(["switch", "-q", "branch"]);
  const attempt = fixture.run(["rebase", "staging"]);
  if (resolveTo === undefined) {
    expect(attempt.status).toBe(0);
  } else {
    expect(attempt.stdout + attempt.stderr).toMatch(/CONFLICT/);
    fixture.write("src/f.ts", resolveTo);
    fixture.git(["add", "-A"]);
    expect(fixture.run(["rebase", "--continue"]).status).toBe(0);
  }
  return { newBase, newHead: fixture.head() };
}

const row = (dispositions, extra = {}) =>
  JSON.stringify({
    round: 1,
    kind: "light",
    date: DATE,
    dispositions,
    ...extra,
  });

const check = (fixture, ledgerText, head) =>
  checkLedger({ rows: parseLedger(ledgerText).rows, head, git: fixture.git });

describe("fixed entries", () => {
  it("refuses a fix commit that never reached the head", () => {
    const { fixture, oldHead } = branchWithFix();
    fixture.git(["switch", "-q", "-c", "stray", "staging"]);
    fixture.write("src/f.ts", FILE.replace("c\n", "C\n"));
    const stray = fixture.commit("A fix left on another branch");

    const [result] = check(
      fixture,
      row([{ item: "c line", disposition: "fixed", commit: stray }]),
      oldHead,
    );
    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/no commit in .* has its patch/);
  });

  it("passes a fix that is an ancestor of the head", () => {
    const { fixture, fix, oldHead } = branchWithFix();
    const results = check(
      fixture,
      row([{ item: "b line", disposition: "fixed", commit: fix }]),
      oldHead,
    );
    expect(results.map((r) => r.status)).toEqual(["ok"]);
  });

  it("passes the same fix after a rebase onto a moved base, by patch identity", () => {
    const { fixture, fix, oldHead } = branchWithFix();
    const { newHead } = moveStagingAndRebase(
      fixture,
      FILE.replace("a\n", "A\n"),
    );
    expect(
      fixture.run(["merge-base", "--is-ancestor", fix, newHead]).status,
    ).toBe(1);
    expect(
      fixture.run(["merge-base", "--is-ancestor", oldHead, newHead]).status,
    ).toBe(1);

    const results = check(
      fixture,
      row([{ item: "b line", disposition: "fixed", commit: fix }]),
      newHead,
    );
    expect(results.map((r) => r.status)).toEqual(["ok"]);
  });

  it("refuses a fix whose hunk a conflict resolution edited, until --remap re-records it", () => {
    const { fixture, oldBase, fix, oldHead } = branchWithFix();
    const resolved = FILE.replace("b\n", "BB\n");
    const { newBase, newHead } = moveStagingAndRebase(
      fixture,
      FILE.replace("b\n", "bb\n"),
      resolved,
    );
    const ledger = `${row([{ item: "b line", disposition: "fixed", commit: fix }])}\n`;
    expect(check(fixture, ledger, newHead).map((r) => r.status)).toEqual([
      "refused",
    ]);

    const { text, remapped } = remapFixCommits({
      text: ledger,
      oldBase,
      oldHead,
      newBase,
      newHead,
      git: fixture.git,
    });
    const rebasedFix = fixture.git(["rev-parse", "HEAD~1"]).trim();
    expect(remapped).toEqual([{ item: "b line", from: fix, to: rebasedFix }]);
    expect(check(fixture, text, newHead).map((r) => r.status)).toEqual(["ok"]);
  });

  it("refuses a fixed entry naming no commit, or one that does not resolve", () => {
    const { fixture, oldHead } = branchWithFix();
    const results = check(
      fixture,
      row([
        { item: "one", disposition: "fixed", commit: "0".repeat(40) },
        { item: "two", disposition: "fixed" },
      ]),
      oldHead,
    );
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ["refused", expect.stringMatching(/does not resolve/)],
      ["refused", expect.stringMatching(/names no "commit"/)],
    ]);
  });
});

describe("deferred entries", () => {
  it("refuses a deferral naming nothing", () => {
    const { fixture, oldHead } = branchWithFix();
    const [result] = check(
      fixture,
      row([{ item: "later", disposition: "deferred" }]),
      oldHead,
    );
    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/neither a "board" item nor a "limitsLine"/);
  });

  it("passes a board item or a limits line the head holds, and refuses a malformed or absent one", () => {
    const { fixture, oldHead } = branchWithFix();
    const results = check(
      fixture,
      row([
        { item: "a", disposition: "deferred", board: "3/254" },
        {
          item: "b",
          disposition: "deferred",
          limitsLine: 'docs/spec/LIMITS.md#"skips blank rows"',
        },
        {
          item: "c",
          disposition: "deferred",
          limitsLine: "docs/spec/LIMITS.md#limits",
        },
        { item: "d", disposition: "deferred", board: "PR follow-on" },
        {
          item: "e",
          disposition: "deferred",
          limitsLine: 'docs/spec/LIMITS.md#"skips every row"',
        },
        {
          item: "f",
          disposition: "deferred",
          limitsLine: "docs/spec/GONE.md#limits",
        },
        {
          item: "g",
          disposition: "deferred",
          limitsLine: "docs/NOTES.md#limits",
        },
      ]),
      oldHead,
    );
    expect(results.map((r) => `${r.item}:${r.status}`)).toEqual([
      "a:ok",
      "b:ok",
      "c:ok",
      "d:refused",
      "e:refused",
      "f:refused",
      "g:refused",
    ]);
  });
});

describe("limit entries", () => {
  it("passes an internal limit and a reachable one whose limits line the head holds", () => {
    const { fixture, oldHead } = branchWithFix();
    const results = check(
      fixture,
      row(
        [
          {
            item: "helper name",
            disposition: "limit",
            note: "internal naming",
            surface: "internal",
          },
          {
            item: "blank rows",
            disposition: "limit",
            note: "partner sees fewer rows",
            surface: "reachable",
            limitsLine: 'docs/spec/LIMITS.md#"skips blank rows"',
          },
          {
            item: "unmarked but promoted",
            disposition: "limit",
            note: "partner sees fewer rows",
            limitsLine: "docs/spec/LIMITS.md#limits",
          },
        ],
        { date: LIMIT_DATE },
      ),
      oldHead,
    );
    expect(results.map((r) => `${r.item}:${r.status}`)).toEqual([
      "helper name:ok",
      "blank rows:ok",
      "unmarked but promoted:ok",
    ]);
  });

  it("refuses a reachable or unmarked limit with no limits line, a line the head lacks, or an unknown surface", () => {
    const { fixture, oldHead } = branchWithFix();
    const results = check(
      fixture,
      row(
        [
          {
            item: "reachable",
            disposition: "limit",
            note: "n",
            surface: "reachable",
          },
          { item: "unmarked", disposition: "limit", note: "n" },
          {
            item: "absent phrase",
            disposition: "limit",
            note: "n",
            limitsLine: 'docs/spec/LIMITS.md#"skips every row"',
          },
          {
            item: "unknown surface",
            disposition: "limit",
            note: "n",
            surface: "partner",
          },
        ],
        { date: LIMIT_DATE },
      ),
      oldHead,
    );
    expect(results.map((r) => [r.item, r.status, r.reason])).toEqual([
      ["reachable", "refused", expect.stringMatching(/names no "limitsLine"/)],
      ["unmarked", "refused", expect.stringMatching(/names no "limitsLine"/)],
      [
        "absent phrase",
        "refused",
        expect.stringMatching(/quotes a phrase .* does not hold/),
      ],
      [
        "unknown surface",
        "refused",
        expect.stringMatching(/not "reachable" or "internal"/),
      ],
    ]);
  });

  it("exempts a limit dated before the limit rule and holds one dated on it", () => {
    const { fixture, oldHead } = branchWithFix();
    const limit = [{ item: "rows", disposition: "limit", note: "n" }];
    const day = (date) =>
      new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10);
    expect(
      check(fixture, row(limit, { date: day(LIMIT_DATE) }), oldHead).map(
        (r) => r.status,
      ),
    ).toEqual(["pre-rule"]);
    expect(
      check(fixture, row(limit, { date: LIMIT_DATE }), oldHead).map(
        (r) => r.status,
      ),
    ).toEqual(["refused"]);
  });
});

describe("legacy rows", () => {
  const legacyRow = (date) =>
    row(
      [
        { item: "old fix", disposition: "fixed" },
        { item: "old deferral", disposition: "deferred" },
        { item: "old limit", disposition: "limit", note: "lived with" },
      ],
      { date },
    );

  it("skips a row predating the fields, and holds a later row to them", () => {
    const { fixture, fix, oldHead } = branchWithFix();
    const ledger = [
      legacyRow("2026-09-01"),
      row([{ item: "new fix", disposition: "fixed", commit: fix }], {
        round: 2,
        date: "2026-09-02",
      }),
      legacyRow("2026-09-03"),
    ].join("\n");
    expect(
      check(fixture, ledger, oldHead).map((r) => `${r.item}:${r.status}`),
    ).toEqual([
      "old fix:skipped",
      "old deferral:skipped",
      "old limit:skipped",
      "new fix:ok",
      "old fix:refused",
      "old deferral:refused",
      "old limit:pre-rule",
    ]);
  });

  it("counts a limit's surface as a field a later row is held to", () => {
    const { fixture, oldHead } = branchWithFix();
    const ledger = [
      row(
        [
          {
            item: "new limit",
            disposition: "limit",
            note: "test-only",
            surface: "internal",
          },
        ],
        { date: "2026-09-02" },
      ),
      legacyRow("2026-09-03"),
    ].join("\n");
    expect(
      check(fixture, ledger, oldHead).map((r) => `${r.item}:${r.status}`),
    ).toEqual([
      "new limit:pre-rule",
      "old fix:refused",
      "old deferral:refused",
      "old limit:pre-rule",
    ]);
  });

  it("skips the limit check for a limit between the cutoff and the limit rule, yet holds the row", () => {
    const { fixture, oldHead } = branchWithFix();
    const ledger = row(
      [
        { item: "fix", disposition: "fixed" },
        { item: "lim", disposition: "limit", note: "n" },
      ],
      { date: LEGACY_CUTOFF_DATE },
    );
    expect(
      check(fixture, ledger, oldHead).map((r) => `${r.item}:${r.status}`),
    ).toEqual(["fix:refused", "lim:pre-rule"]);
  });

  it("holds a row dated on or after the cutoff even when no row uses the fields", () => {
    const { fixture, oldHead } = branchWithFix();
    expect(
      check(fixture, legacyRow(LEGACY_CUTOFF_DATE), oldHead).map(
        (r) => r.status,
      ),
    ).toEqual(["refused", "refused", "pre-rule"]);
  });
});

describe("the command line", () => {
  const runScript = (cwd, args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });

  it("exits 1 on a refusal, 0 on a pass, 2 on an unreadable line", () => {
    const { fixture, fix, oldHead } = branchWithFix();
    const dir = makeTempDir("ledger-file-");
    const ledgerPath = join(dir, "branch.jsonl");

    writeFileSync(
      ledgerPath,
      `${row([{ item: "later", disposition: "deferred" }])}\n`,
    );
    const refused = runScript(fixture.dir, [ledgerPath, oldHead]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/dispositions: REFUSED/);

    writeFileSync(
      ledgerPath,
      `${row([{ item: "b line", disposition: "fixed", commit: fix }])}\n`,
    );
    expect(runScript(fixture.dir, [ledgerPath, oldHead]).status).toBe(0);

    writeFileSync(ledgerPath, "{not json\n");
    expect(runScript(fixture.dir, [ledgerPath, oldHead]).status).toBe(2);
  });

  it("exits 1 on a reachable limit with no limits line, 0 once it is internal", () => {
    const { fixture, oldHead } = branchWithFix();
    const dir = makeTempDir("ledger-file-");
    const ledgerPath = join(dir, "branch.jsonl");
    const limit = { item: "rows", disposition: "limit", note: "lived with" };
    const dated = (entries) => row(entries, { date: LIMIT_DATE });

    writeFileSync(ledgerPath, `${dated([limit])}\n`);
    const refused = runScript(fixture.dir, [ledgerPath, oldHead]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/round 1 limit: rows/);

    writeFileSync(
      ledgerPath,
      `${dated([{ ...limit, surface: "internal" }])}\n`,
    );
    const passed = runScript(fixture.dir, [ledgerPath, oldHead]);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toMatch(/dispositions: PASS -- 1 checked/);
  });

  it("counts legacy rows and limits before the limit rule separately", () => {
    const { fixture, oldHead } = branchWithFix();
    const dir = makeTempDir("ledger-file-");
    const ledgerPath = join(dir, "branch.jsonl");
    const limit = { item: "rows", disposition: "limit", note: "n" };
    writeFileSync(
      ledgerPath,
      [
        row([{ item: "old", disposition: "deferred" }], { date: "2026-09-01" }),
        row([limit], { round: 2, date: LEGACY_CUTOFF_DATE }),
      ].join("\n") + "\n",
    );
    const passed = runScript(fixture.dir, [ledgerPath, oldHead]);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toMatch(
      /dispositions: PASS -- 0 checked, 1 skipped as legacy, 1 limits before the limit rule\n/,
    );
  });

  it("--remap rewrites only the line holding a remapped entry", () => {
    const { fixture, oldBase, fix, oldHead } = branchWithFix();
    const { newBase, newHead } = moveStagingAndRebase(
      fixture,
      FILE.replace("a\n", "A\n"),
    );
    const dir = makeTempDir("ledger-file-");
    const ledgerPath = join(dir, "branch.jsonl");
    const untouched =
      '{"round": 1, "kind": "light", "date": "2026-09-01", "dispositions": []}';
    writeFileSync(
      ledgerPath,
      `${untouched}\n${row([{ item: "b line", disposition: "fixed", commit: fix }], { round: 2 })}\n`,
    );

    const result = runScript(fixture.dir, [
      "--remap",
      ledgerPath,
      oldBase,
      oldHead,
      newBase,
      newHead,
    ]);
    expect(result.status).toBe(0);
    const lines = readFileSync(ledgerPath, "utf8").split("\n");
    expect(lines[0]).toBe(untouched);
    expect(JSON.parse(lines[1]).dispositions[0].commit).toBe(
      fixture.git(["rev-parse", "HEAD~1"]).trim(),
    );
    expect(lines[2]).toBe("");
  });
});
