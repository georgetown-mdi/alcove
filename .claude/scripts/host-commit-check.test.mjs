import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createGitFixtures } from "./lib/gitFixture.mjs";

// host-commit-check.sh runs on the host, reading GitHub. Here every repository
// is real git under the system temp directory: a bare repository stands in for
// origin, and a checkout stands in for the one the dev container mounts, which
// made the briefed commit and holds a copy of the script, since the script
// reads the briefed commit from the checkout it sits in.

const SCRIPT = fileURLToPath(
  new URL("./host-commit-check.sh", import.meta.url),
);

const fixtures = createGitFixtures();
afterEach(() => fixtures.cleanup());

const lines = (count, word) =>
  Array.from({ length: count }, (_, n) => `${word} ${n + 1}`).join("\n") + "\n";

// A checkout with main and staging at one base commit, a branch `feature`
// holding the briefed commit (or commits) cut from staging, and all three
// pushed to origin.
function world({ featureCommits = 1 } = {}) {
  const origin = fixtures.makeTempDir("host-commit-origin-");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  const checkout = fixtures.makeFixture("host-commit-checkout-");
  checkout.write(".git/info/exclude", ".claude/\n");
  checkout.write("shared.txt", lines(40, "shared"));
  checkout.write("feature.txt", lines(40, "feature"));
  checkout.commit("base");
  checkout.git(["branch", "staging"]);
  checkout.git(["remote", "add", "origin", origin]);
  checkout.git(["switch", "-q", "-c", "feature", "staging"]);
  let featureText = lines(40, "feature");
  for (let n = 1; n <= featureCommits; n++) {
    featureText = featureText.replace(
      `feature ${n * 10}\n`,
      `feature ${n * 10} changed\n`,
    );
    checkout.write("feature.txt", featureText);
    checkout.commit(`feature ${n}`);
  }
  const briefed = checkout.head();
  checkout.git(["push", "-q", "origin", "main", "staging", "feature"]);

  const scriptCopy = join(
    checkout.dir,
    ".claude",
    "scripts",
    "host-commit-check.sh",
  );
  mkdirSync(join(checkout.dir, ".claude", "scripts"), { recursive: true });
  copyFileSync(SCRIPT, scriptCopy);

  const run = (args, env = process.env) => {
    const result = spawnSync("bash", [scriptCopy, ...args], {
      cwd: checkout.dir,
      encoding: "utf8",
      env,
    });
    const stdoutLines = result.stdout.trim().split("\n");
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      refLine: stdoutLines.at(-2),
      last: stdoutLines.at(-1),
    };
  };
  const check = (extra = [], env = process.env) =>
    run(
      ["--ref", "feature", "--commit", briefed, "--from", origin, ...extra],
      env,
    );

  // Moves staging on with a change of its own, as other pull requests do.
  const advanceStaging = (file = "other.txt") => {
    checkout.git(["switch", "-q", "staging"]);
    checkout.write(file, `${file}\n`);
    const sha = checkout.commit(`staging moves: ${file}`);
    checkout.git(["push", "-q", "origin", "staging"]);
    checkout.git(["switch", "-q", "feature"]);
    return sha;
  };
  const rebaseFeature = () => {
    checkout.git(["rebase", "-q", "staging"]);
    checkout.git(["push", "-q", "-f", "origin", "feature"]);
    return checkout.head();
  };
  // A squash merge into staging on origin, then the branch deleted there, as
  // a merged pull request leaves it.
  const squashMerge = () => {
    checkout.git(["switch", "-q", "staging"]);
    checkout.git(["merge", "-q", "--squash", "feature"]);
    const squash = checkout.commit("feature, squashed");
    checkout.git(["push", "-q", "origin", "staging"]);
    checkout.git(["push", "-q", "origin", "--delete", "feature"]);
    return squash;
  };
  const promote = () => checkout.git(["push", "-q", "origin", "staging:main"]);
  const patchId = (sha, mode = "--verbatim") =>
    spawnSync("git", ["patch-id", mode], {
      input: checkout.git(["show", sha]),
      encoding: "utf8",
    }).stdout.split(" ")[0];

  return {
    origin,
    checkout,
    briefed,
    run,
    check,
    advanceStaging,
    rebaseFeature,
    squashMerge,
    promote,
    patchId,
  };
}

describe("host-commit-check.sh arguments", () => {
  it("prints its usage on --help", () => {
    const result = spawnSync("bash", [SCRIPT, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Usage: bash .claude/scripts/host-commit-check.sh --ref BRANCH --commit SHA",
    );
  });

  it.each([
    [["--bogus"], "unknown argument '--bogus'."],
    [["--ref"], "--ref needs a value."],
    [
      ["--commit", "a".repeat(40)],
      "name the branch the brief names with --ref.",
    ],
    [
      ["--ref", "feature"],
      "name the commit the brief was written for with --commit.",
    ],
    [["--ref", "-x", "--commit", "a".repeat(40)], "--ref takes a branch name"],
    [
      ["--ref", "feature", "--commit", "abc123"],
      "--commit takes a full 40-character sha",
    ],
  ])("refuses %j with exit 2", (args, message) => {
    const result = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(message);
  });
});

describe("host-commit-check.sh on a branch still on origin", () => {
  it("accepts the briefed commit itself", () => {
    const w = world();
    const result = w.check();
    expect(result.status).toBe(0);
    expect(result.refLine).toBe(`REF=feature TIP=${w.briefed}`);
    expect(result.last).toContain("the briefed commit.");
  });

  it("accepts a descendant of the briefed commit", () => {
    const w = world();
    w.checkout.write("later.txt", "later\n");
    const later = w.checkout.commit("later");
    w.checkout.git(["push", "-q", "origin", "feature"]);
    const result = w.check();
    expect(result.status).toBe(0);
    expect(result.refLine).toBe(`REF=feature TIP=${later}`);
    expect(result.last).toContain(
      `a descendant of the briefed commit ${w.briefed}`,
    );
  });

  it("accepts a branch rebased since the brief whose change has the same patch id", () => {
    const w = world();
    w.advanceStaging();
    const rebased = w.rebaseFeature();
    expect(rebased).not.toBe(w.briefed);
    expect(
      w.checkout.run(["merge-base", "--is-ancestor", w.briefed, rebased])
        .status,
    ).toBe(1);
    expect(w.patchId(rebased)).toBe(w.patchId(w.briefed));
    const result = w.check();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.refLine).toBe(`REF=feature TIP=${rebased}`);
    expect(result.last).toContain(
      `a rebase of the briefed commit ${w.briefed}, the same change (patch id ${w.patchId(w.briefed)})`,
    );
  });

  it("accepts a rebase of a branch of several commits", () => {
    const w = world({ featureCommits: 3 });
    w.advanceStaging();
    const rebased = w.rebaseFeature();
    const result = w.check();
    expect(result.status).toBe(0);
    expect(result.refLine).toBe(`REF=feature TIP=${rebased}`);
    expect(result.last).toContain("a rebase of the briefed commit");
  });

  it("accepts a rebase of a branch never pushed, read from the checkout", () => {
    const w = world();
    w.advanceStaging();
    w.checkout.git(["rebase", "-q", "staging"]);
    const rebased = w.checkout.head();
    const result = w.run([
      "--ref",
      "feature",
      "--commit",
      w.briefed,
      "--from",
      ".",
    ]);
    expect(result.status).toBe(0);
    expect(result.refLine).toBe(`REF=feature TIP=${rebased}`);
    expect(result.last).toContain("a rebase of the briefed commit");
  });

  it("refuses a rebased branch whose change differs", () => {
    const w = world();
    w.advanceStaging();
    w.rebaseFeature();
    w.checkout.write(
      "feature.txt",
      lines(40, "feature").replace("feature 10\n", "feature 10 otherwise\n"),
    );
    w.checkout.git(["commit", "-q", "-a", "--amend", "-m", "feature 1"]);
    const amended = w.checkout.head();
    w.checkout.git(["push", "-q", "-f", "origin", "feature"]);
    const result = w.check();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("REF=");
    expect(result.stderr).toContain(
      `feature at ${amended} is not the briefed commit ${w.briefed}, a descendant of it, or a rebase of the same change`,
    );
  });

  it("refuses a rebase that changed only whitespace", () => {
    const w = world();
    w.advanceStaging();
    w.rebaseFeature();
    w.checkout.write(
      "feature.txt",
      lines(40, "feature").replace("feature 10\n", "  feature 10 changed\n"),
    );
    w.checkout.git(["commit", "-q", "-a", "--amend", "-m", "feature 1"]);
    w.checkout.git(["push", "-q", "-f", "origin", "feature"]);
    expect(w.patchId("HEAD", "--stable")).toBe(
      w.patchId(w.briefed, "--stable"),
    );
    const result = w.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not the briefed commit");
  });

  it("refuses a same-change rebase when git has no patch-id --verbatim, accepting a descendant", () => {
    const w = world();
    const gitWithoutVerbatim = fixtures.makeTempDir("host-commit-oldgit-");
    const realGit = execFileSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).trim();
    writeFileSync(
      join(gitWithoutVerbatim, "git"),
      [
        "#!/bin/sh",
        'for arg in "$@"; do',
        '  if [ "$arg" = --verbatim ]; then echo "error: unknown option verbatim" >&2; exit 129; fi',
        "done",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${gitWithoutVerbatim}:${process.env.PATH}`,
    };
    w.checkout.write("later.txt", "later\n");
    w.checkout.commit("later");
    w.checkout.git(["push", "-q", "origin", "feature"]);
    expect(w.check([], env).status).toBe(0);

    w.checkout.git(["reset", "-q", "--hard", w.briefed]);
    w.advanceStaging();
    w.rebaseFeature();
    const result = w.check([], env);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("REF=");
    expect(result.stderr).toContain(
      "this git has no 'git patch-id --verbatim' to tell whether it is a rebase of the same change",
    );
  });

  it("checks --ref main as a branch, with no fallback to itself", () => {
    const w = world();
    w.checkout.git(["push", "-q", "origin", "feature:main"]);
    const result = w.run([
      "--ref",
      "main",
      "--commit",
      w.briefed,
      "--from",
      w.origin,
    ]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.refLine).toBe(`REF=main TIP=${w.briefed}`);

    const elsewhere = fixtures.makeTempDir("host-commit-empty-origin-");
    execFileSync("git", ["init", "-q", "--bare", elsewhere]);
    const missing = w.run([
      "--ref",
      "main",
      "--commit",
      w.briefed,
      "--from",
      elsewhere,
    ]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      `main is not on ${realpathSync(elsewhere)}; refusing to guess a ref.`,
    );
  });

  it("refuses a rebase whose last commit matches but an earlier one changed", () => {
    const w = world({ featureCommits: 2 });
    w.advanceStaging();
    w.rebaseFeature();
    const tipChange = w.checkout.git(["show", "--format=", "HEAD"]);
    w.checkout.git(["reset", "-q", "--hard", "HEAD~2"]);
    w.checkout.write(
      "feature.txt",
      lines(40, "feature").replace("feature 10\n", "feature 10 otherwise\n"),
    );
    w.checkout.commit("feature 1, different");
    const patch = join(fixtures.makeTempDir("host-commit-patch-"), "tip.patch");
    writeFileSync(patch, tipChange);
    w.checkout.git(["apply", "--index", patch]);
    w.checkout.git(["commit", "-q", "-m", "feature 2"]);
    w.checkout.git(["push", "-q", "-f", "origin", "feature"]);
    expect(w.patchId("HEAD")).toBe(w.patchId(w.briefed));
    const result = w.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not the briefed commit");
  });

  it("refuses a briefed commit this checkout does not hold", () => {
    const w = world();
    const result = w.run([
      "--ref",
      "feature",
      "--commit",
      "0".repeat(40),
      "--from",
      w.origin,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `the briefed commit ${"0".repeat(40)} is not in`,
    );
  });

  it("leaves the checkout's refs as they were", () => {
    const w = world();
    w.advanceStaging();
    w.rebaseFeature();
    const refs = () => w.checkout.git(["for-each-ref"]);
    const before = refs();
    expect(w.check().status).toBe(0);
    expect(refs()).toBe(before);
  });
});

describe("host-commit-check.sh once the branch has merged", () => {
  it("reads main on its first run, and accepts it once a promotion carried the squashed change", () => {
    const w = world();
    w.advanceStaging();
    w.rebaseFeature();
    w.squashMerge();
    w.advanceStaging("after.txt");
    w.promote();
    const main = w.checkout.git(["rev-parse", "staging"]).trim();
    const result = w.check();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `feature is not on ${realpathSync(w.origin)}, so it has merged or been deleted; reading main instead`,
    );
    expect(result.refLine).toBe(`REF=main TIP=${main}`);
    expect(result.last).toContain("it holds every line the briefed change");
  });

  it("accepts main holding a squash of the briefed commit and later fixes on other lines", () => {
    const w = world();
    w.checkout.write(
      "feature.txt",
      w.checkout
        .git(["show", "HEAD:feature.txt"])
        .replace("feature 30\n", "feature 30 review fix\n"),
    );
    w.checkout.commit("review fix");
    w.checkout.git(["push", "-q", "origin", "feature"]);
    const squash = w.squashMerge();
    w.promote();
    expect(w.patchId(squash)).not.toBe(w.patchId(w.briefed));
    const result = w.check();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.refLine).toBe(`REF=main TIP=${squash}`);
  });

  it("refuses main when later commits changed the briefed lines, asking for a re-brief", () => {
    const w = world();
    w.checkout.write(
      "feature.txt",
      w.checkout
        .git(["show", "HEAD:feature.txt"])
        .replace("feature 10 changed\n", "feature 10 fixed\n"),
    );
    w.checkout.commit("review fix on the briefed line");
    w.checkout.git(["push", "-q", "origin", "feature"]);
    w.squashMerge();
    w.promote();
    const result = w.check();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("REF=");
    expect(result.stderr).toContain(
      "later commits changed some of the same lines or the lines around them. Refusing it; re-brief the hand-off at a main commit.",
    );
  });

  it("accepts main holding the briefed commit itself, as a merge commit leaves it", () => {
    const w = world();
    w.checkout.git(["switch", "-q", "staging"]);
    w.checkout.git([
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "merge feature",
      "feature",
    ]);
    w.checkout.git(["push", "-q", "origin", "staging", "staging:main"]);
    w.checkout.git(["push", "-q", "origin", "--delete", "feature"]);
    const result = w.check();
    expect(result.status).toBe(0);
    expect(result.refLine).toBe(`REF=main TIP=${w.checkout.head()}`);
    expect(result.last).toContain(`it holds the briefed commit ${w.briefed}`);
  });

  it("refuses main before staging is promoted, saying the hand-off waits for that", () => {
    const w = world();
    w.squashMerge();
    const result = w.check();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("REF=");
    expect(result.stderr).toContain(
      "holds none of the lines the briefed change",
    );
    expect(result.stderr).toContain(
      "If feature has not reached main yet, a hand-off that needs it on main waits for a session after it does.",
    );
  });

  it("accepts staging under --merged-ref staging before the promotion", () => {
    const w = world();
    const squash = w.squashMerge();
    const result = w.check(["--merged-ref", "staging"]);
    expect(result.status).toBe(0);
    expect(result.refLine).toBe(`REF=staging TIP=${squash}`);
  });

  it("refuses main when a different change merged under the branch's name", () => {
    const w = world();
    w.checkout.git(["switch", "-q", "staging"]);
    w.checkout.write(
      "feature.txt",
      lines(40, "feature").replace("feature 10\n", "feature 10 otherwise\n"),
    );
    w.checkout.commit("a different change");
    w.checkout.git(["push", "-q", "origin", "staging", "staging:main"]);
    w.checkout.git(["push", "-q", "origin", "--delete", "feature"]);
    const result = w.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("holds neither the briefed change");
  });
});
