import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseWorkflow, readWorkflows } from "./lib/workflows.mjs";

// Holds each tool version a workflow input or a Dockerfile ARG names equal to
// the tag of its stage in .github/tool-versions/Dockerfile, the file the
// Dependabot docker entry for /.github/tool-versions moves, since no Dependabot
// block reads those consumers. A bump there fails here until the same pull
// request moves the consumer.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL_VERSIONS_DOCKERFILE = ".github/tool-versions/Dockerfile";
const MOVE_WITH_TOOL_VERSIONS = `set it to the release ${TOOL_VERSIONS_DOCKERFILE} names`;

const toolTags = new Map(
  [
    ...readFileSync(resolve(ROOT, TOOL_VERSIONS_DOCKERFILE), "utf8").matchAll(
      /^FROM \S+:(\S+) AS (\S+)$/gm,
    ),
  ].map((match) => [match[2], match[1]]),
);

const steps = readWorkflows(ROOT).flatMap(({ path, source }) =>
  Object.values(parseWorkflow(path, source).jobs ?? {}).flatMap((job) =>
    Array.isArray(job?.steps) ? job.steps : [],
  ),
);

describe("tool versions mirrored for Dependabot", () => {
  it("names a stage for each tool, and nothing else", () => {
    expect([...toolTags.keys()]).toEqual(["cosign", "python", "aws-cli"]);
  });

  it("installs the Cosign release the cosign stage names", () => {
    const releases = steps
      .filter((step) => /^sigstore\/cosign-installer@/.test(step.uses ?? ""))
      .map((step) => step.with?.["cosign-release"])
      .filter((release) => release !== undefined);
    expect(releases.length).toBeGreaterThan(0);
    expect(toolTags.get("cosign")).toMatch(/^v\d+\.\d+\.\d+$/);
    for (const release of releases) {
      expect(String(release), MOVE_WITH_TOOL_VERSIONS).toBe(
        toolTags.get("cosign"),
      );
    }
  });

  it("sets up the Python release the python stage names", () => {
    const versions = steps
      .filter((step) => /^actions\/setup-python@/.test(step.uses ?? ""))
      .map((step) => step.with?.["python-version"]);
    expect(versions.length).toBeGreaterThan(0);
    expect(toolTags.get("python")).toMatch(/^\d+\.\d+\.\d+$/);
    for (const version of versions) {
      expect(String(version), MOVE_WITH_TOOL_VERSIONS).toBe(
        toolTags.get("python"),
      );
    }
  });

  it("installs the AWS CLI release the aws-cli stage names", () => {
    const declared = [
      ...readFileSync(
        resolve(ROOT, ".devcontainer/Dockerfile"),
        "utf8",
      ).matchAll(/^ARG AWSCLI_VERSION=(\S+)$/gm),
    ].map((match) => match[1]);
    expect(declared).toHaveLength(1);
    expect(toolTags.get("aws-cli")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(declared[0], MOVE_WITH_TOOL_VERSIONS).toBe(toolTags.get("aws-cli"));
  });
});
