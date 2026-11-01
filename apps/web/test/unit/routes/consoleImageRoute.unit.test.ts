import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getLogger } from "@alcove/core";

import { resolveConsoleImage, warnConsoleImage } from "@jobs/consoleImage";

import { route as ImageRoute } from "../../../server/console/routes/image";

import { tempDataRoot } from "../../utils/jobFixtures";

type Handler = (ctx: {
  request: Request;
  params: Record<string, string>;
}) => unknown;

const DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;

const roots: Array<string> = [];

beforeEach(() => {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
  vi.stubEnv("JOB_IMAGE_REGISTRY", "");
  vi.stubEnv("JOB_IMAGE_DIGEST", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function enableJobApi(): void {
  const root = tempDataRoot("routes-image");
  roots.push(root);
  fs.mkdirSync(root, { recursive: true });
  vi.stubEnv("JOB_DATA_ROOT", root);
}

/** GET /api/jobs/image with a loopback Host. */
async function getImage(): Promise<Response> {
  const handler = (ImageRoute.handlers as Record<string, Handler>).GET;
  return (await handler({
    request: new Request("http://localhost/api/jobs/image", {
      headers: { host: "localhost" },
    }),
    params: {},
  })) as Response;
}

describe("GET /api/jobs/image names the image the launcher ran", () => {
  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    vi.stubEnv("JOB_IMAGE_REGISTRY", "docker.io");
    expect((await getImage()).status).toBe(404);
  });

  test("names Docker Hub and no digest when the launcher passed neither", async () => {
    enableJobApi();
    const response = await getImage();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ registry: "docker.io" });
  });

  test("names the registry and digest the launcher passed, either registry", async () => {
    enableJobApi();
    vi.stubEnv("JOB_IMAGE_DIGEST", DIGEST);
    for (const registry of ["docker.io", "ghcr.io"]) {
      vi.stubEnv("JOB_IMAGE_REGISTRY", registry);
      expect(await (await getImage()).json()).toEqual({
        registry,
        digest: DIGEST,
      });
    }
  });

  test("drops a value of any other shape rather than passing it on", async () => {
    enableJobApi();
    vi.stubEnv("JOB_IMAGE_REGISTRY", "registry.example.org");
    vi.stubEnv("JOB_IMAGE_DIGEST", `${DIGEST}/../evil`);
    expect(await (await getImage()).json()).toEqual({ registry: "docker.io" });
  });
});

describe("the console image's environment", () => {
  test("a value padded with whitespace is read trimmed", () => {
    expect(
      resolveConsoleImage({
        JOB_IMAGE_REGISTRY: " docker.io\n",
        JOB_IMAGE_DIGEST: ` ${DIGEST} `,
      }),
    ).toEqual({ registry: "docker.io", digest: DIGEST });
  });

  test("a value the console does not read is named at startup", () => {
    enableJobApi();
    const warn = vi
      .spyOn(getLogger("job-api"), "warn")
      .mockImplementation(() => undefined);
    warnConsoleImage({
      ...process.env,
      JOB_IMAGE_REGISTRY: "quay.io",
      JOB_IMAGE_DIGEST: "latest",
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain("JOB_IMAGE_REGISTRY");
    expect(String(warn.mock.calls[1]?.[0])).toContain("JOB_IMAGE_DIGEST");
  });

  test("an unset or well-formed value is not warned about", () => {
    enableJobApi();
    const warn = vi
      .spyOn(getLogger("job-api"), "warn")
      .mockImplementation(() => undefined);
    warnConsoleImage({ ...process.env });
    warnConsoleImage({
      ...process.env,
      JOB_IMAGE_REGISTRY: "docker.io",
      JOB_IMAGE_DIGEST: DIGEST,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
