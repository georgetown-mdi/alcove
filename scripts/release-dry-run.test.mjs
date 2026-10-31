import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  RELEASES_DOC,
  certificateFlags,
  publishedCertificatePair,
} from "./check-release-signing.mjs";
import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

// The release workflow publishes on a pushed version tag; a manual dispatch,
// from any branch, runs the dry-run job instead. This holds the shape that
// keeps a dispatch from holding a write permission: the publishing jobs and the
// hosted app's production deploy run on a tag push only, and the dry-run job
// has read access alone, no publishing step, and builds with a literal
// `push: false`.
//
// What this cannot see: a `run` that publishes through a script file, such as
// `run: ./publish.sh`, since only the step's own text is read.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const RELEASE_WORKFLOW = `${WORKFLOW_DIR}/release.yaml`;
const document = workflowDocument(repoRoot, RELEASE_WORKFLOW);

const TAG_PUSH_ONLY = "${{ github.event_name == 'push' }}";
const DISPATCH_ONLY = "${{ github.event_name == 'workflow_dispatch' }}";
const PUBLISHING_JOBS = ["publish", "launchers", "dockerhub"];
const DRY_RUN_JOB = "dry-run";
const HOSTED_APP_DEPLOY_JOB = "pages";
const HOSTED_APP_JOBS = ["web", HOSTED_APP_DEPLOY_JOB];

const PUBLISHING_ACTIONS = [
  /(^|\/)login-action@/,
  /^actions\/attest/,
  /release/i,
];
const PUBLISHING_COMMANDS = [
  /\bcosign\s+sign(?![-\w])/,
  /\bcosign\s+verify(?![-\w])/,
  /\bcosign\s+copy\b/,
  /\bdocker\s+push\b/,
  /\bimagetools\s+create\b/,
  /\bgh\s+release\b/,
  /\bgh\s+api\b.*(-X|--method)[\s=]*['"]?(POST|PUT|PATCH|DELETE)\b/i,
  /\bgh\s+api\b.*\s(-f|-F|--field|--raw-field|--input)\b/,
];

// The Docker Hub login ahead of the image pulls: the default registry, and the
// repository's pull token, which is created read-only. That scope is the
// owner's setting on Docker Hub, which nothing here can read.
const isHubPullLogin = (step) =>
  /^docker\/login-action@/.test(step.uses ?? "") &&
  step.with?.registry === undefined &&
  step.with?.password === "${{ secrets.DOCKERHUB_TOKEN }}";

/** Why a step publishes, or undefined when it does not. */
function publishes(step) {
  if (isHubPullLogin(step)) return undefined;
  const uses = step.uses ?? "";
  const run = step.run ?? "";
  const action = PUBLISHING_ACTIONS.find((pattern) => pattern.test(uses));
  if (action !== undefined) return `uses ${uses}`;
  const command = PUBLISHING_COMMANDS.find((pattern) => pattern.test(run));
  if (command !== undefined) return `runs ${command.source}`;
  return undefined;
}

/** The build-push-action steps of a job's step list. */
function buildSteps(steps) {
  return steps.filter((step) =>
    (step.uses ?? "").startsWith("docker/build-push-action@"),
  );
}

/** The `scope` of a gha cache spec; the unnamed default scope is "default". */
function cacheScope(spec) {
  return /(?:^|,)scope=([^,]+)/.exec(spec ?? "")?.[1] ?? "default";
}

const dryRun = document.jobs[DRY_RUN_JOB];
const dryRunSteps = dryRun?.steps ?? [];

describe("the release workflow's dry run", () => {
  it("is triggered by a pushed version tag and by a manual dispatch alone", () => {
    expect(Object.keys(document.on).sort()).toEqual([
      "push",
      "workflow_dispatch",
    ]);
    expect(document.on.push.tags).toEqual(["v[0-9]+.[0-9]+.[0-9]+"]);
  });

  for (const job of PUBLISHING_JOBS) {
    it(`runs the ${job} job on a tag push only`, () => {
      expect(document.jobs[job]?.if).toBe(TAG_PUSH_ONLY);
    });
  }

  // The production deploy of the hosted app follows the published images, so
  // a tag the publish job refuses deploys nothing.
  for (const job of HOSTED_APP_JOBS) {
    it(`runs the ${job} job on a tag push only`, () => {
      expect(document.jobs[job]?.if).toBe(TAG_PUSH_ONLY);
    });
  }

  it("deploys the hosted app only after the publish job succeeds", () => {
    const deploy = document.jobs[HOSTED_APP_DEPLOY_JOB];
    expect([deploy?.needs].flat()).toContain("publish");
    expect(deploy?.environment).toBe("Production");
  });

  it("runs the dry-run job on a manual dispatch only", () => {
    expect(dryRun?.if).toBe(DISPATCH_ONLY);
  });

  it("keeps the test job read-only", () => {
    const permissions = document.jobs.test?.permissions;
    if (permissions === undefined) {
      expect(document.permissions).toEqual({ contents: "read" });
    } else {
      expect(permissions).toEqual({ contents: "read" });
    }
  });

  it("gives the dry-run job read access to the repository and nothing else", () => {
    expect(dryRun?.permissions).toEqual({ contents: "read" });
  });

  it("has no publishing login, attest, sign, verify, push or release step in the dry-run job", () => {
    expect(dryRunSteps.length).toBeGreaterThan(0);
    const found = dryRunSteps
      .map((step) => ({ name: step.name ?? step.uses, why: publishes(step) }))
      .filter(({ why }) => why !== undefined);
    expect(found).toEqual([]);
  });

  it("builds with a literal `push: false` in every dry-run build step", () => {
    const builds = dryRunSteps.filter((step) =>
      (step.uses ?? "").startsWith("docker/build-push-action@"),
    );
    expect(builds.length).toBe(2);
    for (const step of builds) {
      expect(step.with?.push).toBe(false);
    }
  });

  it("pushes nothing to a registry from a dry-run build", () => {
    for (const step of buildSteps(dryRunSteps)) {
      expect(step.with?.outputs ?? "").not.toMatch(/type=registry/);
      expect(step.with).not.toHaveProperty("push-by-digest");
    }
  });

  it("keeps the dry-run build cache scopes apart from every publish step's", () => {
    const publishScopes = new Set();
    for (const job of PUBLISHING_JOBS) {
      for (const step of buildSteps(document.jobs[job]?.steps ?? [])) {
        publishScopes.add(cacheScope(step.with?.["cache-from"]));
        publishScopes.add(cacheScope(step.with?.["cache-to"]));
      }
    }
    expect(publishScopes.size).toBeGreaterThan(0);
    for (const step of buildSteps(dryRunSteps)) {
      for (const input of ["cache-from", "cache-to"]) {
        expect(step.with?.[input]).toBeDefined();
        expect(publishScopes).not.toContain(cacheScope(step.with[input]));
      }
    }
  });
});

// The Docker Hub copy is signed: the signature the publish job made is copied
// beside each image the dockerhub job copies, before the copy, and verified on
// Docker Hub with the command docs/RELEASES.md publishes, after it. What this
// cannot see is whether `cosign copy` writes the signature where `cosign verify`
// reads it on Docker Hub; the verify step is what a real release fails on.
describe("the Docker Hub copy's signature", () => {
  const dockerhub = document.jobs.dockerhub;
  const steps = dockerhub?.steps ?? [];
  const COPIED_DIGESTS = {
    DEFAULT_DIGEST: "${{ needs.publish.outputs.digest }}",
    FIPS_DIGEST: "${{ needs.publish.outputs.fips_digest }}",
  };
  const published = publishedCertificatePair(
    readFileSync(resolve(repoRoot, RELEASES_DOC), "utf8"),
  );

  const indexOf = (predicate) => steps.findIndex(predicate);
  const runs = (pattern) => (step) => pattern.test(step.run ?? "");
  const imageCopy = indexOf(runs(/\bimagetools\s+create\b/));
  const signatureCopy = indexOf(runs(/\bcosign\s+copy\b/));
  const verify = indexOf(runs(/\bcosign\s+verify(?![-\w])/));
  const cosignInstall = indexOf((step) =>
    (step.uses ?? "").startsWith("sigstore/cosign-installer@"),
  );

  /** Whether a step's run covers both copied digests, by their env names. */
  function coversEveryDigest(step) {
    for (const [name, value] of Object.entries(COPIED_DIGESTS)) {
      expect(step.env?.[name]).toBe(value);
      expect(step.run).toContain(`"\${${name}}"`);
    }
  }

  it("copies the images by the digests the publish job signed", () => {
    expect(imageCopy).toBeGreaterThanOrEqual(0);
    expect(steps[imageCopy].env).toMatchObject(COPIED_DIGESTS);
  });

  it("copies the signature of each image to Docker Hub before the images", () => {
    expect(signatureCopy).toBeGreaterThanOrEqual(0);
    expect(signatureCopy).toBeLessThan(imageCopy);
    const step = steps[signatureCopy];
    expect(step.run).toMatch(
      /cosign\s+copy\s+--only=sig\b[^\n]*\\\n\s*"\$\{GHCR_REPOSITORY\}@\$\{digest\}"\s+"\$\{DOCKERHUB_REPOSITORY\}"/,
    );
    coversEveryDigest(step);
  });

  it("verifies each copied signature on Docker Hub after the images are copied", () => {
    expect(verify).toBeGreaterThan(imageCopy);
    const step = steps[verify];
    expect(step.run).toContain('"${DOCKERHUB_REPOSITORY}@${digest}"');
    coversEveryDigest(step);
    const flags = certificateFlags(step.run);
    expect(published.identity).toBeDefined();
    expect(published.issuer).toBeDefined();
    expect(flags.identities).toEqual([published.identity]);
    expect(flags.issuers).toEqual([published.issuer]);
  });

  it("names the two repositories the copy runs between", () => {
    expect(dockerhub?.env).toEqual({
      GHCR_REPOSITORY: "ghcr.io/georgetown-mdi/alcove",
      DOCKERHUB_REPOSITORY: "docker.io/gumdi/alcove",
    });
  });

  it("installs Cosign before anything is written to Docker Hub", () => {
    expect(cosignInstall).toBeGreaterThanOrEqual(0);
    expect(cosignInstall).toBeLessThan(signatureCopy);
  });

  it("copies the signature rather than signing again, so holds no id-token", () => {
    expect(dockerhub?.permissions).toEqual({ packages: "read" });
    for (const step of steps) {
      expect(step.run ?? "").not.toMatch(/\bcosign\s+sign(?![-\w])/);
    }
  });
});
