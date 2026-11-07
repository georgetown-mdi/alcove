#!/usr/bin/env node
// Whether a release's production upload keeps production at or ahead of main,
// run by release.yaml's deploy-order job, which the pages job waits for.
//
// pages_deploy.yaml deploys production from every push to main that changes
// what the site is built from, so production serves a commit main holds. The
// release's upload goes ahead only when main's tip is the tag's commit or an
// ancestor of it: every commit main can have deployed is then one the tag's
// commit holds. When main has commits the tag's commit lacks, the upload is
// skipped and production keeps the build main deployed.
//
// What this cannot see:
//   - Whether main's commits after the tag change the site. A main that gained
//     only commits pages_deploy.yaml does not deploy on still skips the upload,
//     and production keeps the commit build main deployed last.
//   - A push to main after the job fetches main. Should that push's run upload
//     before the pages job does, the release's upload replaces it.

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAIN = "refs/remotes/origin/main";

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Whether `ancestor` is `descendant` or one of its ancestors, by git. */
function isAncestor(cwd, ancestor, descendant) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd, encoding: "utf8" },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `git merge-base could not compare ${ancestor} with ${descendant}: ${result.stderr.trim()}`,
  );
}

/**
 * Compares the release commit `release` (a commit or a tag object) with main
 * as `origin` holds it now, in the clone at `cwd`. `deploys` is true when
 * main's tip is the release commit or an ancestor of it; `reason` says why.
 * Throws on a shallow clone, whose history cannot settle the comparison.
 */
export function releaseDeployOrder(cwd, release) {
  if (git(cwd, ["rev-parse", "--is-shallow-repository"]) === "true") {
    throw new Error(
      "The checkout is shallow, so main's history cannot be compared with the release commit. Check out with fetch-depth: 0.",
    );
  }
  git(cwd, [
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    `+refs/heads/main:${MAIN}`,
  ]);
  const commit = git(cwd, ["rev-parse", "--verify", `${release}^{commit}`]);
  const main = git(cwd, ["rev-parse", "--verify", `${MAIN}^{commit}`]);
  if (isAncestor(cwd, main, commit)) {
    return {
      deploys: true,
      reason: `main's tip ${main} is the release commit ${commit} or an ancestor of it, so the upload moves production to no older commit than main deployed.`,
    };
  }
  return {
    deploys: false,
    reason: isAncestor(cwd, commit, main)
      ? `main's tip ${main} has commits after the release commit ${commit}, so production keeps the build main deployed.`
      : `The release commit ${commit} is not on main, whose tip ${main} has commits it lacks, so production keeps the build main deployed.`,
  };
}

// CLI entry: prints `true` or `false` on stdout and the reason on stderr. The
// commit arrives in the environment, so the workflow hands it over without a
// `${{ }}` interpolation into the `run:` line.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const release = process.env.ALCOVE_RELEASE_COMMIT;
  if (release === undefined || release === "") {
    console.error(
      "usage: ALCOVE_RELEASE_COMMIT=<commit> node scripts/release-deploy-order.mjs",
    );
    process.exit(2);
  }
  const { deploys, reason } = releaseDeployOrder(process.cwd(), release);
  console.error(reason);
  console.log(String(deploys));
}
