#!/usr/bin/env node
// Newest-release-line decision, run by release.yaml's release-line job.
//
// A release tag on the newest line deploys the hosted app to production and
// moves the `latest` and `latest-fips` image tags. A tag on an older line, such
// as a hotfix of the previous major, publishes everything else as any release
// does, and neither of those two, so production and `latest` never move back.
//
// The rule, read from the release tags the repository holds when the job runs:
// the pushed tag is on the newest line when no release tag names a higher
// version, by version order rather than tag date. Only the `vX.Y.Z` shape the
// workflow triggers on is a release tag; a pre-release or any other tag is not
// compared. The first release, with no other release tag, is on the newest line.
//
// What this cannot see:
//   - A tag pushed after the job lists the tags: two release runs started at
//     once each decide from the list it read.
//   - Whether a release tag it compares against was ever published. A tag whose
//     run failed still counts as the newer line.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { taggedVersion } from "./check-release-version.mjs";
import { compareReleaseVersions } from "./lib/releaseManifest.mjs";

/**
 * Whether `tag` is on the newest release line among `repositoryTags`. Throws
 * when `tag` is not a release tag, since it then names no version to order.
 */
export function isOnNewestReleaseLine(tag, repositoryTags) {
  const version = taggedVersion(tag);
  if (version === undefined) {
    throw new Error(
      `"${tag}" is not a release tag (vX.Y.Z), so it names no version to compare with the repository's release tags`,
    );
  }
  return !repositoryTags.some((other) => {
    const otherVersion = taggedVersion(other);
    return (
      otherVersion !== undefined &&
      compareReleaseVersions(otherVersion, version) === 1
    );
  });
}

/** The tag names in `git ls-remote --tags --refs` output. */
export function tagsFromLsRemote(output) {
  return output
    .split("\n")
    .map((line) => /^[0-9a-f]+\trefs\/tags\/(.+)$/.exec(line)?.[1])
    .filter((name) => name !== undefined);
}

// CLI entry: prints `true` or `false` on stdout and the reason on stderr. The
// tag arrives in the environment, so the workflow hands it over without a
// `${{ }}` interpolation into the `run:` line.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.env.ALCOVE_TAG;
  if (tag === undefined || tag === "") {
    console.error("usage: ALCOVE_TAG=vX.Y.Z node scripts/release-line.mjs");
    process.exit(2);
  }
  const tags = tagsFromLsRemote(
    execFileSync("git", ["ls-remote", "--tags", "--refs", "origin"], {
      encoding: "utf8",
    }),
  );
  const newest = isOnNewestReleaseLine(tag, tags);
  console.error(
    newest
      ? `${tag} is on the newest release line: no release tag names a higher version.`
      : `${tag} is on an older release line: a release tag names a higher version, so this release does not deploy production or move latest.`,
  );
  console.log(String(newest));
}
