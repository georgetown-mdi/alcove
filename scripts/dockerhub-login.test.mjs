import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readWorkflows, parseWorkflow } from "./lib/workflows.mjs";

// Docker Hub limits anonymous pulls per source IP, and GitHub-hosted runners
// share theirs, so every job that reaches the Hub logs in first when the
// repository holds a token, and pulls anonymously when it does not (a fork's
// run). This holds that shape: each job whose steps reach the Hub carries the
// login step ahead of the first one, gated on the token being set, and no job
// logs in without reaching it.
//
// A step reaches the Hub when it sets up QEMU or a buildx builder, builds with
// build-push-action, or runs `docker run`, `pull`, `build`, `buildx build` or
// `create` in its own text. A pull made from inside a script the step starts
// is invisible to that reading, so such a step is named in HUB_THROUGH_SCRIPT;
// a docker command naming another registry only is named in NOT_HUB. What
// this cannot see: an image a step reaches some other way, and composite
// actions, none of which pull today.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LOGIN_GATE = "${{ secrets.DOCKERHUB_TOKEN != '' }}";
const LOGIN_CONDITION = "env.DOCKERHUB_LOGIN == 'true'";
const USERNAME = "${{ secrets.DOCKERHUB_USERNAME }}";
const PASSWORD = "${{ secrets.DOCKERHUB_TOKEN }}";

const HUB_ACTIONS = [
  /^docker\/setup-qemu-action@/,
  /^docker\/setup-buildx-action@/,
  /^docker\/build-push-action@/,
];
const HUB_COMMAND = /\bdocker\s+(?:run|pull|build|create|buildx\s+build)\b/;

// `${file} ${job} ${step name}` -> why the step reaches the Hub.
const HUB_THROUGH_SCRIPT = new Map([
  [
    "static_checks.yaml repo-guards Repository checks",
    "scripts/relay-turn-secret-schema.test.mjs runs the coturn image infra/relay/Dockerfile pins",
  ],
]);

// `${file} ${job} ${step name}` -> the registry the step pulls from instead.
const NOT_HUB = new Map([
  ["image_smoke.yaml published_image Pull the published image", "ghcr.io"],
]);

const keyOf = (file, job, step) =>
  `${file.split("/").pop()} ${job} ${step.name ?? ""}`;

const isHubLogin = (step) =>
  /^docker\/login-action@/.test(step.uses ?? "") &&
  step.with?.registry === undefined;

function reachesHub(file, job, step) {
  const key = keyOf(file, job, step);
  if (HUB_THROUGH_SCRIPT.has(key)) return true;
  if (NOT_HUB.has(key)) return false;
  if (HUB_ACTIONS.some((pattern) => pattern.test(step.uses ?? ""))) return true;
  return typeof step.run === "string" && HUB_COMMAND.test(step.run);
}

const jobs = readWorkflows(ROOT).flatMap(({ path, source }) =>
  Object.entries(parseWorkflow(path, source).jobs ?? {})
    .filter(([, job]) => Array.isArray(job?.steps))
    .map(([name, job]) => ({ file: path, name, job })),
);

const hubJobs = jobs
  .map((entry) => ({
    ...entry,
    firstPull: entry.job.steps.findIndex((step) =>
      reachesHub(entry.file, entry.name, step),
    ),
  }))
  .filter(({ firstPull }) => firstPull !== -1);

describe("Docker Hub logins in the workflows", () => {
  it("finds the jobs that pull from the Hub", () => {
    expect(hubJobs.length).toBeGreaterThan(0);
  });

  it.each(
    [...HUB_THROUGH_SCRIPT.keys(), ...NOT_HUB.keys()].map((key) => [key]),
  )("names a step that exists: %s", (key) => {
    const found = jobs.some(({ file, name, job }) =>
      job.steps.some((step) => keyOf(file, name, step) === key),
    );
    expect(found, `${key} is no longer a step; update this test`).toBe(true);
  });

  it.each(hubJobs.map((entry) => [`${entry.file} ${entry.name}`, entry]))(
    "logs in before the first pull: %s",
    (_label, { job, firstPull }) => {
      const login = job.steps.findIndex(isHubLogin);
      expect(
        login,
        "add the Docker Hub login step ahead of the job's first pull",
      ).not.toBe(-1);
      expect(login).toBeLessThan(firstPull);

      const step = job.steps[login];
      expect(step.with).toEqual({ username: USERNAME, password: PASSWORD });
      expect(String(step.if ?? "")).toContain(LOGIN_CONDITION);
      expect(job.env?.DOCKERHUB_LOGIN).toBe(LOGIN_GATE);
    },
  );

  it("logs in only in jobs that pull from the Hub", () => {
    const pulling = new Set(hubJobs.map(({ file, name }) => `${file} ${name}`));
    const stray = jobs
      .filter(({ job }) => job.steps.some(isHubLogin))
      .map(({ file, name }) => `${file} ${name}`)
      .filter((label) => !pulling.has(label));
    expect(stray).toEqual([]);
  });

  it("pins every QEMU emulator image to one digest", () => {
    const images = jobs.flatMap(({ job }) =>
      job.steps
        .filter((step) => /^docker\/setup-qemu-action@/.test(step.uses ?? ""))
        .map((step) => step.with?.image),
    );
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image).toMatch(
        /^docker\.io\/tonistiigi\/binfmt@sha256:[0-9a-f]{64}$/,
      );
    }
    expect(new Set(images).size).toBe(1);
  });
});
