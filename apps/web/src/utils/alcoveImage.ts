/**
 * The published Alcove image a `docker run` line the app shows names: the
 * partner accept kit's commands and the console's recurring-run hand-off.
 */

/** The published image, named with its registry in full, as the release
 * launchers are, because podman requires the registry prefix and docker
 * accepts it (see `docs/RELEASES.md`). */
const ALCOVE_IMAGE_REPOSITORY = "ghcr.io/georgetown-mdi/alcove";

/**
 * The image tag a line names when the build holds no release version -- a
 * development or hosted build, neither of which is a published image. It is
 * the floating tag the release publishes alongside `X.Y.Z`
 * (`docs/RELEASES.md`).
 */
const DEFAULT_ALCOVE_IMAGE_TAG = "latest";

/**
 * The shape a release version has: `X.Y.Z` with semver's optional prerelease
 * and build suffixes (`docs/RELEASES.md`). `0.0.0`, the marker for manifests
 * that hold no release version, is excluded: the image build reads the CLI
 * manifest, which never holds it, so the carve-out guards a build mis-wired to
 * the unversioned web or root manifest.
 */
const RELEASE_VERSION =
  /^(?!0\.0\.0(?:[-+]|$))\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** This build's release version, or undefined when it holds none in the
 * shape {@link RELEASE_VERSION} admits. The one gate on the value: nothing the
 * build supplies is interpolated into a command without passing it. */
export function releaseVersion(
  version: string | undefined,
): string | undefined {
  return version !== undefined && RELEASE_VERSION.test(version)
    ? version
    : undefined;
}

/** The image reference for a version {@link releaseVersion} returned: a
 * released image named by its own version, any other build by the floating
 * tag. */
export function imageReference(version: string | undefined): string {
  return `${ALCOVE_IMAGE_REPOSITORY}:${version ?? DEFAULT_ALCOVE_IMAGE_TAG}`;
}
