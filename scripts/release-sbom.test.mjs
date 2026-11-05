import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs the shell block of release step 9 in docs/RELEASES.md, verbatim, in a
// fixture workspace laid out like this one, whose CLI depends on a packed
// package that declares its licence only in the older `licenses` array, as
// `ssh2` does. npm reads that array from an installed package.json, while the
// lockfile records only a `license` string, so the BOM lists the licence only
// when the step generates it from the tree `npm ci` installed.

const here = dirname(fileURLToPath(import.meta.url));
const STEP_HEADING = "### 9. Generate and attach the SBOM";
const LEGACY_NAME = "legacy-licence-fixture";

/** The commands of the first `sh` block under the step 9 heading. */
function stepCommands() {
  const text = readFileSync(resolve(here, "../docs/RELEASES.md"), "utf8");
  const start = text.indexOf(`\n${STEP_HEADING}\n`);
  if (start === -1)
    throw new Error(`docs/RELEASES.md has no "${STEP_HEADING}" heading`);
  const block = /```sh\n([\s\S]*?)```/.exec(text.slice(start));
  if (!block) throw new Error(`no sh block under "${STEP_HEADING}"`);
  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

let root;
let env;

const put = (path, value) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(
    join(root, path),
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
};

const npm = (args, cwd = root) => {
  const run = spawnSync("npm", args, { cwd, env, encoding: "utf8" });
  if (run.status !== 0) {
    throw new Error(
      `npm ${args.join(" ")} exited ${run.status}:\n${run.stderr}`,
    );
  }
  return run.stdout;
};

/** Run one step command, which may redirect its stdout to a file with `>`. */
const runStepCommand = (line) => {
  if (/[|&;<`$()]/.test(line))
    throw new Error(
      `step command uses shell syntax this test does not run: ${line}`,
    );
  const [command, outFile] = line.split(/\s+>\s+/);
  const [program, ...args] = command.split(/\s+/);
  if (program !== "npm")
    throw new Error(`step command does not run npm: ${line}`);
  const stdout = npm(args);
  if (outFile) writeFileSync(join(root, outFile), stdout);
  return outFile;
};

const legacyComponent = (bom) =>
  bom.components.find((component) => component.name === LEGACY_NAME);

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "release-sbom-")));
  env = {
    ...process.env,
    npm_config_cache: join(root, ".npm-cache"),
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  put(`${LEGACY_NAME}/package.json`, {
    name: LEGACY_NAME,
    version: "1.0.0",
    licenses: [{ type: "MIT", url: "https://example.invalid/LICENSE" }],
  });
  put(`${LEGACY_NAME}/index.js`, "module.exports = 1;\n");
  const tarball = npm(
    ["pack", "--pack-destination", root],
    join(root, LEGACY_NAME),
  ).trim();
  put("package.json", {
    name: "fixture-root",
    version: "0.0.0",
    private: true,
    workspaces: ["packages/core", "apps/cli", "apps/web"],
  });
  put("packages/core/package.json", {
    name: "fixture-core",
    version: "0.0.0",
    license: "Apache-2.0",
  });
  put("apps/web/package.json", {
    name: "fixture-web",
    version: "0.0.0",
    license: "Apache-2.0",
  });
  put("apps/cli/package.json", {
    name: "fixture-cli",
    version: "0.0.0",
    license: "Apache-2.0",
    dependencies: { [LEGACY_NAME]: `file:../../${tarball}` },
  });
  npm(["install", "--package-lock-only"]);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("release step 9 SBOM", () => {
  it("lists the licence of a package that declares it only in the legacy licenses array", () => {
    let bomFile;
    for (const line of stepCommands())
      bomFile = runStepCommand(line) ?? bomFile;
    expect(bomFile, "step 9 writes no BOM file").toBeTruthy();
    const component = legacyComponent(
      JSON.parse(readFileSync(join(root, bomFile), "utf8")),
    );
    expect(component, `${LEGACY_NAME} is missing from the BOM`).toBeDefined();
    expect(component.licenses).toEqual([{ license: { id: "MIT" } }]);
  }, 120_000);

  it("finds no licence for that package in the lockfile alone", () => {
    const bom = JSON.parse(
      npm([
        "sbom",
        "--sbom-format",
        "cyclonedx",
        "--package-lock-only",
        "--omit=dev",
        "-w",
        "apps/cli",
      ]),
    );
    expect(
      legacyComponent(bom).licenses,
      "npm sbom --package-lock-only now lists a legacy-array licence; the reason docs/RELEASES.md step 9 gives for installing first no longer holds",
    ).toBeUndefined();
  }, 60_000);
});
