import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MANIFEST_FORMAT,
  buildManifest,
  compareServed,
  compareTree,
  isSafeRelativePath,
  listTree,
  parseManifest,
  serializeManifest,
  siteBaseUrl,
  siteFiles,
} from "./hosted-site-manifest.mjs";
import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = join(here, "hosted-site-manifest.mjs");

const VERSION = "1.2.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

// The shapes a deployed build holds: root documents, a nested asset, a hidden
// directory, Pages' configuration file, and a nested document.
const SITE_FILES = {
  "index.html": "<!doctype html><title>Alcove</title>",
  _headers: "/*\n  X-Frame-Options: DENY\n",
  "assets/index-abc.js": "console.log(1);",
  ".well-known/security.txt": "Contact: mailto:security@example.org\n",
  "saved/_.html": "<!doctype html><title>Saved</title>",
  "robots.txt": "",
};

let scratch;

const writeTree = (root, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

const freshTree = (name, files = SITE_FILES) =>
  writeTree(join(scratch, name), files);

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "hosted-site-manifest-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the manifest of a built tree", () => {
  it("lists every file the tree holds, hidden and configuration files included", () => {
    const dir = freshTree("every-file");
    const manifest = buildManifest({
      version: VERSION,
      commit: COMMIT,
      sites: { site: dir },
    });
    const listed = siteFiles(manifest, "site").map(({ path }) => path);
    expect(new Set(listed)).toEqual(new Set(Object.keys(SITE_FILES)));
    expect(listed).toHaveLength(Object.keys(SITE_FILES).length);
    expect(compareTree(siteFiles(manifest, "site"), dir)).toEqual({
      missing: [],
      unlisted: [],
      changed: [],
    });
  });

  it("names the release version and commit", () => {
    const manifest = buildManifest({
      version: VERSION,
      commit: COMMIT,
      sites: { site: freshTree("names") },
    });
    expect(manifest).toMatchObject({
      format: MANIFEST_FORMAT,
      format_version: 1,
      version: VERSION,
      commit: COMMIT,
    });
  });

  it("records each file's size and SHA-256", () => {
    const manifest = buildManifest({
      version: VERSION,
      commit: COMMIT,
      sites: { site: freshTree("digests") },
    });
    const robots = siteFiles(manifest, "site").find(
      ({ path }) => path === "robots.txt",
    );
    expect(robots).toEqual({
      path: "robots.txt",
      size: 0,
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
  });

  it("lists paths in code-unit order and serializes byte for byte the same twice", () => {
    const dir = freshTree("order");
    const build = () =>
      serializeManifest(
        buildManifest({
          version: VERSION,
          commit: COMMIT,
          sites: { site: dir },
        }),
      );
    const paths = siteFiles(parseManifest(build()), "site").map(
      ({ path }) => path,
    );
    expect(paths).toEqual([...paths].sort());
    expect(build()).toBe(build());
  });

  it("holds several sites, each listed on its own", () => {
    const manifest = buildManifest({
      version: VERSION,
      commit: COMMIT,
      sites: {
        site: freshTree("two-site"),
        demo: freshTree("two-demo", { "index.html": "demo" }),
      },
    });
    expect(Object.keys(manifest.sites)).toEqual(["demo", "site"]);
    expect(siteFiles(manifest, "demo")).toHaveLength(1);
  });

  it("refuses a malformed version or commit, an empty tree and a symbolic link", () => {
    const dir = freshTree("refusals");
    expect(() =>
      buildManifest({
        version: "v1.2.3",
        commit: COMMIT,
        sites: { site: dir },
      }),
    ).toThrow(/not X\.Y\.Z/);
    expect(() =>
      buildManifest({ version: VERSION, commit: "abc", sites: { site: dir } }),
    ).toThrow(/full commit id/);
    const empty = join(scratch, "empty");
    mkdirSync(empty);
    expect(() =>
      buildManifest({
        version: VERSION,
        commit: COMMIT,
        sites: { site: empty },
      }),
    ).toThrow(/holds no files/);
    const linked = freshTree("linked");
    symlinkSync(join(linked, "index.html"), join(linked, "link.html"));
    expect(() => listTree(linked)).toThrow(/neither a file nor a directory/);
  });
});

describe("comparing a tree against a manifest", () => {
  const manifestOf = (dir) =>
    siteFiles(
      buildManifest({ version: VERSION, commit: COMMIT, sites: { site: dir } }),
      "site",
    );

  it("reports a changed, a missing and an unlisted file", () => {
    const dir = freshTree("compare");
    const files = manifestOf(dir);
    writeFileSync(join(dir, "assets/index-abc.js"), "console.log(2);");
    rmSync(join(dir, "robots.txt"));
    writeFileSync(join(dir, "extra.js"), "injected");
    expect(compareTree(files, dir)).toEqual({
      missing: ["robots.txt"],
      unlisted: ["extra.js"],
      changed: ["assets/index-abc.js"],
    });
  });
});

describe("reading a manifest", () => {
  const good = () =>
    JSON.parse(
      serializeManifest(
        buildManifest({
          version: VERSION,
          commit: COMMIT,
          sites: { site: freshTree(`read-${Math.random()}`) },
        }),
      ),
    );

  it("reads back what it wrote", () => {
    const manifest = good();
    expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
  });

  it("refuses a path that leaves the tree or the site", () => {
    for (const path of ["../x", "/x", "a//b", "a/./b", "a\\b", "a\nb", ""]) {
      expect(isSafeRelativePath(path)).toBe(false);
      const manifest = good();
      manifest.sites.site.files[0].path = path;
      expect(() => parseManifest(JSON.stringify(manifest))).toThrow(
        /unsafe path/,
      );
    }
  });

  it("refuses an unknown field, a duplicate path and another format", () => {
    const extra = good();
    extra.signed = true;
    expect(() => parseManifest(JSON.stringify(extra))).toThrow(
      /has the fields/,
    );
    const duplicate = good();
    duplicate.sites.site.files.push({ ...duplicate.sites.site.files[0] });
    expect(() => parseManifest(JSON.stringify(duplicate))).toThrow(/twice/);
    const other = good();
    other.format_version = 2;
    expect(() => parseManifest(JSON.stringify(other))).toThrow(
      /format_version/,
    );
  });

  it("names the sites it has when asked for another", () => {
    expect(() => siteFiles(good(), "demo")).toThrow(/has site/);
  });
});

describe("comparing a served site against a manifest", () => {
  let server;
  let origin;
  const served = new Map();

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = decodeURIComponent(
        new URL(request.url, "http://x").pathname,
      );
      if (path === "/moved.html") {
        response.writeHead(308, { location: "http://example.invalid/moved" });
        response.end();
        return;
      }
      const body = served.get(path.slice(1));
      if (body === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200);
      response.end(body);
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
  });

  const serve = (files) => {
    served.clear();
    for (const [path, text] of Object.entries(files)) served.set(path, text);
  };

  const manifestFiles = (files) =>
    siteFiles(
      buildManifest({
        version: VERSION,
        commit: COMMIT,
        sites: { site: freshTree(`served-${Math.random()}`, files) },
      }),
      "site",
    );

  it("passes a site serving every file as listed, skipping Pages' configuration", async () => {
    const files = manifestFiles(SITE_FILES);
    const { _headers, ...rest } = SITE_FILES;
    serve(rest);
    const result = await compareServed(files, `${origin}/`);
    expect(result).toEqual({
      changed: [],
      failed: [],
      skipped: ["_headers"],
      compared: Object.keys(SITE_FILES).length - 1,
    });
    expect(_headers).toBeDefined();
  });

  it("reports a file served with other bytes, a longer body and a missing file", async () => {
    const files = manifestFiles({
      "index.html": "a",
      "app.js": "b",
      "gone.js": "c",
    });
    serve({ "index.html": "A", "app.js": "bbbbbbbb" });
    const result = await compareServed(files, origin);
    expect(result.changed).toEqual(["app.js", "index.html"]);
    expect(result.failed).toEqual([{ path: "gone.js", why: "answered 404" }]);
  });

  it("does not follow a redirect off the site", async () => {
    const files = manifestFiles({ "moved.html": "x" });
    const fetchStub = async (url) => {
      const response = new Response("x", { status: 200 });
      Object.defineProperty(response, "url", {
        value: `http://example.invalid${new URL(url).pathname}`,
      });
      return response;
    };
    const result = await compareServed(files, origin, fetchStub);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].why).toMatch(/redirected off the site/);
  });

  it("refuses plain http off loopback, and a URL with a query", () => {
    expect(() => siteBaseUrl("http://psi.example.org/")).toThrow(/not https/);
    expect(() => siteBaseUrl("https://psi.example.org/?a=1")).toThrow(/query/);
    expect(siteBaseUrl("https://psi.example.org").href).toBe(
      "https://psi.example.org/",
    );
  });
});

describe("the command line", () => {
  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  it("writes a manifest, then checks the tree against it", () => {
    const site = freshTree("cli-site");
    const demo = freshTree("cli-demo", { "index.html": "demo" });
    const out = join(scratch, "cli.manifest.json");
    const write = run(
      "write",
      "--version",
      VERSION,
      "--commit",
      COMMIT,
      "--out",
      out,
      `site=${site}`,
      `demo=${demo}`,
    );
    expect(write.stderr).toBe("");
    expect(write.status).toBe(0);
    expect(parseManifest(readFileSync(out, "utf8")).version).toBe(VERSION);
    expect(run("check-tree", out, `site=${site}`).status).toBe(0);
    expect(run("check-tree", out, `demo=${demo}`).status).toBe(0);

    writeFileSync(join(site, "index.html"), "changed");
    const changed = run("check-tree", out, `site=${site}`);
    expect(changed.status).toBe(1);
    expect(changed.stdout).toContain("differs: index.html");
  });

  it("exits 2 on a usage error", () => {
    expect(run().status).toBe(2);
    expect(run("write", "--version", VERSION).status).toBe(2);
  });
});

// The release builds each site once, in the web job, and both the manifest and
// the deployment take that job's artifacts.
describe("the release workflow's one build", () => {
  const document = workflowDocument(repoRoot, `${WORKFLOW_DIR}/release.yaml`);
  const jobs = document.jobs;
  const downloads = (job) =>
    (jobs[job]?.steps ?? [])
      .filter((step) =>
        (step.uses ?? "").startsWith("actions/download-artifact@"),
      )
      .map((step) => step.with?.name);
  const ARTIFACTS = [
    "${{ needs.web.outputs.artifactName }}",
    "${{ needs.web.outputs.demoArtifactName }}",
  ];

  it("hashes the artifacts the pages job deploys", () => {
    expect(downloads("hosted-manifest")).toEqual(ARTIFACTS);
    expect(downloads("pages")).toEqual(ARTIFACTS);
    expect([jobs["hosted-manifest"].needs].flat()).toEqual(["web"]);
  });

  it("builds the web app in no job but the web job's reusable workflow", () => {
    expect(jobs.web?.uses).toBe("./.github/workflows/web_build_and_test.yaml");
    for (const [id, job] of Object.entries(jobs)) {
      for (const step of job.steps ?? []) {
        expect(step.run ?? "", `job ${id}`).not.toMatch(/-w apps\/web\b/);
      }
    }
  });

  it("writes the manifest of both downloaded sites with this script", () => {
    const write = jobs["hosted-manifest"].steps.find(
      (step) => step.id === "write",
    );
    expect(write.run).toContain("node scripts/hosted-site-manifest.mjs write");
    expect(write.run).toContain('"site=${SITE_DIR}" "demo=${DEMO_DIR}"');
    expect(write.env.SITE_DIR).toBe("${{ runner.temp }}/site");
    expect(write.env.DEMO_DIR).toBe("${{ runner.temp }}/demo-site");
    const paths = jobs["hosted-manifest"].steps
      .filter((step) =>
        (step.uses ?? "").startsWith("actions/download-artifact@"),
      )
      .map((step) => step.with?.path);
    expect(paths).toEqual([write.env.SITE_DIR, write.env.DEMO_DIR]);
  });

  it("signs, verifies and attests the file the manifest job wrote", () => {
    const sign = jobs["hosted-manifest-sign"];
    expect(sign.env.ALCOVE_MANIFEST).toBe(
      "${{ needs.hosted-manifest.outputs.file }}",
    );
    const runs = sign.steps.map((step) => step.run ?? "").join("\n");
    expect(runs).toMatch(
      /cosign sign-blob --yes \\\n\s+--bundle "\$\{ALCOVE_MANIFEST\}\.sigstore\.json" "\$\{ALCOVE_MANIFEST\}"/,
    );
    expect(runs).toMatch(/cosign verify-blob \\/);
    const attest = sign.steps.find((step) =>
      (step.uses ?? "").startsWith("actions/attest-build-provenance@"),
    );
    expect(attest.with).toEqual({
      "subject-path": "${{ env.ALCOVE_MANIFEST }}",
    });
  });
});
