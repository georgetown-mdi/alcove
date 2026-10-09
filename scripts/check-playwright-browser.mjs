#!/usr/bin/env node
// Holds the installed Chromium against the build the lockfile's playwright
// expects. The dev container bakes that build into its image, so a playwright
// bump that moves the Chromium revision leaves the container holding the old
// one until it is rebuilt; post-create.sh runs this to say so in one line rather
// than leave the browser suite to fail on a download the egress firewall refuses.
//
//   node scripts/check-playwright-browser.mjs
//   node scripts/check-playwright-browser.mjs --pinned-version <package-lock.json>
//
// The installed playwright decides what it expects: `playwright install
// --dry-run chromium` names each build's install location, and every one must
// exist; a headless launch, what the browser suite does, must then succeed.
// The second form prints the playwright-core version the lockfile installs,
// which the dev-container Dockerfile installs the browser from.
//
// Exit 0 when the expected build is installed and starts, 1 when it is missing
// or will not start, 2 when it could not be verified either way.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { installedAs, packageIdentity } from "./lib/lockfile.mjs";

const NAME = "check-playwright-browser";
const WEB_WORKSPACE = "apps/web";

/**
 * The one playwright-core version a lockfile installs. Throws when it installs
 * none, or more than one, since the image can bake only one browser build.
 */
export function pinnedPlaywrightVersion(lockfileText) {
  const { packages = {} } = JSON.parse(lockfileText);
  const versions = new Set();
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.includes("node_modules/")) continue;
    if (packageIdentity(installedAs(path), entry) !== "playwright-core")
      continue;
    versions.add(entry.version);
  }
  if (versions.size !== 1) {
    throw new Error(
      versions.size === 0
        ? "the lockfile installs no playwright-core"
        : `the lockfile installs more than one playwright-core: ${[...versions].sort().join(", ")}`,
    );
  }
  return [...versions][0];
}

/**
 * The builds `playwright install --dry-run` lists: each title line, then its
 * `Install location:` line.
 */
export function expectedBuilds(dryRunOutput) {
  const builds = [];
  let title = null;
  for (const line of dryRunOutput.split("\n")) {
    const location = /^\s+Install location:\s+(\S.*)$/.exec(line);
    if (location && title !== null) {
      builds.push({ title, location: location[1].trim() });
      title = null;
    } else if (/^\S/.test(line)) {
      title = line.trim();
    }
  }
  return builds;
}

/**
 * The directories beside `location` that hold another revision of the same
 * build, e.g. `chromium-1247` beside a missing `chromium-1248`.
 */
export function otherRevisions(location, listDirectory = readdirSync) {
  const prefix = basename(location).replace(/-[^-]*$/, "-");
  try {
    return listDirectory(dirname(location))
      .filter((name) => name.startsWith(prefix) && name !== basename(location))
      .sort();
  } catch {
    return [];
  }
}

/** What to do about a missing or broken build, for where the check runs. */
export function remedy(inDevContainer) {
  return inDevContainer
    ? "Rebuild the dev container (Dev Containers: Rebuild Container) to install it."
    : "Run `npx playwright install chromium` in apps/web to install it.";
}

/**
 * The one line naming the missing builds, or null when none is missing.
 */
export function missingBuildLine({
  version,
  builds,
  inDevContainer,
  exists = existsSync,
  listDirectory = readdirSync,
}) {
  const missing = builds.filter((build) => !exists(build.location));
  if (missing.length === 0) return null;
  const named = missing.map((build) => {
    const others = otherRevisions(build.location, listDirectory);
    const found = others.length === 0 ? "none" : others.join(", ");
    return `${build.title} at ${build.location} (installed: ${found})`;
  });
  return `${NAME}: playwright ${version} expects ${named.join("; ")}, which this machine does not have. ${remedy(inDevContainer)}`;
}

/**
 * Starts and closes headless Chromium through `chromium`, the installed
 * playwright's launcher. Resolves to null on success, else the first line of
 * the launch error.
 */
export async function launchFailure(chromium) {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return null;
  } catch (error) {
    return String(error?.message ?? error).split("\n")[0];
  }
}

/**
 * Runs the check against the playwright installed for the web workspace under
 * `root`. Returns the exit code and the line to print.
 */
export async function checkInstalledBrowser({
  root,
  env = process.env,
  exists = existsSync,
  listDirectory = readdirSync,
  launch = launchFailure,
}) {
  const inDevContainer = env.DEVCONTAINER === "true";
  let version;
  let cli;
  let chromium;
  try {
    const requireFromWeb = createRequire(
      join(root, WEB_WORKSPACE, "package.json"),
    );
    const manifestPath = requireFromWeb.resolve("playwright/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    version = manifest.version;
    cli = join(dirname(manifestPath), manifest.bin.playwright);
    chromium = requireFromWeb("playwright").chromium;
  } catch (error) {
    return {
      code: 2,
      line: `${NAME}: could not load playwright from ${WEB_WORKSPACE} (${error.message}). Run \`npm ci\`, then run this again.`,
    };
  }

  let builds;
  try {
    builds = expectedBuilds(
      execFileSync(
        process.execPath,
        [cli, "install", "--dry-run", "chromium"],
        {
          cwd: join(root, WEB_WORKSPACE),
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
  } catch (error) {
    return {
      code: 2,
      line: `${NAME}: \`playwright install --dry-run chromium\` failed: ${String(error.message).split("\n")[0]}`,
    };
  }
  if (builds.length === 0) {
    return {
      code: 2,
      line: `${NAME}: \`playwright install --dry-run chromium\` named no install location, so the installed build cannot be checked.`,
    };
  }

  const missing = missingBuildLine({
    version,
    builds,
    inDevContainer,
    exists,
    listDirectory,
  });
  if (missing !== null) return { code: 1, line: missing };

  const failure = await launch(chromium);
  if (failure !== null) {
    return {
      code: 1,
      line: `${NAME}: Chromium for playwright ${version} is installed but did not start: ${failure} ${remedy(inDevContainer)}`,
    };
  }
  return {
    code: 0,
    line: `${NAME}: the Chromium build playwright ${version} expects is installed at ${dirname(builds[0].location)} and starts.`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--pinned-version") {
    if (args[1] === undefined) {
      console.error(`${NAME}: --pinned-version needs the lockfile's path.`);
      process.exit(2);
    }
    try {
      console.log(pinnedPlaywrightVersion(readFileSync(args[1], "utf8")));
    } catch (error) {
      console.error(`${NAME}: ${error.message}`);
      process.exit(2);
    }
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const { code, line } = await checkInstalledBrowser({ root });
    (code === 0 ? console.log : console.error)(line);
    process.exit(code);
  }
}
