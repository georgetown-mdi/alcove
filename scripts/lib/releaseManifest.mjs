// The canonical release version, where it is read from, and when the
// compatibility policy binds it, shared by the checks that read it:
// check-release-version.mjs holds a pushed release tag to it,
// check-protocol-version-bump.mjs reads it as the marker deciding whether the
// wire-format pin binds yet, and check-exchange-record-version.mjs as the marker
// the record-format reset is dated by. One manifest path, one reader, and one
// floor, so no two of them can come to disagree about which file holds the
// release version, what counts as holding one, or when the policy binds.

/** The manifest holding the canonical release version (docs/RELEASES.md). */
export const RELEASE_MANIFEST = "apps/cli/package.json";

// The release from which the compatibility policy binds (docs/RELEASES.md,
// Versioning). A 0.x release carries no compatibility promise and partners
// upgrade together, so below this floor a wire-format delta ships within the
// current PROTOCOL_VERSION and the format literals stay development counters.
// Moving this floor moves every rule dated by it.
export const COMPATIBILITY_RELEASE = "1.0.0";

/**
 * The release version a package manifest's source contains, or undefined when it
 * contains none -- an absent `version` key and an empty one alike, since the
 * image build bakes either as nothing.
 */
export function manifestVersion(manifestSource) {
  const { version } = JSON.parse(manifestSource);
  return typeof version === "string" && version !== "" ? version : undefined;
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
  const compared = compareReleaseVersions(version, COMPATIBILITY_RELEASE);
  return compared === undefined ? undefined : compared >= 0;
}
