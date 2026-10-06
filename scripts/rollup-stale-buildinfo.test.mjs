import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

// The core and CLI builds compile through @rollup/plugin-typescript twice: once
// for rollup.config.ts (--configPlugin) and once for the sources. Both
// workspaces' tsconfigs set `composite`, and an incremental compile under it
// emits nothing for a file a leftover dist/tsconfig.tsbuildinfo records as
// built; when the plugin's own .rollup.cache/ copy is missing (a restored dist,
// a moved checkout -- its paths are absolute), rollup parses the raw
// TypeScript. This drives the real build over a copy of each workspace that
// holds such a build-info file and no cache.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const WORKSPACES = ["packages/core", "apps/cli"];
const COPIED = [
  "package.json",
  "tsconfig.json",
  "tsconfig.rollup.json",
  "rollup.config.ts",
  "src",
];
const STEP_TIMEOUT_MS = 180_000;

// An incremental compile of rollup.config.ts through the plugin, the way a
// build before non-incremental compiles left one.
const SEED_BUILD_INFO = `
import { isAbsolute } from "node:path";
import { rollup } from "rollup";
import typescript from "@rollup/plugin-typescript";
const bundle = await rollup({
  input: "rollup.config.ts",
  external: (id) => !id.startsWith(".") && !isAbsolute(id),
  plugins: [typescript({ outputToFilesystem: true })],
  onwarn: () => {},
});
await bundle.generate({ format: "es" });
await bundle.close();
`;

const scratch = mkdtempSync(join(tmpdir(), "rollup-stale-buildinfo-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function linkNodeModules(fromDir, toDir) {
  const source = join(fromDir, "node_modules");
  if (existsSync(source)) symlinkSync(source, join(toDir, "node_modules"));
}

function copyWorkspaces() {
  cpSync(
    join(repoRoot, "tsconfig.base.json"),
    join(scratch, "tsconfig.base.json"),
  );
  linkNodeModules(repoRoot, scratch);
  for (const workspace of WORKSPACES) {
    const target = join(scratch, workspace);
    mkdirSync(target, { recursive: true });
    for (const entry of COPIED) {
      cpSync(join(repoRoot, workspace, entry), join(target, entry), {
        recursive: true,
      });
    }
    linkNodeModules(join(repoRoot, workspace), target);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ?? ""}`,
  };
}

copyWorkspaces();

describe("the rollup build with a stale tsconfig.tsbuildinfo", () => {
  for (const workspace of WORKSPACES) {
    it(
      `builds ${workspace}`,
      () => {
        const dir = join(scratch, workspace);
        const seed = run(
          process.execPath,
          ["--input-type=module", "-e", SEED_BUILD_INFO],
          dir,
        );
        expect(seed.status, seed.output).toBe(0);
        expect(existsSync(join(dir, "dist/tsconfig.tsbuildinfo"))).toBe(true);
        rmSync(join(dir, ".rollup.cache"), { recursive: true, force: true });

        const build = run("npm", ["run", "build"], dir);
        expect(build.status, build.output).toBe(0);

        const manifest = JSON.parse(
          readFileSync(join(dir, "package.json"), "utf8"),
        );
        const entry = manifest.main ?? Object.values(manifest.bin)[0];
        expect(existsSync(resolve(dir, entry))).toBe(true);
      },
      2 * STEP_TIMEOUT_MS,
    );
  }
});
