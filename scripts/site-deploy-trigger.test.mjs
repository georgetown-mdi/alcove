import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import siteConfig, { ROOT_PAGES } from "../docs/.vitepress/config.mjs";
import { SITE_DEPLOY_WORKFLOW } from "./check-deploy-trigger-graph.mjs";
import { workflowDocument } from "./lib/workflows.mjs";

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

  it("deploys only from a push or dispatch on main or staging", () => {
    expect(workflow.jobs.deploy.if).toBe(
      "github.event_name != 'pull_request' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/staging')",
    );
  });
});

// The @docsearch entries in check-locked-dep-ranges.mjs stand because the
// Algolia search provider, the only code that loads @docsearch, is not built.
describe("the project site's search", () => {
  it("is VitePress's local search", () => {
    expect(siteConfig.themeConfig.search.provider).toBe("local");
  });
});
