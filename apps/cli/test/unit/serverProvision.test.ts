import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import { UsageError } from "@alcove/core";
import type { ConnectionConfig } from "@alcove/core";

import {
  createProvisionedServer,
  readStartModeProvision,
  wakeServerThrough,
  wakeProvisionedServer,
} from "../../src/serverProvision";

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

function withMode(
  connection: ConnectionConfig,
  mode: "start" | "create",
): ConnectionConfig {
  if (connection.channel === "filedrop") return connection;
  const provision = connection.server.provision;
  if (provision === undefined) return connection;
  return {
    ...connection,
    server: { ...connection.server, provision: { ...provision, mode } },
  } as ConnectionConfig;
}

test("a create-mode block sends no wake call", async () => {
  const log = mockLog();
  const fetch = stubProvisionFetch(200);
  await wakeProvisionedServer(
    withMode(sftpConnectionWithProvision("create.example.org"), "create"),
    log,
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(log.info).not.toHaveBeenCalled();
});

test("a start-mode block sends no create call", async () => {
  const log = mockLog();
  const fetch = stubProvisionFetch(200);
  await expect(
    createProvisionedServer(
      withMode(sftpConnectionWithProvision("wake.example.org"), "start"),
      log,
    ),
  ).resolves.toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

test("a create-mode block reads its bearer file, logs the call, and resolves to the returned address", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-create-server-"));
  try {
    const tokenFile = path.join(dir, "token");
    fs.writeFileSync(tokenFile, "create-token\n");
    const fetch = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        new Response('{"host":"sftp-3.example.org"}', { status: 201 }),
    );
    vi.stubGlobal("fetch", fetch);
    const log = mockLog();
    const address = await createProvisionedServer(
      {
        channel: "sftp",
        server: {
          host: "pending",
          provision: {
            mode: "create",
            host: "create.example.org",
            auth: { bearer: `@${tokenFile}` },
          },
        },
      },
      log,
    );
    expect(address).toEqual({ host: "sftp-3.example.org" });
    expect(
      new Headers(fetch.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe("Bearer create-token");
    expect(log.info.mock.calls[0][0]).toContain(
      "creating a server through the provisioning endpoint at create.example.org:443",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readStartModeProvision reads a start-mode block's bearer file and leaves the connection's reference", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "alcove-read-provision-"));
  try {
    const tokenFile = path.join(dir, "token");
    fs.writeFileSync(tokenFile, "wake-token\n");
    const connection: ConnectionConfig = {
      channel: "sftp",
      server: {
        host: "sftp.example.org",
        provision: {
          host: "wake.example.org",
          auth: { bearer: `@${tokenFile}` },
        },
      },
    };
    expect(readStartModeProvision(connection)?.auth).toEqual({
      bearer: "wake-token",
    });
    if (connection.channel !== "sftp") throw new Error("expected sftp");
    expect(connection.server.provision?.auth?.bearer).toBe(`@${tokenFile}`);
    expect(
      readStartModeProvision(
        withMode(sftpConnectionWithProvision("wake.example.org"), "create"),
      ),
    ).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("wakeServerThrough sends nothing for a connection stating no start-mode block", async () => {
  const log = mockLog();
  const fetch = stubProvisionFetch(200);
  await wakeServerThrough(undefined, log);
  expect(fetch).not.toHaveBeenCalled();
  expect(log.info).not.toHaveBeenCalled();
});
