import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

import { createGitFixtures } from "../lib/gitFixture.mjs";
import {
  followLinks,
  followups,
  isManifestOrPin,
  isPlanned,
  parseArgs,
  parseDeletedLines,
} from "./followups.mjs";

const DAY = 86400;
const F_CT = 100 * DAY;

describe("parseDeletedLines", () => {
  it("reads a deleted line beginning `-- ` as content, not as a file header", () => {
    const diff = [
      "diff --git a/q.sql b/q.sql",
      "index 1111111..2222222 100644",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -3,2 +2,0 @@ select",
      "--- the old join",
      "-select 1;",
      "@@ -9 +7 @@",
      "-a",
      "++++ kept",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+x",
      "",
    ].join("\n");
    expect(parseDeletedLines(diff)).toEqual([
      {
        file: "q.sql",
        lines: [
          { n: 3, text: "-- the old join" },
          { n: 4, text: "select 1;" },
          { n: 9, text: "a" },
        ],
      },
    ]);
  });
});

describe("followLinks", () => {
  const S = "a".repeat(40);
  const OTHER = "b".repeat(40);
  const commits = (extra = {}) =>
    new Map([
      [
        S,
        {
          ct: F_CT - 2 * DAY,
          pr: 10,
          title: "Add the parser (#10)",
          boundary: false,
          ...extra,
        },
      ],
      [
        OTHER,
        {
          ct: F_CT - 3 * DAY,
          pr: 9,
          title: "Other work (#9)",
          boundary: false,
        },
      ],
    ]);
  const lines = (toS, toOther, manifest = false) => [
    ...Array.from({ length: toS }, () => ({ sha: S, manifest })),
    ...Array.from({ length: toOther }, () => ({ sha: OTHER, manifest: false })),
  ];

  it("links at exactly 5 lines and 50% of the deleted lines", () => {
    expect(
      followLinks({ ct: F_CT, lines: lines(5, 5), commits: commits() }),
    ).toEqual([
      { sha: S, pr: 10, lines: 5 },
      { sha: OTHER, pr: 9, lines: 5 },
    ]);
  });

  it("does not link under 5 lines or under 50%", () => {
    expect(
      followLinks({ ct: F_CT, lines: lines(4, 0), commits: commits() }),
    ).toEqual([]);
    expect(
      followLinks({ ct: F_CT, lines: lines(5, 6), commits: commits() }),
    ).toEqual([{ sha: OTHER, pr: 9, lines: 6 }]);
  });

  it("does not link a source 7 days old or a boundary commit", () => {
    expect(
      followLinks({
        ct: F_CT,
        lines: lines(6, 0),
        commits: commits({ ct: F_CT - 7 * DAY }),
      }),
    ).toEqual([]);
    expect(
      followLinks({
        ct: F_CT,
        lines: lines(6, 0),
        commits: commits({ boundary: true }),
      }),
    ).toEqual([]);
  });

  it("leaves out a Bump source and a link made only through manifests or image pins", () => {
    expect(
      followLinks({
        ct: F_CT,
        lines: lines(6, 0),
        commits: commits({ title: "Bump vite from 7 to 8 (#10)" }),
      }),
    ).toEqual([]);
    expect(
      followLinks({ ct: F_CT, lines: lines(6, 0, true), commits: commits() }),
    ).toEqual([]);
    const mixed = [...lines(5, 0, true), { sha: S, manifest: false }];
    expect(followLinks({ ct: F_CT, lines: mixed, commits: commits() })).toEqual(
      [{ sha: S, pr: 10, lines: 6 }],
    );
  });

  it("treats package.json lines and image pins as manifest lines", () => {
    expect(isManifestOrPin("apps/web/package.json", '"vite": "^8.0.0",')).toBe(
      true,
    );
    expect(isManifestOrPin("Dockerfile", "FROM node:24-alpine")).toBe(true);
    expect(isManifestOrPin("compose.yml", "    image: nginx:1.29")).toBe(true);
    expect(
      isManifestOrPin("ci.yml", `uses: x/y@sha256:${"0".repeat(64)}`),
    ).toBe(true);
    expect(isManifestOrPin("src/main.ts", "const from = 1;")).toBe(false);
  });
});

describe("isPlanned", () => {
  const item = (verb, id) =>
    `${verb} [${id}](https://github.com/orgs/x/projects/9/views/1?pane=issue&itemId=${id}).`;

  it("plans a link F's Follows, Part of or Follow-on line names", () => {
    expect(
      isPlanned("Follows [#10](https://github.com/x/y/pull/10).", "", 10),
    ).toBe(true);
    expect(isPlanned("Follow-on: #10", "", 10)).toBe(true);
    expect(isPlanned(item("Part of", 555), item("Implements", 555), 10)).toBe(
      true,
    );
  });

  it("plans a link S's body names F's item", () => {
    expect(
      isPlanned(
        item("Implements", 777),
        "The rest is board item itemId=777.",
        10,
      ),
    ).toBe(true);
  });

  it("leaves a link unplanned when neither body names the other", () => {
    expect(
      isPlanned("Fixes the parser after #100.", item("Implements", 555), 10),
    ).toBe(false);
    expect(
      isPlanned(item("Implements", 777), item("Implements", 555), 10),
    ).toBe(false);
    expect(isPlanned("Follows #10", "", null)).toBe(false);
  });
});

describe("the series over real git", () => {
  const { makeFixture, cleanup } = createGitFixtures();
  afterAll(cleanup);

  it("links a follow-up to its source, and leaves out an old source and a Bump PR", async () => {
    const repo = makeFixture("retro-followups-");
    // git reads a small @-timestamp in --until as something other than epoch
    // seconds, so the fixture's dates are recent ones.
    const commitAt = (days, message) => {
      const date = `@${1_700_000_000 + days * DAY} +0000`;
      execFileSync("git", ["add", "-A"], { cwd: repo.dir });
      execFileSync("git", ["commit", "-q", "-m", message], {
        cwd: repo.dir,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      });
    };
    const base = Array.from({ length: 20 }, (_, i) => `base line ${i}`);
    const added = [
      "-- join the tables",
      "select a,",
      "-- then filter",
      "from t",
      "where x",
      "and y",
      "order by a",
      "limit 1",
      "offset 2",
      ";",
    ];
    const write = (lines) => repo.write("q.sql", lines.join("\n") + "\n");
    write(base);
    commitAt(1, "Start the queries (#9)");
    write([...base, ...added]);
    repo.write("CHANGELOG.md", "one\ntwo\nthree\nfour\nfive\nsix\n");
    commitAt(10, "Add the query block (#10)");
    write([...base, ...added.slice(6)]);
    repo.write("CHANGELOG.md", "");
    commitAt(12, "Fix the query block (#11)");
    write([...base.slice(5), ...added.slice(6)]);
    commitAt(12.5, "Rework the old lines (#12)");
    write(base.slice(5));
    commitAt(13, "Bump the query from 1 to 2 (#13)");

    const out = await followups({
      repo: repo.dir,
      ref: "HEAD",
      prRange: { lo: 10, hi: 13 },
      jobs: 2,
      bodies: new Map([
        [10, "Implements the query block."],
        [11, "Follows [#10](https://github.com/x/y/pull/10)."],
        [12, ""],
      ]),
    });
    const summary = out.prs.map((p) => [
      p.pr,
      p.bump,
      p.deleted,
      p.follows.map((l) => ({ pr: l.pr, lines: l.lines, planned: l.planned })),
    ]);
    expect(summary).toEqual([
      [10, false, 0, []],
      [11, false, 6, [{ pr: 10, lines: 6, planned: true }]],
      [12, false, 5, []],
      [13, true, 0, []],
    ]);
    expect(out.missingBodies).toEqual([13]);
  });
});

describe("parseArgs", () => {
  it("requires the repo, ref, range, PR bodies and directory", () => {
    expect(parseArgs(["--repo", "r"])).toEqual({
      ok: false,
      message: "--ref is required",
    });
    const ok = parseArgs([
      "--repo",
      "r",
      "--ref",
      "staging",
      "--pr-range",
      "1-9",
      "--prs",
      "p.json",
      "--dir",
      "d",
    ]);
    expect(ok).toEqual({
      ok: true,
      options: {
        repo: "r",
        ref: "staging",
        prRange: { lo: 1, hi: 9 },
        prs: "p.json",
        dir: "d",
        jobs: 8,
      },
    });
  });
});
