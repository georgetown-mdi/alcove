import { describe, expect, test } from "vitest";

import {
  UNREPORTED_CONSOLE_IMAGE,
  fetchConsoleImage,
  parseConsoleImage,
} from "@psi/jobClient/consoleImageClient";

const DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;

/** A fetch answering every request with `body` as JSON at `status`. */
function answering(body: unknown, status = 200): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe("parseConsoleImage", () => {
  test("reads either registry, with or without a digest", () => {
    expect(
      parseConsoleImage({ registry: "docker.io", digest: DIGEST }),
    ).toEqual({ registry: "docker.io", digest: DIGEST });
    expect(parseConsoleImage({ registry: "ghcr.io" })).toEqual({
      registry: "ghcr.io",
    });
  });

  test("refuses a registry the app does not name", () => {
    for (const registry of ["quay.io", "", "DOCKER.IO", undefined, 1])
      expect(parseConsoleImage({ registry, digest: DIGEST })).toBeNull();
    expect(parseConsoleImage(null)).toBeNull();
    expect(parseConsoleImage("docker.io")).toBeNull();
  });

  test("drops a digest of any other shape and keeps the registry", () => {
    for (const digest of ["", "latest", `${DIGEST}\n`, DIGEST.toUpperCase(), 7])
      expect(parseConsoleImage({ registry: "docker.io", digest })).toEqual({
        registry: "docker.io",
      });
  });
});

describe("fetchConsoleImage", () => {
  test("returns the image the console reports", async () => {
    await expect(
      fetchConsoleImage(answering({ registry: "docker.io", digest: DIGEST })),
    ).resolves.toEqual({ registry: "docker.io", digest: DIGEST });
  });

  test.each<[string, typeof fetch]>([
    ["a 404", answering({ registry: "docker.io" }, 404)],
    ["a malformed body", answering({ registry: "quay.io" })],
    ["a network failure", () => Promise.reject(new TypeError("offline"))],
  ])("names the unreported default on %s", async (_label, fetchImpl) => {
    await expect(fetchConsoleImage(fetchImpl)).resolves.toEqual(
      UNREPORTED_CONSOLE_IMAGE,
    );
  });
});
