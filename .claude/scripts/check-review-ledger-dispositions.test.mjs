import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createGitFixtures } from "./lib/gitFixture.mjs";
import { parseLedger } from "./lib/reviewLedger.mjs";
import {
  FIX_REVIEW_RULE_DATE,
  LEGACY_CUTOFF_DATE,
  LIMIT_RULE_DATE,
  REATTESTATION_ROUTES,
  capRaiseCheck,
  checkLedger,
  fixReviewCheck,
  isProductPath,
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

/** A PR body whose Checklist's Security review line attests `sha`. */
const prBody = (sha, resolution = "lens round") =>
  [
    "## Summary",
    "",
    "A change.",
    "",
    "## Checklist",
    "",
    "- [x] Docs: updated -- n/a: no behavior change",
    `- [x] Security review of ${sha} -- ${resolution}`,
    "",
  ].join("\n");

const writeBody = (text) => {
  const path = join(makeTempDir("pr-body-"), "body.md");
  writeFileSync(path, text);
  return path;
};

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
    expect(result.reason).toMatch(
      /names no "board" item, "followUp", or "limitsLine"/,
    );
  });

  it("passes a deferral to a held follow-up that is also internal or has a limits line the head holds", () => {
    const { fixture, oldHead } = branchWithFix();
    const results = check(
      fixture,
      row([
        {
          item: "a",
          disposition: "deferred",
          followUp: "quote-cron-percent",
          surface: "internal",
        },
        {
          item: "b",
          disposition: "deferred",
          followUp: "tz2",
          limitsLine: 'docs/spec/LIMITS.md#"skips blank rows"',
        },
      ]),
      oldHead,
    );
    expect(results.map((r) => `${r.item}:${r.status}`)).toEqual([
      "a:ok",
      "b:ok",
    ]);
  });

  it("refuses a held follow-up that is not internal and has no limits line the head holds", () => {
    const { fixture, oldHead } = branchWithFix();
    const results = check(
      fixture,
      row([
        { item: "a", disposition: "deferred", followUp: "quote-cron-percent" },
        {
          item: "b",
          disposition: "deferred",
          followUp: "tz2",
          limitsLine: 'docs/spec/LIMITS.md#"skips every row"',
        },
      ]),
      oldHead,
    );
    expect(results.map((r) => `${r.item}:${r.status}`)).toEqual([
      "a:refused",
      "b:refused",
    ]);
    expect(results[0].reason).toBe(
      'held follow-up "quote-cron-percent" also needs what a limit does, in case the follow-ups pass declines it: a limit on a reachable surface names no "limitsLine"; write the spec line, or mark the entry "surface": "internal"',
    );
    expect(results[1].reason).toMatch(
      /^held follow-up "tz2" .*quotes a phrase docs\/spec\/LIMITS\.md does not hold/,
    );
  });

  it("passes an entry naming both a board item and a follow-up, and a limit still carrying its follow-up", () => {
    const { fixture, oldHead } = branchWithFix();
    const results = check(
      fixture,
      row(
        [
          {
            item: "a",
            disposition: "deferred",
            board: "3/254",
            followUp: "quote-cron-percent",
          },
          {
            item: "b",
            disposition: "limit",
            surface: "internal",
            followUp: "tz2",
            note: "declined",
          },
        ],
        { date: LIMIT_DATE },
      ),
      oldHead,
    );
    expect(results.map((r) => `${r.item}:${r.status}`)).toEqual([
      "a:ok",
      "b:ok",
    ]);
  });

  it("refuses a malformed held follow-up, naming the slug shape", () => {
    const { fixture, oldHead } = branchWithFix();
    const results = check(
      fixture,
      row(
        [
          "Quote cron percent",
          "quote_cron",
          "quote--cron",
          "-quote",
          "quote-",
          "continuation-2026-10-29.md#3",
          "",
          7,
          null,
        ].map((followUp, i) => ({
          item: `f${i}`,
          disposition: "deferred",
          followUp,
        })),
      ),
      oldHead,
    );
    expect(results).toHaveLength(9);
    for (const result of results) {
      expect(result.status).toBe("refused");
      expect(result.reason).toMatch(/^"followUp" is .*, not a "<slug>"/);
    }
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

  it("counts a deferral's follow-up as a field a later row is held to", () => {
    const { fixture, oldHead } = branchWithFix();
    const ledger = [
      row(
        [
          {
            item: "held",
            disposition: "deferred",
            followUp: "held-one",
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
      "held:ok",
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

describe("cap raises", () => {
  const TRIGGERS = { 1: false, 2: false, 3: false, 4: false, 5: false };
  const raise = (from, extra = {}) => ({
    from,
    to: from + 1,
    date: DATE,
    triggers: TRIGGERS,
    ...extra,
  });
  const STEP_BACK = {
    sharedCause: "no: the two findings sit in unrelated copy",
    pivot: "owner",
  };
  const caps = (...rows) =>
    capRaiseCheck(parseLedger(rows.join("\n") + "\n").rows);

  it("passes a ledger with no raise recorded, or with one", () => {
    expect(caps(row([]))).toEqual({ count: 0, reason: null });
    expect(caps(row([], { capRaises: [raise(3)] }))).toEqual({
      count: 1,
      reason: null,
    });
  });

  it("passes two raises whose second records the step-back", () => {
    expect(
      caps(
        row([], {
          capRaises: [raise(3), raise(4, { stepBack: STEP_BACK })],
        }),
      ),
    ).toEqual({ count: 2, reason: null });
  });

  it("refuses two raises with no step-back on the second, counting raises across rows", () => {
    expect(caps(row([], { capRaises: [raise(3), raise(4)] }))).toEqual({
      count: 2,
      reason: 'the second cap raise records no "stepBack"',
    });
    expect(
      caps(
        row([], { capRaises: [raise(3, { stepBack: STEP_BACK })] }),
        row([], { round: 2, capRaises: [raise(4)] }),
      ).reason,
    ).toBe('the second cap raise records no "stepBack"');
  });

  it("refuses a step-back with no shared-cause answer or an unknown pivot, and a capRaises that is not a list", () => {
    const second = (stepBack) =>
      caps(row([], { capRaises: [raise(3), raise(4, { stepBack })] })).reason;
    expect(second({ sharedCause: " ", pivot: "panel" })).toMatch(
      /states no "sharedCause"/,
    );
    expect(second({ sharedCause: "yes", pivot: "another round" })).toMatch(
      /pivot is "another round", not one of "re-scope", "panel", "owner"/,
    );
    expect(caps(row([], { capRaises: { from: 3 } })).reason).toBe(
      `round 1's "capRaises" is not a list`,
    );
  });

  it("does not count a raise recorded only in capNote prose", () => {
    expect(
      caps(row([], { cap: 7, capNote: "raised from 3 to 4 | raised 4 to 5" })),
    ).toEqual({ count: 0, reason: null });
  });
});

/**
 * A repository whose `branch` holds one product commit, `reviewed`, the head
 * the ledger's round read.
 */
function reviewedBranch() {
  const fixture = makeFixture("post-review-fix-");
  fixture.write("packages/core/src/a.ts", "export const a = 1;\n");
  fixture.commit("Base");
  fixture.git(["branch", "-m", "staging"]);
  fixture.git(["switch", "-q", "-c", "branch"]);
  fixture.write("packages/core/src/a.ts", "export const a = 2;\n");
  const reviewed = fixture.commit("Change a");
  return { fixture, reviewed };
}

/** Commit a product fix on top of the fixture's branch. */
function productFix(fixture, value = 3) {
  fixture.write("packages/core/src/a.ts", `export const a = ${value};\n`);
  return fixture.commit(`Fix a to ${value}`);
}

const roundRow = (head, extra = {}) =>
  JSON.stringify({
    round: 1,
    kind: "light",
    date: FIX_REVIEW_RULE_DATE,
    ref: "branch",
    head,
    dispositions: [],
    ...extra,
  });
const fixReviewRow = (from, head) =>
  JSON.stringify({
    kind: "fix-review",
    date: FIX_REVIEW_RULE_DATE,
    ref: "branch",
    from,
    head,
    dispositions: [],
  });
const fixCheck = (fixture, lines, head, body = prBody(head)) =>
  fixReviewCheck({
    rows: parseLedger(lines.join("\n")).rows,
    head,
    body,
    git: fixture.git,
  });

describe("post-review fixes", () => {
  it("treats apps/ and packages/ as product code, their test/ trees excepted", () => {
    for (const path of [
      "packages/core/src/a.ts",
      "apps/web/src/App.tsx",
      "apps/cli/package.json",
    ])
      expect(isProductPath(path), path).toBe(true);
    for (const path of [
      "packages/core/test/a.test.ts",
      "apps/web/test/e2e/flow.ts",
      "docs/notes/a.md",
      "docs/spec/PROTOCOL.md",
      "scripts/check.mjs",
      ".claude/scripts/check.mjs",
    ])
      expect(isProductPath(path), path).toBe(false);
  });

  it("passes a product fix a fix review read", () => {
    const { fixture, reviewed } = reviewedBranch();
    const fix = productFix(fixture);
    const result = fixCheck(
      fixture,
      [roundRow(reviewed), fixReviewRow(reviewed, fix)],
      fix,
    );
    expect(result.status).toBe("ok");
    expect(result.reason).toMatch(/no product commit after/);
  });

  it('passes a product fix the Security review line declares "not re-reviewed"', () => {
    const { fixture, reviewed } = reviewedBranch();
    const fix = productFix(fixture);
    const result = fixCheck(
      fixture,
      [roundRow(reviewed)],
      fix,
      prBody(fix, "lens round; the exact-edit fix after it not re-reviewed"),
    );
    expect(result.status).toBe("ok");
    expect(result.commits.map((c) => c.sha)).toEqual([fix]);
  });

  it("refuses a product fix with neither a fix review nor the declaration", () => {
    const { fixture, reviewed } = reviewedBranch();
    const fix = productFix(fixture);
    const result = fixCheck(fixture, [roundRow(reviewed)], fix);
    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(
      new RegExp(
        `1 product commit\\(s\\) after the last reviewed head ${reviewed} have no fix review`,
      ),
    );
    expect(result.commits).toEqual([
      { sha: fix, subject: "Fix a to 3", paths: ["packages/core/src/a.ts"] },
    ]);
  });

  it("passes when no product commit follows the last review", () => {
    const { fixture, reviewed } = reviewedBranch();
    fixture.write("packages/core/test/a.test.ts", "it('a', () => {});\n");
    fixture.write("docs/notes/a.md", "# A\n");
    fixture.write(".claude/scripts/a.mjs", "export {};\n");
    const head = fixture.commit("Test, docs and tooling");
    expect(fixCheck(fixture, [roundRow(reviewed)], reviewed).status).toBe("ok");
    const result = fixCheck(fixture, [roundRow(reviewed)], head);
    expect(result.status).toBe("ok");
    expect(result.commits).toEqual([]);
  });

  it("refuses a fix review that starts after the reviewed head", () => {
    const { fixture, reviewed } = reviewedBranch();
    const first = productFix(fixture, 3);
    const second = productFix(fixture, 4);
    const result = fixCheck(
      fixture,
      [roundRow(reviewed), fixReviewRow(first, second)],
      second,
    );
    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/2 product commit\(s\)/);
    expect(result.reason).toMatch(/leaves the commits between unreviewed/);
  });

  it("follows a rebase-invariance re-attestation from the reviewed head only", () => {
    const { fixture, reviewed } = reviewedBranch();
    const moved = productFix(fixture);
    const reattested = (from) => ({
      reattested: [{ route: "rebase-invariance", from, to: moved, date: DATE }],
    });
    expect(
      fixCheck(fixture, [roundRow(reviewed, reattested(reviewed))], moved)
        .status,
    ).toBe("ok");
    const base = fixture.git(["rev-parse", "staging"]).trim();
    expect(
      fixCheck(fixture, [roundRow(reviewed, reattested(base))], moved).status,
    ).toBe("refused");
  });

  it("follows each verifier route's re-attestation with no declaration, and no other route", () => {
    const { fixture, reviewed } = reviewedBranch();
    fixture.write(
      "packages/core/src/a.ts",
      "// The value a reads.\nexport const a = 2;\n",
    );
    const commented = fixture.commit("Comment a");
    const rows = (route) => [
      roundRow(reviewed, {
        reattested: [{ route, from: reviewed, to: commented, date: DATE }],
      }),
    ];
    for (const route of REATTESTATION_ROUTES) {
      const result = fixCheck(fixture, rows(route), commented);
      expect(result.status, route).toBe("ok");
      expect(result.commits, route).toEqual([]);
    }
    const unverified = fixCheck(fixture, rows("narrowing"), commented);
    expect(unverified.status).toBe("refused");
    expect(unverified.commits.map((c) => c.sha)).toEqual([commented]);
  });

  it("refuses a row on or after the rule date that records no head, and reports a ledger with none recorded not checked", () => {
    const { fixture } = reviewedBranch();
    const fix = productFix(fixture);
    const headless = (date) =>
      JSON.stringify({ round: 1, kind: "light", date, dispositions: [] });
    const refused = fixCheck(fixture, [headless(FIX_REVIEW_RULE_DATE)], fix);
    expect(refused.status).toBe("refused");
    expect(refused.reason).toMatch(/round 1 records no "head"/);
    expect(fixCheck(fixture, [headless(DATE)], fix).status).toBe("not-checked");
  });

  it("refuses a body whose Security review line is missing or attests another sha", () => {
    const { fixture, reviewed } = reviewedBranch();
    const fix = productFix(fixture);
    const rows = [roundRow(reviewed)];
    expect(fixCheck(fixture, rows, fix, prBody(reviewed)).reason).toMatch(
      /attests [0-9a-f]+, not the head/,
    );
    expect(fixCheck(fixture, rows, fix, "## Checklist\n").reason).toMatch(
      /no single Security review line/,
    );
  });

  it("refuses a reviewed head the PR head does not descend from", () => {
    const { fixture, reviewed } = reviewedBranch();
    fixture.git(["switch", "-q", "-c", "other", "staging"]);
    const head = productFix(fixture);
    const result = fixCheck(fixture, [roundRow(reviewed)], head);
    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/is not an ancestor of/);
  });
});

// Each case builds a fixture repository and spawns the script up to three
// times, each a cold Node start, which runs slowly under load and can pass
// vitest's 5 s default. Sized well past that, the bound catches a hung spawn
// rather than timing a slow one.
describe("the command line", { timeout: 60_000 }, () => {
  // The first form also takes the PR body; unless a case names one, it is a
  // body whose Security review line attests the head the case passes.
  const runScript = (cwd, args, body) =>
    spawnSync(
      process.execPath,
      [
        SCRIPT,
        ...args,
        ...(args[0] === "--remap"
          ? []
          : ["--body", writeBody(body ?? prBody(args[1]))]),
      ],
      { cwd, encoding: "utf8" },
    );

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

  it("exits 1 on a second cap raise with no step-back, naming it", () => {
    const { fixture, oldHead } = branchWithFix();
    const dir = makeTempDir("ledger-file-");
    const ledgerPath = join(dir, "branch.jsonl");
    const raise = (from) => ({ from, to: from + 1, date: DATE, triggers: {} });
    writeFileSync(
      ledgerPath,
      `${row([], { capRaises: [raise(3), raise(4)] })}\n`,
    );
    const refused = runScript(fixture.dir, [ledgerPath, oldHead]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(
      /^cap raises: REFUSED -- the second cap raise records no "stepBack";/m,
    );
    expect(refused.stdout).toMatch(/^dispositions: PASS -- 0 checked/m);
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

  it("exits 1 on an unreviewed product fix, 0 once the line declares it, 2 with no body", () => {
    const { fixture, reviewed } = reviewedBranch();
    const fix = productFix(fixture);
    const dir = makeTempDir("ledger-file-");
    const ledgerPath = join(dir, "branch.jsonl");
    writeFileSync(ledgerPath, `${roundRow(reviewed)}\n`);

    const refused = runScript(fixture.dir, [ledgerPath, fix]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain(`  ${fix}  Fix a to 3\n`);
    expect(refused.stdout).toMatch(/^post-review fixes: REFUSED -- /m);
    expect(refused.stdout).toMatch(/^dispositions: PASS/m);

    const declared = runScript(
      fixture.dir,
      [ledgerPath, fix],
      prBody(fix, "lens round; fix not re-reviewed"),
    );
    expect(declared.status).toBe(0);
    expect(declared.stdout).toMatch(/^post-review fixes: PASS -- /m);

    const bare = spawnSync(process.execPath, [SCRIPT, ledgerPath, fix], {
      cwd: fixture.dir,
      encoding: "utf8",
    });
    expect(bare.status).toBe(2);
  });

  it("--print-base prints the head a rebase re-attested, and a fix review based on it passes", () => {
    const { fixture, reviewed } = reviewedBranch();
    fixture.git(["switch", "-q", "staging"]);
    fixture.write("docs/notes/b.md", "# B\n");
    fixture.commit("Staging moves on");
    fixture.git(["switch", "-q", "branch"]);
    expect(fixture.run(["rebase", "staging"]).status).toBe(0);
    const rebased = fixture.head();
    const fix = productFix(fixture);
    const dir = makeTempDir("ledger-file-");
    const ledgerPath = join(dir, "branch.jsonl");
    const reattestedRound = roundRow(reviewed, {
      reattested: [
        { route: "rebase-invariance", from: reviewed, to: rebased, date: DATE },
      ],
    });
    const printBase = () =>
      spawnSync(process.execPath, [SCRIPT, "--print-base", ledgerPath], {
        cwd: fixture.dir,
        encoding: "utf8",
      });

    writeFileSync(
      ledgerPath,
      `${JSON.stringify({ round: 1, kind: "light", date: DATE, dispositions: [] })}\n`,
    );
    const none = printBase();
    expect(none.status).toBe(1);
    expect(none.stdout).toBe("");

    writeFileSync(ledgerPath, `${reattestedRound}\n`);
    const printed = printBase();
    expect(printed.status).toBe(0);
    expect(printed.stdout).toBe(`${rebased}\n`);

    writeFileSync(
      ledgerPath,
      `${reattestedRound}\n${fixReviewRow(printed.stdout.trim(), fix)}\n`,
    );
    const based = runScript(fixture.dir, [ledgerPath, fix]);
    expect(based.status).toBe(0);
    expect(based.stdout).toMatch(/^post-review fixes: PASS -- /m);

    writeFileSync(
      ledgerPath,
      `${reattestedRound}\n${fixReviewRow(reviewed, fix)}\n`,
    );
    const spanning = runScript(fixture.dir, [ledgerPath, fix]);
    expect(spanning.status).toBe(1);
    expect(spanning.stdout).toMatch(/leaves the commits between unreviewed/);
  });
});
