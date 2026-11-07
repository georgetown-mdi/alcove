import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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

import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

// The release's production upload goes ahead only while main's tip is the
// release commit or an ancestor of it, as GitHub's compare endpoint reports
// it. The step's own run text is run here against a stub `gh`; what only a
// real release run shows is the endpoint's answer for a real tag push.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const document = workflowDocument(repoRoot, `${WORKFLOW_DIR}/release.yaml`);
const pages = document.jobs.pages;
const steps = pages?.steps ?? [];
const COMPARE_STEP_ID = "compare-main";
const UPLOAD_CONDITION = `steps.${COMPARE_STEP_ID}.outputs.upload == 'true'`;
const DEPLOY_ACTION = "cloudflare/wrangler-action@";

const compareAt = steps.findIndex((step) => step.id === COMPARE_STEP_ID);
const compare = steps[compareAt];

describe("the release's production upload against main", () => {
  it("compares the release commit with main immediately before the upload", () => {
    expect(compareAt).toBeGreaterThanOrEqual(0);
    expect(steps[compareAt + 1]?.id).toBe("deploy");
    expect(compare.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    expect(compare.run).toContain(
      'gh api "repos/${GITHUB_REPOSITORY}/compare/${GITHUB_SHA}...main" --jq .status',
    );
    expect(pages.permissions).toEqual({ contents: "read" });
  });

  it("keys every upload step on the comparison", () => {
    const after = steps.slice(compareAt + 1);
    expect(after.map((step) => step.name)).toEqual([
      "Deploy",
      "Download the demo site",
      "Check the demo site against the package job's digest",
      "Deploy the demo site",
    ]);
    for (const step of after) {
      expect(step.if.startsWith(UPLOAD_CONDITION)).toBe(true);
    }
    const uploads = steps.filter((step) =>
      (step.uses ?? "").startsWith(DEPLOY_ACTION),
    );
    expect(uploads).toHaveLength(2);
    for (const step of uploads) {
      expect(steps.indexOf(step)).toBeGreaterThan(compareAt);
    }
  });

  it("checks the served security.txt only once the upload happened", () => {
    expect(pages.outputs.uploaded).toBe(
      `\${{ steps.${COMPARE_STEP_ID}.outputs.upload }}`,
    );
    const check = document.jobs["check-security-txt"];
    expect([check.needs].flat()).toEqual(["pages"]);
    expect(check.if).toBe("${{ needs.pages.outputs.uploaded == 'true' }}");
  });
});

describe("the comparison step's run text", () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-upload-order-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const stubDir = join(scratch, "bin");
  const stub = join(stubDir, "gh");
  mkdirSync(stubDir);
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >"$STUB_ARGS"',
      'if [ -n "$STUB_FAIL" ]; then echo "gh: HTTP 502" >&2; exit 1; fi',
      "printf '%s\\n' \"$STUB_STATUS\"",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);

  const SHA = "0123456789abcdef0123456789abcdef01234567";
  let runs = 0;
  const runStep = (stubEnv) => {
    runs += 1;
    const files = {
      output: join(scratch, `output-${runs}`),
      summary: join(scratch, `summary-${runs}`),
      args: join(scratch, `args-${runs}`),
    };
    const result = spawnSync("bash", ["-c", compare.run], {
      cwd: scratch,
      encoding: "utf8",
      env: {
        PATH: `${stubDir}:${process.env.PATH}`,
        HOME: scratch,
        GITHUB_REPOSITORY: "example/alcove",
        GITHUB_SHA: SHA,
        GITHUB_OUTPUT: files.output,
        GITHUB_STEP_SUMMARY: files.summary,
        STUB_ARGS: files.args,
        ...stubEnv,
      },
    });
    const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
    return {
      status: result.status,
      stdout: result.stdout,
      output: read(files.output),
      summary: read(files.summary),
      args: read(files.args),
    };
  };

  it.each(["identical", "behind"])("uploads when main is %s", (status) => {
    const result = runStep({ STUB_STATUS: status });
    expect(result.status).toBe(0);
    expect(result.args).toBe(
      `api repos/example/alcove/compare/${SHA}...main --jq .status\n`,
    );
    expect(result.output).toBe("upload=true\n");
    expect(result.stdout).not.toContain("::notice::");
    expect(result.summary).toBe("");
  });

  it.each(["ahead", "diverged"])(
    "skips the upload with a notice and a summary line when main is %s",
    (status) => {
      const result = runStep({ STUB_STATUS: status });
      expect(result.status).toBe(0);
      expect(result.output).toBe("upload=false\n");
      expect(result.stdout).toMatch(
        /^::notice::Skipped the production upload: main holds a commit the release commit lacks/m,
      );
      expect(result.summary).toContain(
        `Skipped the production upload: \`main\` holds a commit the release commit ${SHA} lacks`,
      );
      expect(result.summary).toContain(`\`${status}\``);
      expect(result.summary).toContain("production keeps `main`'s last build");
    },
  );

  it("fails the step, deciding nothing, when the API call fails", () => {
    const result = runStep({ STUB_FAIL: "1" });
    expect(result.status).not.toBe(0);
    expect(result.output).toBe("");
    expect(result.summary).toBe("");
  });
});
