import { afterEach, expect, test, vi } from "vitest";
import { UsageError } from "@alcove/core";
import type { ConnectionConfig } from "@alcove/core";

import { wakeProvisionedServer } from "../../src/serverProvision";

/** Stub the global fetch the wake call sends through, answering `status`. */
function stubProvisionFetch(status: number) {
  const fetch = vi.fn(
    async (_input: URL | RequestInfo, _init?: RequestInit) =>
      new Response(null, { status }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function sftpConnectionWithProvision(host: string): ConnectionConfig {
  return {
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      provision: { host, path: "/start" },
    },
  };
}

function mockLog() {
  return { info: vi.fn() };
}

test("a refused host produces no waking log line", async () => {
  // "127.1" is a shortened IPv4 form the URL parser would rewrite to
  // "127.0.0.1", which provisionRequest refuses before a request is ever
  // built -- the same refusal callProvisionEndpoint raises internally.
  const log = mockLog();
  await expect(
    wakeProvisionedServer(sftpConnectionWithProvision("127.1"), log),
  ).rejects.toBeInstanceOf(UsageError);
  expect(log.info).not.toHaveBeenCalled();
});

test("a valid provision block logs the waking line before sending the request", async () => {
  const log = mockLog();
  const fetch = stubProvisionFetch(200);
  await wakeProvisionedServer(
    sftpConnectionWithProvision("wake.example.org"),
    log,
  );
  expect(log.info).toHaveBeenCalledTimes(1);
  expect(log.info.mock.calls[0][0]).toContain(
    "waking the server through the provisioning endpoint at wake.example.org:443",
  );
  const [logged] = log.info.mock.invocationCallOrder;
  const [sent] = fetch.mock.invocationCallOrder;
  expect(logged).toBeLessThan(sent);
});

test("a connection stating no provision block is a no-op", async () => {
  const log = mockLog();
  await wakeProvisionedServer({ channel: "filedrop" }, log);
  expect(log.info).not.toHaveBeenCalled();
});
