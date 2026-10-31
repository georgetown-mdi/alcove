/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { RecurringHandoff } from "@recurring/RecurringHandoff";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { JobHandoff } from "@jobContract/jobHandoff";

// The registry is the console's to report, so this suite runs a console build.
vi.mock("@utils/clientConfig", async (importOriginal) =>
  (await import("../utils/clientConfigMock")).consoleClientConfigMock(
    importOriginal,
  ),
);

const JOB_ID = "job-9";

const HANDOFF = {
  mode: "zeroSetup",
  channel: "sftp",
  usedKeyFile: false,
  keyFileBesideConfiguration: false,
  credentialPasted: false,
  usedSigningIdentity: false,
  pathsAsRead: { credential: false, sharedDirectory: false, signing: false },
  bindPaths: [],
  template: {
    kind: "command",
    argv: [
      "alcove",
      "sftp://sftp.example.gov:2222/exchange",
      "--server-username=linkage",
      "--server-host-key-fingerprint=SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "--server-password=@/path/to/your/credential-file",
      "input.csv",
      "./",
    ],
  },
} satisfies JobHandoff;

/** Stub the hand-off endpoint and the console's image endpoint, which answers
 * `image` as its body, or 404 where `image` is null. */
function stubConsole(image: unknown | null): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    if (url === `/api/jobs/${JOB_ID}/handoff`) return json(HANDOFF);
    if (url === "/api/jobs/image")
      return image === null
        ? Promise.resolve(new Response(null, { status: 404 }))
        : json(image);
    return Promise.resolve(new Response(null, { status: 404 }));
  });
}

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  vi.unstubAllGlobals();
});

/** Every `docker run` and `podman run` block the panel shows. */
async function runBlocks(): Promise<Array<string>> {
  await expect
    .element(
      page.getByRole("heading", { name: "Run this exchange on a schedule" }),
    )
    .toBeInTheDocument();
  const blocks = Array.from(app.container.querySelectorAll("pre"))
    .map((block) => block.textContent)
    .filter((code) => /\b(docker|podman) run\b/.test(code));
  expect(blocks.length).toBeGreaterThan(0);
  return blocks;
}

describe("RecurringHandoff names the registry the console reports", () => {
  test("Docker Hub, when the launcher reached it", async () => {
    stubConsole({ registry: "docker.io" });
    app.render(createElement(RecurringHandoff, { jobId: JOB_ID }));
    for (const block of await runBlocks()) {
      expect(block).toContain("docker.io/gumdi/alcove:latest");
      expect(block).not.toContain("ghcr.io");
    }
  });

  test("ghcr.io, when the launcher fell back to it", async () => {
    stubConsole({ registry: "ghcr.io" });
    app.render(createElement(RecurringHandoff, { jobId: JOB_ID }));
    for (const block of await runBlocks()) {
      expect(block).toContain("ghcr.io/georgetown-mdi/alcove:latest");
      expect(block).not.toContain("docker.io");
    }
  });

  test("ghcr.io, when the console reports no registry", async () => {
    stubConsole(null);
    app.render(createElement(RecurringHandoff, { jobId: JOB_ID }));
    for (const block of await runBlocks())
      expect(block).toContain("ghcr.io/georgetown-mdi/alcove:latest");
  });
});
