/**
 * The published Alcove image a `docker run` line the app shows names: the
 * partner accept kit's commands and the console's recurring-run hand-off.
 */

/** A registry each release publishes the same images to, under one digest and
 * one signer (`docs/RELEASES.md`). */
export type ImageRegistry = "docker.io" | "ghcr.io";

/** Every {@link ImageRegistry}, in the order a partner is pointed at them:
 * Docker Hub first, ghcr.io as the alternative. */
export const IMAGE_REGISTRIES = [
  "docker.io",
  "ghcr.io",
] as const satisfies ReadonlyArray<ImageRegistry>;

/** Each registry's repository, named with its registry in full, as the release
 * launchers are, because podman requires the registry prefix and docker
 * accepts it (see `docs/RELEASES.md`). */
const ALCOVE_IMAGE_REPOSITORIES: Readonly<Record<ImageRegistry, string>> = {
  "docker.io": "docker.io/gumdi/alcove",
  "ghcr.io": "ghcr.io/georgetown-mdi/alcove",
};

/** The registry a console line names when the console was told none. */
export const DEFAULT_IMAGE_REGISTRY: ImageRegistry = "ghcr.io";

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

/** The shape of the manifest-list digest a release signs and the launchers
 * pin: `sha256:` and 64 lowercase hex digits. */
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

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

/** `value` when it is an {@link ImageRegistry}, else undefined. */
export function imageRegistry(value: unknown): ImageRegistry | undefined {
  return IMAGE_REGISTRIES.find((registry) => registry === value);
}

/** `value` when it has the shape of an image digest ({@link IMAGE_DIGEST}),
 * else undefined. The one gate on a digest: none reaches a line without
 * passing it. */
export function imageDigest(value: unknown): string | undefined {
  return typeof value === "string" && IMAGE_DIGEST.test(value)
    ? value
    : undefined;
}

/** The repository a registry publishes the image under. */
export function imageRepository(registry: ImageRegistry): string {
  return ALCOVE_IMAGE_REPOSITORIES[registry];
}

/** The image reference for a version {@link releaseVersion} returned: a
 * released image named by its own version, any other build by the floating
 * tag, on `registry`. */
export function imageReference(
  version: string | undefined,
  registry: ImageRegistry = DEFAULT_IMAGE_REGISTRY,
): string {
  return `${imageRepository(registry)}:${version ?? DEFAULT_ALCOVE_IMAGE_TAG}`;
}

/** The image pinned by a digest {@link imageDigest} returned, on `registry`. */
export function digestReference(
  digest: string,
  registry: ImageRegistry,
): string {
  return `${imageRepository(registry)}@${digest}`;
}
