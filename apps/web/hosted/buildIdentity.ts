import { execFileSync } from "node:child_process";

/** The release tag shape `.github/workflows/release.yaml` triggers on,
 * capturing the version it names. */
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;

/** A full SHA-1 or SHA-256 commit id, as git and `GITHUB_SHA` write it. */
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** How many leading hex digits of the commit a hosted build shows. */
export const SHORT_COMMIT_LENGTH = 7;

/**
 * What a hosted build names itself by in its UI: the product version when it
 * is built from a release tag, else empty; and the short commit hash it was
 * built from, empty when neither the CI run nor git names one.
 */
export interface HostedBuildIdentity {
  version: string;
  commit: string;
}

/** The commit the working tree is checked out at, or undefined outside a git
 * checkout. */
export function gitHeadCommit(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The {@link HostedBuildIdentity} of a hosted build run under `env`. A GitHub
 * Actions run on a release tag (`GITHUB_REF_TYPE` `tag`, `GITHUB_REF_NAME`
 * `vX.Y.Z`) names that version; any other build names no version. The commit
 * is `GITHUB_SHA` in a CI run and `headCommit()` elsewhere.
 */
export function hostedBuildIdentity(
  env: Readonly<Record<string, string | undefined>>,
  headCommit: () => string | undefined,
): HostedBuildIdentity {
  const version =
    env["GITHUB_REF_TYPE"] === "tag"
      ? (RELEASE_TAG.exec(env["GITHUB_REF_NAME"] ?? "")?.[1] ?? "")
      : "";
  const ciCommit = env["GITHUB_SHA"];
  const fullCommit =
    ciCommit !== undefined && FULL_COMMIT.test(ciCommit)
      ? ciCommit
      : headCommit();
  const commit =
    fullCommit !== undefined && FULL_COMMIT.test(fullCommit)
      ? fullCommit.slice(0, SHORT_COMMIT_LENGTH)
      : "";
  return { version, commit };
}

/**
 * The Vite `define` entries baking a {@link HostedBuildIdentity} into the
 * client's `import.meta.env`, where `@utils/clientConfig` reads it. The build
 * sets both values whatever the environment holds, so a hosted build names
 * only the release tag it was built from.
 */
export function hostedBuildIdentityDefines(
  identity: HostedBuildIdentity,
): Record<string, string> {
  return {
    "import.meta.env.VITE_ALCOVE_VERSION": JSON.stringify(identity.version),
    "import.meta.env.VITE_BUILD_COMMIT": JSON.stringify(identity.commit),
  };
}
