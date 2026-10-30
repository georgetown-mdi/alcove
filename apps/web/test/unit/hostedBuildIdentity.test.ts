import { afterEach, describe, expect, test, vi } from "vitest";

import { buildLabel } from "@utils/buildLabel";
import { parseClientConfig } from "@utils/clientConfig";

import {
  SHORT_COMMIT_LENGTH,
  gitHeadCommit,
  hostedBuildIdentity,
} from "../../hosted/buildIdentity";
import hostedConfig from "../../vite.hosted.config";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const noHead = (): string | undefined => undefined;

describe("hostedBuildIdentity", () => {
  test("a run on a release tag names the tag's version and its commit", () => {
    expect(
      hostedBuildIdentity(
        {
          GITHUB_REF_TYPE: "tag",
          GITHUB_REF_NAME: "v0.9.0",
          GITHUB_SHA: COMMIT,
        },
        noHead,
      ),
    ).toEqual({ version: "0.9.0", commit: "0123456" });
  });

  test.each([
    ["a branch", { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "staging" }],
    [
      "a branch named like a release tag",
      { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "v0.9.0" },
    ],
    [
      "a tag outside the release shape",
      { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "broker-core-build" },
    ],
    [
      "a prerelease tag",
      { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.9.0-rc.1" },
    ],
  ])("a run on %s names no version", (_label, ref) => {
    expect(hostedBuildIdentity({ ...ref, GITHUB_SHA: COMMIT }, noHead)).toEqual(
      { version: "", commit: "0123456" },
    );
  });

  test("outside CI the commit is the checkout's HEAD", () => {
    expect(hostedBuildIdentity({}, () => OTHER_COMMIT)).toEqual({
      version: "",
      commit: OTHER_COMMIT.slice(0, SHORT_COMMIT_LENGTH),
    });
  });

  test("a CI commit is preferred over the checkout's HEAD", () => {
    expect(
      hostedBuildIdentity({ GITHUB_SHA: COMMIT }, () => OTHER_COMMIT).commit,
    ).toBe("0123456");
  });

  test.each<[string, Record<string, string>, () => string | undefined]>([
    ["no commit anywhere", {}, noHead],
    ["a malformed commit", { GITHUB_SHA: "not-a-commit" }, () => "HEAD"],
  ])("names no commit given %s", (_label, env, head) => {
    expect(hostedBuildIdentity(env, head).commit).toBe("");
  });

  test("reads this checkout's HEAD as a full commit id", () => {
    expect(gitHeadCommit(process.cwd())).toMatch(/^[0-9a-f]{40,64}$/);
  });

  test("reads no commit outside a git checkout", () => {
    expect(gitHeadCommit("/")).toBeUndefined();
  });
});

describe("what the hosted build shows", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The hosted config's own `define`, read back through the client's config
  // parser and the footer's label, so the chain from the CI run's ref to the
  // line the page shows is held end to end.
  function shownLabel(env: Record<string, string>): string | undefined {
    vi.stubEnv("VITE_SIGNALING_SERVER_URL", "ws://127.0.0.1/api/");
    for (const name of ["GITHUB_REF_TYPE", "GITHUB_REF_NAME", "GITHUB_SHA"])
      vi.stubEnv(name, env[name] ?? "");
    vi.stubEnv("VITE_ALCOVE_VERSION", "9.9.9");
    const define = hostedConfig({
      command: "build",
      mode: "production",
    }).define;
    const data = Object.fromEntries(
      Object.entries(define ?? {}).map(([key, value]) => [
        key.replace(/^import\.meta\.env\.VITE_/, ""),
        JSON.parse(String(value)) as unknown,
      ]),
    );
    const config = parseClientConfig(data);
    return buildLabel(
      config.ALCOVE_VERSION === "" ? undefined : config.ALCOVE_VERSION,
      config.BUILD_COMMIT === "" ? undefined : config.BUILD_COMMIT,
    );
  }

  test("a build from a release tag shows the tag's version", () => {
    expect(
      shownLabel({
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: "v0.9.0",
        GITHUB_SHA: COMMIT,
      }),
    ).toBe("Version 0.9.0");
  });

  test("a build from a branch shows the short commit hash, whatever version the environment sets", () => {
    expect(
      shownLabel({
        GITHUB_REF_TYPE: "branch",
        GITHUB_REF_NAME: "staging",
        GITHUB_SHA: COMMIT,
      }),
    ).toBe("Commit 0123456");
  });
});

describe("buildLabel", () => {
  test("prefers a release version over the commit", () => {
    expect(buildLabel("1.2.3", "abcdef0")).toBe("Version 1.2.3");
  });

  test.each([undefined, "0.0.0", "latest"])(
    "shows the commit for the version %j",
    (version) => {
      expect(buildLabel(version, "abcdef0")).toBe("Commit abcdef0");
    },
  );

  test("shows nothing for a build naming neither", () => {
    expect(buildLabel(undefined, undefined)).toBeUndefined();
  });
});
