import { releaseVersion } from "./alcoveImage";

/**
 * The line naming what a build is: its product version where it has one in
 * release shape, else the short commit hash it was built from, else nothing.
 */
export function buildLabel(
  version: string | undefined,
  commit: string | undefined,
): string | undefined {
  const release = releaseVersion(version);
  if (release !== undefined) return `Version ${release}`;
  if (commit !== undefined) return `Commit ${commit}`;
  return undefined;
}
