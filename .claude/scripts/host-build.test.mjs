import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createGitFixtures } from "./lib/gitFixture.mjs";

// host-build.sh runs on a host with Docker and the network; neither is here.
// Git is real: the source repository is a fixture, and the script clones it.
// npm and docker are stubs on PATH that log each call, so a case asserts what
// the script would have run, in what order and from which directory. Any real
// docker on PATH is filtered out, so the Docker-absent cases hold anywhere.

const SCRIPT = fileURLToPath(new URL("./host-build.sh", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url));

const fixtures = createGitFixtures();
afterEach(() => fixtures.cleanup());

const PATH_WITHOUT_DOCKER = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((dir) => dir !== "" && !existsSync(join(dir, "docker")))
  .join(delimiter);

const HOST_PLATFORM = {
  arm64: "linux/arm64",
  aarch64: "linux/arm64",
  x86_64: "linux/amd64",
  amd64: "linux/amd64",
}[execFileSync("uname", ["-m"], { encoding: "utf8" }).trim()];

function stubBin({ docker = "ok" } = {}) {
  const bin = fixtures.makeTempDir("host-build-bin-");
  const log = join(bin, "calls.log");
  const stub = (name, body) =>
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("npm", `echo "npm $* @ $(pwd)" >> "${log}"`);
  if (docker !== "absent") {
    const infoExit = docker === "down" ? 1 : 0;
    stub(
      "docker",
      `if [ "$1" = info ]; then exit ${infoExit}; fi\necho "docker $* @ $(pwd)" >> "${log}"`,
    );
  }
  const calls = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { bin, calls };
}

function sourceRepo({ engines = ">=1" } = {}) {
  const repo = fixtures.makeFixture("host-build-src-");
  repo.write(
    "package.json",
    JSON.stringify({ name: "fixture", engines: { node: engines } }),
  );
  repo.write("Dockerfile", "FROM scratch\n");
  repo.write("Dockerfile.fips", "FROM scratch\n");
  const first = repo.commit("first");
  repo.git(["branch", "staging"]);
  repo.write("feature.txt", "feature\n");
  const feature = repo.commit("feature");
  return { dir: repo.dir, first, feature };
}

function run(args, { bin, env = {}, cwd } = {}) {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    cwd,
    env: {
      ...process.env,
      DOCKER_DEFAULT_PLATFORM: "",
      ...env,
      PATH: bin
        ? `${bin}${delimiter}${PATH_WITHOUT_DOCKER}`
        : PATH_WITHOUT_DOCKER,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderrLines: result.stderr.split("\n").filter((line) => line !== ""),
  };
}

const newDir = () => join(fixtures.makeTempDir("host-build-out-"), "alcove");

describe("host-build.sh arguments", () => {
  it("prints its usage on --help", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Usage: bash .claude/scripts/host-build.sh",
    );
  });

  it.each([
    [["--bogus"], "unknown argument '--bogus'."],
    [["--ref"], "--ref needs a value."],
    [["--dir"], "--dir needs a value."],
    [["--ref", "--dir"], "--ref takes a branch, tag or commit sha"],
    [["--image", "alcove:probe"], "--image takes FILE=TAG"],
    [["--image", "Dockerfile="], "--image takes FILE=TAG"],
    [["--platform", "arm64"], "--platform takes linux/ARCH"],
    [["--skip-npm"], "--skip-npm with no --image leaves nothing to build."],
    [
      ["--platform", "linux/arm64"],
      "--platform with no --image leaves nothing to build.",
    ],
  ])("refuses %j in one line with exit 2", (args, message) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stderrLines).toHaveLength(1);
    expect(result.stderrLines[0]).toContain(message);
    expect(result.stderrLines[0]).toMatch(/Run with --help for usage\.$/);
  });

  it("refuses a --dir that already holds files, before fetching", () => {
    const { bin, calls } = stubBin();
    const dir = fixtures.makeTempDir("host-build-full-");
    writeFileSync(join(dir, "keep.txt"), "keep\n");
    const result = run(["--from", sourceRepo().dir, "--dir", dir], { bin });
    expect(result.status).toBe(1);
    expect(result.stderrLines).toEqual([
      `host-build: ${dir} already exists and is not empty; pass a new --dir.`,
    ]);
    expect(readdirSync(dir)).toEqual(["keep.txt"]);
    expect(calls()).toEqual([]);
  });
});

describe("host-build.sh without Docker", () => {
  it("fails in one line, before cloning, when --image is asked for and docker is not on PATH", () => {
    const { bin, calls } = stubBin({ docker: "absent" });
    const dir = newDir();
    const result = run(
      ["--from", sourceRepo().dir, "--dir", dir, "--image", "Dockerfile=t:1"],
      { bin },
    );
    expect(result.status).toBe(1);
    expect(result.stderrLines).toEqual([
      "host-build: docker is not on PATH; --image needs a host with Docker (drop --image to build the npm workspaces only).",
    ]);
    expect(existsSync(dir)).toBe(false);
    expect(calls()).toEqual([]);
  });

  it("fails in one line when the Docker daemon does not answer", () => {
    const { bin } = stubBin({ docker: "down" });
    const dir = newDir();
    const result = run(
      ["--from", sourceRepo().dir, "--dir", dir, "--image", "Dockerfile=t:1"],
      { bin },
    );
    expect(result.status).toBe(1);
    expect(result.stderrLines).toEqual([
      "host-build: the Docker daemon is not answering (docker info failed); start Docker and rerun.",
    ]);
    expect(existsSync(dir)).toBe(false);
  });

  it("builds the npm workspaces with no docker on PATH when no image is asked for", () => {
    const { bin, calls } = stubBin({ docker: "absent" });
    const source = sourceRepo();
    const dir = newDir();
    const result = run(["--from", source.dir, "--dir", dir], { bin });
    expect(result.stderrLines).toEqual([]);
    expect(result.status).toBe(0);
    expect(calls()).toEqual([
      `npm ci --no-audit --no-fund @ ${dir}`,
      `npm run build -w packages/core @ ${dir}`,
      `npm run build -w packages/cli-contract @ ${dir}`,
      `npm run build -w apps/cli @ ${dir}`,
    ]);
    expect(result.stdout.trim().split("\n").at(-1)).toBe(
      `host-build: done: commit ${source.first} built in ${dir}`,
    );
  });
});

describe("host-build.sh clone and build", () => {
  it("clones a branch, a commit sha, and defaults --dir to a new directory", () => {
    const { bin } = stubBin();
    const source = sourceRepo();

    const byBranch = run(
      ["--from", source.dir, "--ref", "main", "--dir", newDir()],
      {
        bin,
      },
    );
    expect(byBranch.status).toBe(0);
    expect(byBranch.stdout).toContain(`host-build: commit ${source.feature}`);

    const bySha = run(
      ["--from", source.dir, "--ref", source.first, "--dir", newDir()],
      {
        bin,
      },
    );
    expect(bySha.status).toBe(0);
    expect(bySha.stdout).toContain(`host-build: commit ${source.first}`);

    const defaulted = run(["--from", source.dir], { bin });
    expect(defaulted.status).toBe(0);
    const dir = /built in (\S+)$/.exec(defaulted.stdout.trim())[1];
    try {
      expect(readFileSync(join(dir, "package.json"), "utf8")).toContain(
        "fixture",
      );
    } finally {
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  });

  it("resolves a relative --dir and --from against the caller's directory", () => {
    const { bin, calls } = stubBin();
    const source = sourceRepo();
    const out = realpathSync(fixtures.makeTempDir("host-build-rel-"));
    const result = run(
      ["--from", relative(out, source.dir), "--dir", "alcove"],
      { bin, cwd: out },
    );
    expect(result.stderrLines).toEqual([]);
    expect(result.status).toBe(0);
    const dir = join(out, "alcove");
    expect(calls()[0]).toBe(`npm ci --no-audit --no-fund @ ${dir}`);
    expect(result.stdout.trim().split("\n").at(-1)).toBe(
      `host-build: done: commit ${source.first} built in ${dir}`,
    );
  });

  it("resolves a relative --dir that already exists and is empty", () => {
    const { bin, calls } = stubBin();
    const out = realpathSync(fixtures.makeTempDir("host-build-rel-"));
    const result = run(["--from", sourceRepo().dir, "--dir", "."], {
      bin,
      cwd: out,
    });
    expect(result.status).toBe(0);
    expect(calls()[0]).toBe(`npm ci --no-audit --no-fund @ ${out}`);
  });

  it("names the remedy when the ref cannot be fetched", () => {
    const { bin } = stubBin();
    const result = run(
      ["--from", sourceRepo().dir, "--ref", "never-pushed", "--dir", newDir()],
      { bin },
    );
    expect(result.status).toBe(1);
    expect(result.stderrLines.at(-1)).toContain(
      "needs --from <host checkout path>.",
    );
  });

  it("refuses a node older than the commit's engines floor", () => {
    const { bin, calls } = stubBin();
    const result = run(
      ["--from", sourceRepo({ engines: ">=999" }).dir, "--dir", newDir()],
      {
        bin,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderrLines).toEqual([
      `host-build: node ${process.version} is older than the Node 999 this commit's package.json requires; install Node 999 or later and rerun.`,
    ]);
    expect(calls()).toEqual([]);
  });

  it("builds each image with an explicit platform after the workspaces", () => {
    const { bin, calls } = stubBin();
    const dir = newDir();
    const result = run(
      [
        "--from",
        sourceRepo().dir,
        "--dir",
        dir,
        "--image",
        "Dockerfile.fips=alcove:fips-probe",
        "--image",
        "Dockerfile=alcove:probe",
      ],
      { bin, env: { DOCKER_DEFAULT_PLATFORM: "linux/riscv64" } },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `host-build: DOCKER_DEFAULT_PLATFORM=linux/riscv64 is set in this shell; images build for ${HOST_PLATFORM}.`,
    );
    expect(calls().slice(4)).toEqual([
      `docker buildx build -f Dockerfile.fips --platform ${HOST_PLATFORM} --progress=plain -t alcove:fips-probe --load . @ ${dir}`,
      `docker buildx build -f Dockerfile --platform ${HOST_PLATFORM} --progress=plain -t alcove:probe --load . @ ${dir}`,
    ]);
  });

  it("builds only the images under --skip-npm, on the --platform given", () => {
    const { bin, calls } = stubBin();
    const dir = newDir();
    const result = run(
      [
        "--from",
        sourceRepo().dir,
        "--dir",
        dir,
        "--skip-npm",
        "--platform",
        "linux/amd64",
        "--image",
        "Dockerfile=alcove:probe",
      ],
      { bin },
    );
    expect(result.status).toBe(0);
    expect(calls()).toEqual([
      `docker buildx build -f Dockerfile --platform linux/amd64 --progress=plain -t alcove:probe --load . @ ${dir}`,
    ]);
  });

  it("fails when the commit has no such Dockerfile", () => {
    const { bin } = stubBin();
    const result = run(
      [
        "--from",
        sourceRepo().dir,
        "--dir",
        newDir(),
        "--skip-npm",
        "--image",
        "Dockerfile.nope=t:1",
      ],
      { bin },
    );
    expect(result.status).toBe(1);
    expect(result.stderrLines.at(-1)).toMatch(
      /^host-build: commit [0-9a-f]{40} has no Dockerfile\.nope\.$/,
    );
  });
});

describe("host-build.sh workspace order", () => {
  // The CLI fails at startup on a workspace dependency that was never built,
  // so every @alcove/* package apps/cli depends on at runtime, and each of
  // theirs, must be built before the package that needs it.
  const script = readFileSync(SCRIPT, "utf8");
  const order = /^WORKSPACES="([^"]+)"$/m.exec(script)[1].split(" ");

  const workspaceDeps = (workspace) => {
    const manifest = JSON.parse(
      readFileSync(join(REPO, workspace, "package.json"), "utf8"),
    );
    return Object.entries(manifest.dependencies ?? {})
      .filter(
        ([name, spec]) =>
          name.startsWith("@alcove/") && spec.startsWith("file:"),
      )
      .map(([, spec]) => join(workspace, spec.slice("file:".length)));
  };

  it("ends with apps/cli and builds every workspace dependency before its dependents", () => {
    expect(order.at(-1)).toBe("apps/cli");
    for (const [index, workspace] of order.entries()) {
      for (const dependency of workspaceDeps(workspace)) {
        expect(
          order.slice(0, index),
          `${workspace} needs ${dependency}`,
        ).toContain(dependency);
      }
    }
  });
});
