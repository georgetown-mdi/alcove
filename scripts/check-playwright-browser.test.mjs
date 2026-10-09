import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  checkInstalledBrowser,
  expectedBuilds,
  missingBuildLine,
  otherRevisions,
  pinnedPlaywrightVersion,
} from "./check-playwright-browser.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const script = join(here, "check-playwright-browser.mjs");

// The dry-run cases drive the installed playwright, about a second each on a
// loaded container.
const TOOL_TIMEOUT_MS = 30_000;

const scratch = mkdtempSync(join(tmpdir(), "check-playwright-browser-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let browsersPathCount = 0;
function emptyBrowsersPath() {
  browsersPathCount += 1;
  const path = join(scratch, `browsers-${browsersPathCount}`);
  mkdirSync(path);
  return path;
}

function lockfile(packages) {
  return JSON.stringify({ lockfileVersion: 3, packages });
}

describe("pinnedPlaywrightVersion", () => {
  it("returns the version of the one playwright-core installed", () => {
    expect(
      pinnedPlaywrightVersion(
        lockfile({
          "": { name: "root" },
          "node_modules/playwright": { version: "1.64.0" },
          "node_modules/playwright-core": { version: "1.64.0" },
        }),
      ),
    ).toBe("1.64.0");
  });

  it("accepts a nested copy at the same version", () => {
    expect(
      pinnedPlaywrightVersion(
        lockfile({
          "node_modules/playwright-core": { version: "1.64.0" },
          "apps/web/node_modules/playwright-core": { version: "1.64.0" },
        }),
      ),
    ).toBe("1.64.0");
  });

  it("refuses two versions, since the image bakes one build", () => {
    expect(() =>
      pinnedPlaywrightVersion(
        lockfile({
          "node_modules/playwright-core": { version: "1.64.0" },
          "apps/web/node_modules/playwright-core": { version: "1.65.0" },
        }),
      ),
    ).toThrow("more than one playwright-core: 1.64.0, 1.65.0");
  });

  it("refuses a lockfile with no playwright-core", () => {
    expect(() =>
      pinnedPlaywrightVersion(
        lockfile({ "node_modules/other": { version: "1.0.0" } }),
      ),
    ).toThrow("installs no playwright-core");
  });

  it("ignores a workspace entry named playwright-core with no node_modules segment", () => {
    expect(
      pinnedPlaywrightVersion(
        lockfile({
          "packages/playwright-core": { version: "0.0.0" },
          "node_modules/playwright-core": { version: "1.64.0" },
        }),
      ),
    ).toBe("1.64.0");
  });

  it("matches the playwright-core the committed lockfile installed", () => {
    const installed = JSON.parse(
      readFileSync(
        join(repoRoot, "node_modules/playwright-core/package.json"),
        "utf8",
      ),
    ).version;
    expect(
      pinnedPlaywrightVersion(
        readFileSync(join(repoRoot, "package-lock.json"), "utf8"),
      ),
    ).toBe(installed);
  });
});

describe("expectedBuilds", () => {
  it("pairs each title with its install location", () => {
    const output = [
      "Chrome for Testing 1.0 (playwright chromium v12)",
      "  Install location:    /pw/chromium-12",
      "  Download url:        https://example.invalid/a.zip",
      "",
      "FFmpeg (playwright ffmpeg v3)",
      "  Install location:    /pw/ffmpeg-3",
      "",
    ].join("\n");
    expect(expectedBuilds(output)).toEqual([
      {
        title: "Chrome for Testing 1.0 (playwright chromium v12)",
        location: "/pw/chromium-12",
      },
      { title: "FFmpeg (playwright ffmpeg v3)", location: "/pw/ffmpeg-3" },
    ]);
  });

  it("returns nothing for output naming no location", () => {
    expect(expectedBuilds("something else\n")).toEqual([]);
  });
});

describe("otherRevisions", () => {
  it("lists other revisions of the same build only", () => {
    const listing = () => [
      "chromium-1247",
      "chromium_headless_shell-1247",
      "ffmpeg-1013",
      "chromium-1248",
    ];
    expect(otherRevisions("/pw/chromium-1248", listing)).toEqual([
      "chromium-1247",
    ]);
    expect(otherRevisions("/pw/chromium_headless_shell-1248", listing)).toEqual(
      ["chromium_headless_shell-1247"],
    );
  });

  it("returns nothing when the directory cannot be listed", () => {
    expect(
      otherRevisions(join(scratch, "absent", "chromium-1"), (path) => {
        throw new Error(`no ${path}`);
      }),
    ).toEqual([]);
  });
});

describe("missingBuildLine", () => {
  const builds = [{ title: "Chromium (v2)", location: "/pw/chromium-2" }];

  it("is null when every build is present", () => {
    expect(
      missingBuildLine({
        version: "1.0.0",
        builds,
        inDevContainer: true,
        exists: () => true,
      }),
    ).toBeNull();
  });

  it("names the missing build, what is there, and the rebuild, on one line", () => {
    const line = missingBuildLine({
      version: "1.0.0",
      builds,
      inDevContainer: true,
      exists: () => false,
      listDirectory: () => ["chromium-1"],
    });
    expect(line).not.toContain("\n");
    expect(line).toContain("playwright 1.0.0 expects Chromium (v2)");
    expect(line).toContain("(installed: chromium-1)");
    expect(line).toContain("Rebuild the dev container");
  });

  it("names the playwright install outside the dev container", () => {
    const line = missingBuildLine({
      version: "1.0.0",
      builds,
      inDevContainer: false,
      exists: () => false,
      listDirectory: () => [],
    });
    expect(line).toContain("(installed: none)");
    expect(line).toContain("npx playwright install chromium");
  });
});

describe("checkInstalledBrowser against the installed playwright", () => {
  const notLaunched = async () => {
    throw new Error("launch is not reached while a build is missing");
  };

  it(
    "fails with one line when the browsers directory lacks the expected build",
    async () => {
      const browsersPath = emptyBrowsersPath();
      mkdirSync(join(browsersPath, "chromium-1"));
      const result = await checkInstalledBrowser({
        root: repoRoot,
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: browsersPath,
          DEVCONTAINER: "true",
        },
        launch: notLaunched,
      });
      expect(result.code).toBe(1);
      expect(result.line).not.toContain("\n");
      expect(result.line).toContain(join(browsersPath, "chromium-"));
      expect(result.line).toContain("installed: chromium-1)");
      expect(result.line).toContain("Rebuild the dev container");
    },
    TOOL_TIMEOUT_MS,
  );

  it(
    "passes once every location the dry run names exists and the launch starts",
    async () => {
      const browsersPath = emptyBrowsersPath();
      const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath };
      const dryRun = execFileSync(
        process.execPath,
        [
          join(repoRoot, "node_modules/playwright/cli.js"),
          "install",
          "--dry-run",
          "chromium",
        ],
        { env, encoding: "utf8" },
      );
      const builds = expectedBuilds(dryRun);
      expect(builds.length).toBeGreaterThan(0);
      for (const build of builds) mkdirSync(build.location);
      const result = await checkInstalledBrowser({
        root: repoRoot,
        env,
        launch: async () => null,
      });
      expect(result).toEqual({
        code: 0,
        line: expect.stringContaining(`installed at ${browsersPath}`),
      });
    },
    TOOL_TIMEOUT_MS,
  );

  it(
    "fails with the launch error when the build is present but does not start",
    async () => {
      const browsersPath = emptyBrowsersPath();
      const env = {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath,
        DEVCONTAINER: "true",
      };
      const result = await checkInstalledBrowser({
        root: repoRoot,
        env,
        exists: () => true,
        launch: async () => "libnss3.so: cannot open shared object file",
      });
      expect(result.code).toBe(1);
      expect(result.line).toContain(
        "did not start: libnss3.so: cannot open shared object file",
      );
      expect(result.line).toContain("Rebuild the dev container");
    },
    TOOL_TIMEOUT_MS,
  );
});

describe("checkInstalledBrowser without playwright", () => {
  it("cannot verify a tree with no installed playwright", async () => {
    const root = join(scratch, "bare");
    mkdirSync(join(root, "apps/web"), { recursive: true });
    writeFileSync(join(root, "apps/web/package.json"), "{}");
    const result = await checkInstalledBrowser({ root });
    expect(result.code).toBe(2);
    expect(result.line).toContain("Run `npm ci`");
  });
});

describe("the command line", () => {
  it("prints the lockfile's playwright-core version for the image build", () => {
    const lockPath = join(scratch, "package-lock.json");
    writeFileSync(
      lockPath,
      lockfile({ "node_modules/playwright-core": { version: "9.8.7" } }),
    );
    expect(
      execFileSync(process.execPath, [script, "--pinned-version", lockPath], {
        encoding: "utf8",
      }),
    ).toBe("9.8.7\n");
  });
});

describe("the dev-container Dockerfile", () => {
  const dockerfile = readFileSync(
    join(repoRoot, ".devcontainer/Dockerfile"),
    "utf8",
  );

  it("copies every module the pin step imports", () => {
    const imports = [
      ...readFileSync(script, "utf8").matchAll(/from "\.\/([^"]+)"/g),
    ].map((match) => `scripts/${match[1]}`);
    for (const path of ["scripts/check-playwright-browser.mjs", ...imports]) {
      expect(dockerfile, path).toMatch(
        new RegExp(`^COPY .*\\b${path.replace(/[.]/g, "\\.")}\\b`, "m"),
      );
    }
  });

  it("installs the browser from the version the pin step derives", () => {
    expect(dockerfile).toContain(
      "check-playwright-browser.mjs --pinned-version",
    );
    expect(dockerfile).toMatch(
      /npx --yes "playwright-core@\$\(cat [^)]+\)" install --with-deps chromium/,
    );
    expect(dockerfile).not.toMatch(/playwright(-core)?@\d/);
  });
});
