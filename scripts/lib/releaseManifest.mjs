// The canonical release version, where it is read from, and the releases the
// rules reading it are dated by, shared by the checks that read it:
// check-release-version.mjs holds a pushed release tag to it,
// check-protocol-version-bump.mjs reads it as the marker deciding whether the
// wire-format pin binds yet, and check-exchange-record-version.mjs as the marker
// the record-format reset is dated by. One manifest path, one reader, and one
// definition of each floor, so no two of them can come to disagree about which
// file holds the release version, what counts as holding one, or when a rule
// binds. The release-tag shape is read here too, for check-release-version.mjs
// and release-line.mjs, so the two agree on what a release tag is.

/** The manifest holding the canonical release version (docs/RELEASES.md). */
export const RELEASE_MANIFEST = "apps/cli/package.json";

// The release from which the compatibility policy binds (docs/RELEASES.md,
// Versioning). A 0.x release carries no compatibility promise and partners
// upgrade together, so below this floor a wire-format delta ships within the
// current PROTOCOL_VERSION. Moving this floor moves every rule dated by it.
export const COMPATIBILITY_RELEASE = "1.0.0";

// The first release at or above which the six record-format literals ship
// reset to v1 (docs/RELEASES.md, "Reset the exchange-record format at 0.9.0").
// Below it they are development counters. It is no later than
// COMPATIBILITY_RELEASE, and a record-format change between the two bumps
// forward from v1 with a migration step.
export const RESET_RELEASE = "0.9.0";

/**
 * The release version a package manifest's source contains, or undefined when it
 * contains none -- an absent `version` key and an empty one alike, since the
 * image build bakes either as nothing.
 */
export function manifestVersion(manifestSource) {
  const { version } = JSON.parse(manifestSource);
  return typeof version === "string" && version !== "" ? version : undefined;
}

// The release-tag shape .github/workflows/release.yaml triggers on, as a
// capture of the version it names.
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;

/**
 * The version a release tag names, or undefined when the tag is not in the
 * shape the release workflow triggers on.
 */
export function taggedVersion(tag) {
  const match = RELEASE_TAG.exec(tag ?? "");
  return match === null ? undefined : match[1];
}

/**
 * The `major.minor.patch` triple a release version names, or undefined when the
 * value is not in that shape. A prerelease or build suffix is treated as the
 * release it qualifies: a published `0.2.0-rc.1` deploys peers exactly as
 * `0.2.0` does.
 */
export function parseReleaseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(
    typeof version === "string" ? version : "",
  );
  return match === null
    ? undefined
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * How two release versions order, as -1, 0, or 1, or undefined when either is
 * not in a shape this can read. Undefined is not "equal": a caller that cannot
 * read one of them fails rather than treating the comparison as settled.
 */
export function compareReleaseVersions(left, right) {
  const first = parseReleaseVersion(left);
  const second = parseReleaseVersion(right);
  if (first === undefined || second === undefined) return undefined;
  for (let i = 0; i < first.length; i += 1) {
    if (first[i] !== second[i]) return first[i] > second[i] ? 1 : -1;
  }
  return 0;
}

/**
 * Whether the compatibility policy binds the release version (it is
 * COMPATIBILITY_RELEASE or above), or undefined when the version is not in a
 * shape this can read. Undefined is not "no": a caller that cannot read the
 * marker fails rather than treating the rule as inert.
 */
export function isCompatibilityRelease(version) {
  return isAtOrAbove(version, COMPATIBILITY_RELEASE);
}

/**
 * Whether the record-format reset is due at the release version (it is
 * RESET_RELEASE or above), or undefined when the version is not in a shape
 * this can read, which a caller fails on as above.
 */
export function isResetRelease(version) {
  return isAtOrAbove(version, RESET_RELEASE);
}

function isAtOrAbove(version, floor) {
  const compared = compareReleaseVersions(version, floor);
  return compared === undefined ? undefined : compared >= 0;
}
