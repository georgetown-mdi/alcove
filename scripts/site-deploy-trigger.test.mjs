import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import siteConfig, { ROOT_PAGES } from "../docs/.vitepress/config.mjs";
import {
  DEPLOY_ACTION,
  SITE_DEPLOY_WORKFLOW,
  SITE_PUBLISH_WORKFLOW,
} from "./check-deploy-trigger-graph.mjs";
import { readWorkflows, workflowDocument } from "./lib/workflows.mjs";

// site_deploy.yaml rebuilds the project site on a change to a path its filters
// list. A source the site build reads that no filter lists leaves the site
// serving the previous build after an edit to it, with nothing red, so each
// one the configuration names is held to the filters here.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = "docs/.vitepress/config.mjs";
const SITE_OUTPUT = "docs/.vitepress/dist";

const workflow = workflowDocument(repoRoot, SITE_DEPLOY_WORKFLOW);
const pushPaths = workflow.on.push.paths;

/** The repository files the site configuration imports by relative path. */
function configImports() {
  const source = readFileSync(resolve(repoRoot, CONFIG), "utf8");
  return [...source.matchAll(/^import [^;]*? from "(\.{1,2}\/[^"]+)";$/gm)].map(
    ([, specifier]) => posix.join(posix.dirname(CONFIG), specifier),
  );
}

describe("the project site's path filters", () => {
  it("are the same for a pull request and a push", () => {
    expect(workflow.on.pull_request.paths).toEqual(pushPaths);
  });

  it("list docs/, every published root page and the workflow itself", () => {
    for (const path of ["docs/**", ...ROOT_PAGES, SITE_DEPLOY_WORKFLOW]) {
      expect(pushPaths).toContain(path);
    }
  });

  it("list every file outside docs/ the site configuration imports", () => {
    const imports = configImports();
    expect(imports.length).toBeGreaterThan(0);
    for (const path of imports.filter((p) => !p.startsWith("docs/"))) {
      expect(pushPaths).toContain(path);
    }
  });
});

describe("the project site's deploy", () => {
  it("uploads the site the build job built", () => {
    const build = workflow.jobs.build;
    expect(build.steps.some((step) => step.run === "npm run site:build")).toBe(
      true,
    );
    const upload = build.steps.find((step) =>
      (step.uses ?? "").startsWith("actions/upload-artifact@"),
    );
    expect(upload.with.path).toBe(SITE_OUTPUT);

    const deploy = workflow.jobs.deploy;
    expect([deploy.needs].flat()).toContain("build");
    const download = deploy.steps.find((step) =>
      (step.uses ?? "").startsWith("actions/download-artifact@"),
    );
    expect(download.with.name).toBe("${{ needs.build.outputs.artifactName }}");
  });

  it("deploys only the staging preview, from a push or dispatch on staging", () => {
    expect(workflow.on.push.branches).toEqual(["staging"]);
    const deploy = workflow.jobs.deploy;
    expect(deploy.if).toBe(
      "github.event_name != 'pull_request' && github.ref == 'refs/heads/staging'",
    );
    expect(deploy.environment).toBe("Staging");
    expect(wranglerCommand(deploy)).toMatch(/ --branch=staging /);
  });
});

/** The command of a job's one wrangler-action step. */
function wranglerCommand(job) {
  const uploads = job.steps.filter((step) =>
    (step.uses ?? "").startsWith(DEPLOY_ACTION),
  );
  expect(uploads).toHaveLength(1);
  return uploads[0].with.command;
}

// site_publish.yaml is the one route to the site's production deployment: run
// by hand, from main's copy of the workflow, for a chosen commit on main or
// staging.
describe("the project site's publish", () => {
  const publish = workflowDocument(repoRoot, SITE_PUBLISH_WORKFLOW);
  const { build, deploy, tag } = publish.jobs;
  const PUBLISHED_TAG = publish.env.PUBLISHED_TAG;

  it("runs only on a manual dispatch, for a ref that defaults to main", () => {
    expect(Object.keys(publish.on)).toEqual(["workflow_dispatch"]);
    expect(publish.on.workflow_dispatch.inputs).toEqual({
      ref: {
        description: expect.any(String),
        type: "string",
        required: true,
        default: "main",
      },
    });
  });

  // A skipped build would skip every job after it and finish green.
  it("fails a run from any branch but main before it checks anything out", () => {
    expect(build.if).toBeUndefined();
    const [guard] = build.steps;
    expect(guard.uses).toBeUndefined();
    expect(guard.run).toContain(
      'if [[ "${GITHUB_REF}" != "refs/heads/main" ]]; then',
    );
    expect(guard.run).toMatch(/::error::.*Run it again from main/);
    expect(guard.run).toMatch(/\n\s*exit 1\n/);
    for (const [id, job] of Object.entries(publish.jobs)) {
      if (id === "build") continue;
      expect([job.needs].flat(), id).toContain("build");
    }
    expect([tag.needs].flat()).toContain("deploy");
  });

  // Production's branch rule tests the workflow's ref, not the ref input.
  it("refuses a commit on neither main nor staging before it builds", () => {
    const stepIndex = (predicate) => {
      const index = build.steps.findIndex(predicate);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const checkoutIndex = stepIndex((step) =>
      (step.uses ?? "").startsWith("actions/checkout@"),
    );
    expect(build.steps[checkoutIndex].with["fetch-depth"]).toBe(0);
    const ancestryIndex = stepIndex((step) =>
      (step.run ?? "").includes("git merge-base --is-ancestor"),
    );
    const ancestry = build.steps[ancestryIndex];
    expect(ancestry.env.COMMIT).toBe("${{ steps.commit.outputs.commit }}");
    for (const branch of ["main", "staging"]) {
      expect(ancestry.run).toContain(
        `! git merge-base --is-ancestor "\${COMMIT}" refs/remotes/origin/${branch}`,
      );
    }
    expect(ancestry.run).toMatch(
      /::error::.*publish a commit on main or staging/,
    );
    expect(ancestry.run).toMatch(/\n\s*exit 1\n/);

    expect(checkoutIndex).toBeLessThan(ancestryIndex);
    expect(ancestryIndex).toBeLessThan(
      stepIndex((step) => (step.uses ?? "").startsWith("./.github/actions/")),
    );
    expect(ancestryIndex).toBeLessThan(
      stepIndex((step) => step.run === "npm run site:build"),
    );
  });

  it("never cancels a publish in progress", () => {
    expect(publish.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("builds the chosen ref and deploys it as the production deployment", () => {
    const checkout = build.steps.find((step) =>
      (step.uses ?? "").startsWith("actions/checkout@"),
    );
    expect(checkout.with.ref).toBe("${{ inputs.ref }}");
    expect(build.steps.some((step) => step.run === "npm run site:build")).toBe(
      true,
    );
    const upload = build.steps.find((step) =>
      (step.uses ?? "").startsWith("actions/upload-artifact@"),
    );
    expect(upload.with.path).toBe(SITE_OUTPUT);

    expect(deploy.environment).toBe("Production");
    const download = deploy.steps.find((step) =>
      (step.uses ?? "").startsWith("actions/download-artifact@"),
    );
    expect(download.with.name).toBe("${{ needs.build.outputs.artifactName }}");
    const command = wranglerCommand(deploy);
    expect(command).toMatch(
      / --project-name=\$\{\{ vars\.CLOUDFLARE_SITE_PAGES_PROJECT \}\} /,
    );
    expect(command).toMatch(
      / --branch=main --commit-hash=\$\{\{ needs\.build\.outputs\.commit \}\}$/,
    );
  });

  it("gives write access to the tag job alone, and that job runs no repository code", () => {
    expect(publish.permissions).toEqual({ contents: "read" });
    for (const [id, job] of Object.entries(publish.jobs)) {
      if (id === "tag") continue;
      for (const level of Object.values(job.permissions ?? {})) {
        expect(level, id).not.toBe("write");
      }
    }
    expect(tag.permissions).toEqual({ contents: "write" });
    expect(tag.environment).toBeUndefined();
    expect(tag.steps.every((step) => step.uses === undefined)).toBe(true);
    expect(tag.steps.map((step) => step.env.COMMIT)).toEqual([
      "${{ needs.build.outputs.commit }}",
    ]);
  });

  it("moves a tag outside the release tag shape", () => {
    expect(PUBLISHED_TAG).toMatch(/^[a-z][a-z-]*$/);
    expect(PUBLISHED_TAG).not.toMatch(/^v\d/);
  });

  // The summary and the review command docs/RELEASES.md gives compare the
  // same paths: docs/, site/ and every root page the site publishes.
  describe("the review compare", () => {
    const compare = build.steps.find((step) => step.env?.REVIEW_PATHS);
    const reviewPaths = compare.env.REVIEW_PATHS.split(" ");

    it("covers docs/, site/ and every published root page", () => {
      expect(reviewPaths).toEqual(["docs", "site", ...ROOT_PAGES]);
    });

    it("is the command docs/RELEASES.md gives", () => {
      const releases = readFileSync(
        resolve(repoRoot, "docs/RELEASES.md"),
        "utf8",
      );
      expect(releases).toContain(
        `git diff ${PUBLISHED_TAG} origin/main -- ${reviewPaths.join(" ")}`,
      );
    });
  });
});

// The staging preview and the publish are the only uploads to the site's
// project, so a push to main deploys no production build of it.
describe("the project site's Pages project", () => {
  it("is uploaded to by the preview and the publish alone", () => {
    const uploaders = readWorkflows(repoRoot)
      .filter(({ source }) => source.includes("CLOUDFLARE_SITE_PAGES_PROJECT"))
      .map(({ path }) => path)
      .sort();
    expect(uploaders).toEqual([SITE_DEPLOY_WORKFLOW, SITE_PUBLISH_WORKFLOW]);
  });
});

// The @docsearch entries in check-locked-dep-ranges.mjs stand because the
// Algolia search provider, the only code that loads @docsearch, is not built.
describe("the project site's search", () => {
  it("is VitePress's local search", () => {
    expect(siteConfig.themeConfig.search.provider).toBe("local");
  });
});
