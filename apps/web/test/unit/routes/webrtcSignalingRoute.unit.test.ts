import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  SIGNALING_ADDRESS_CREDENTIALS_REFUSED,
  SIGNALING_ADDRESS_SCHEME_REFUSED,
  SIGNALING_UNENCRYPTED_WARNING,
} from "@jobs/signalingServer";
import { JOB_FILE_NAMES } from "@jobContract/intentSchemas";
import { JobManager } from "@jobs/jobManager";

import { route as CreateRoute } from "../../../server/console/routes/index";
import { route as WebrtcRoute } from "../../../server/console/routes/webrtc";

import {
  STUB_CLI_PATH,
  VALID_SHARED_SECRET,
  tempDataRoot,
  validWebrtcIntent,
} from "../../utils/jobFixtures";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Handler = (ctx: {
  request: Request;
  params: Record<string, string>;
}) => unknown;

const roots: Array<string> = [];
const servers: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const seeded = (globalThis as { jobManagerInstance?: JobManager })
    .jobManagerInstance;
  await seeded?.shutdown();
  (globalThis as { jobManagerInstance?: unknown }).jobManagerInstance =
    undefined;
  for (const close of servers.splice(0)) await close();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

/** Seed the global manager the routes use, pointed at the stub CLI. */
function seedManager(): { manager: JobManager; root: string } {
  const root = tempDataRoot("routes-webrtc");
  roots.push(root);
  fs.mkdirSync(root, { recursive: true });
  vi.stubEnv("JOB_DATA_ROOT", root);
  const manager = new JobManager({
    dataRoot: root,
    binaryPath: STUB_CLI_PATH,
    childEnv: { STUB_FD3_EVENTS: JSON.stringify([]), STUB_DELAY_MS: "5000" },
  });
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    manager;
  return { manager, root };
}

function handler(
  route: { handlers: unknown },
  method: "GET" | "PUT" | "DELETE" | "POST",
): Handler {
  return (route.handlers as Record<string, Handler>)[method];
}

function request(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", "localhost");
  return new Request(url, { ...init, headers });
}

async function putWebrtc(body: unknown): Promise<Response> {
  return (await handler(
    WebrtcRoute,
    "PUT",
  )({
    request: request("http://localhost/api/jobs/webrtc", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
  })) as Response;
}

async function getWebrtc(): Promise<unknown> {
  const response = (await handler(
    WebrtcRoute,
    "GET",
  )({
    request: request("http://localhost/api/jobs/webrtc"),
    params: {},
  })) as Response;
  return response.json();
}

async function deleteWebrtc(): Promise<Response> {
  return (await handler(
    WebrtcRoute,
    "DELETE",
  )({
    request: request("http://localhost/api/jobs/webrtc", { method: "DELETE" }),
    params: {},
  })) as Response;
}

async function postJob(body: unknown): Promise<Response> {
  return (await handler(
    CreateRoute,
    "POST",
  )({
    request: request("http://localhost/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {},
  })) as Response;
}

/** A loopback web app answering every request with `answer`; resolves to its
 * address. */
async function webApp(
  answer: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(answer);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  servers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

function publishing(signalingServer: string) {
  return (_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ signaling_server: signalingServer }));
  };
}

describe("PUT/GET/DELETE /api/jobs/webrtc (the coordination server)", () => {
  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    expect((await putWebrtc({ address: "wss://peers.test/psi" })).status).toBe(
      404,
    );
  });

  test("authors a wss:// server that GET then reports", async () => {
    seedManager();
    expect(await getWebrtc()).toEqual({ configured: false });
    const put = await putWebrtc({ address: " wss://peers.test:8443/psi " });
    const expected = {
      configured: true,
      host: "peers.test",
      port: 8443,
      path: "/psi/",
      secure: true,
      warnings: [],
    };
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(expected);
    expect(await getWebrtc()).toEqual(expected);

    expect((await deleteWebrtc()).status).toBe(204);
    expect(await getWebrtc()).toEqual({ configured: false });
  });

  test("admits a ws:// server with the unencrypted warning", async () => {
    seedManager();
    const put = await putWebrtc({ address: "ws://127.0.0.1:9000/api/" });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      host: "127.0.0.1",
      port: 9000,
      secure: false,
      warnings: [SIGNALING_UNENCRYPTED_WARNING],
    });
  });

  test("refuses credentials in the address without echoing them", async () => {
    seedManager();
    for (const address of [
      "wss://operator:hunter2@peers.test/psi",
      "https://operator:hunter2@app.test/",
    ]) {
      const put = await putWebrtc({ address });
      expect(put.status).toBe(400);
      const text = await put.text();
      expect(text).not.toContain("hunter2");
      expect(JSON.parse(text)).toEqual({
        error: SIGNALING_ADDRESS_CREDENTIALS_REFUSED,
      });
    }
    expect(await getWebrtc()).toEqual({ configured: false });
  });

  test.each([
    [
      "another scheme",
      "sftp://peers.test/psi",
      SIGNALING_ADDRESS_SCHEME_REFUSED,
    ],
    ["no URL", "peers.test/psi", SIGNALING_ADDRESS_SCHEME_REFUSED],
    ["a query", "wss://peers.test/psi?key=x", /no query, fragment/],
    ["a percent-escape", "wss://peers.test/p%2Fsi", /percent-escape/],
    ["port 0", "wss://peers.test:0/psi", /port 0/],
    ["a web app path", "https://app.test/accept", /no path, query/],
  ])("refuses %s, keeping the authored server", async (_, address, error) => {
    seedManager();
    await putWebrtc({ address: "wss://kept.test/psi" });
    const put = await putWebrtc({ address });
    expect(put.status).toBe(400);
    const body = (await put.json()) as { error: string };
    if (typeof error === "string") expect(body.error).toBe(error);
    else expect(body.error).toMatch(error);
    expect(await getWebrtc()).toMatchObject({ host: "kept.test" });
  });

  test("refuses a body that is not exactly { address }", async () => {
    seedManager();
    for (const body of [
      { address: "wss://peers.test/psi", host: "elsewhere.test" },
      { host: "peers.test" },
      { address: "wss://peers.test/" + "a".repeat(2048) },
    ])
      expect((await putWebrtc(body)).status).toBe(400);
  });

  test("resolves a web app address through the server it publishes", async () => {
    seedManager();
    const app = await webApp(publishing("ws://signal.test:9000/api"));
    const put = await putWebrtc({ address: app });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      configured: true,
      host: "signal.test",
      port: 9000,
      path: "/api/",
      secure: false,
      webAppOrigin: new URL(app).origin,
      warnings: [SIGNALING_UNENCRYPTED_WARNING],
    });
  });

  test("a web app that publishes no server is a 400 saying what to type", async () => {
    seedManager();
    const app = await webApp((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    const put = await putWebrtc({ address: app });
    expect(put.status).toBe(400);
    const { error } = (await put.json()) as { error: string };
    expect(error).toContain("does not publish");
    expect(error).toMatch(
      /Type the coordination server's own wss:\/\/ address/,
    );
  });

  test("a web app that cannot be reached is a 502", async () => {
    seedManager();
    const app = await webApp(publishing("ws://signal.test/api/"));
    await servers.pop()!();
    const put = await putWebrtc({ address: app });
    expect(put.status).toBe(502);
    const { error } = (await put.json()) as { error: string };
    expect(error).toMatch(/^Could not read the coordination server address/);
  });

  test("a DELETE during the web app's read wins over the PUT", async () => {
    seedManager();
    let answer: (() => void) | undefined;
    const app = await webApp((_request, response) => {
      answer = () => publishing("ws://signal.test/api/")(_request, response);
    });
    const put = putWebrtc({ address: app });
    await vi.waitFor(() => expect(answer).toBeDefined());
    expect((await deleteWebrtc()).status).toBe(204);
    answer!();
    expect((await put).status).toBe(409);
    expect(await getWebrtc()).toEqual({ configured: false });
  });
});

describe("POST /api/jobs on the webrtc channel", () => {
  test("with no coordination server authored is an empty 400 leaving nothing on disk", async () => {
    const { manager, root } = seedManager();
    const response = await postJob(validWebrtcIntent());
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    expect(fs.readdirSync(root)).toEqual([]);
    expect(manager.occupiedSlotId()).toBeNull();
  });

  test("composes the authored server with the intent's side and no relay", async () => {
    const { manager, root } = seedManager();
    await manager.authorSignalingServer({ address: "wss://peers.test/psi" });
    const response = await postJob(validWebrtcIntent({ side: "acceptor" }));
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const composed = parseYaml(
      fs.readFileSync(`${root}/${id}/alcove.yaml`, "utf8"),
    ) as { connection: Record<string, unknown> };
    expect(composed.connection).toEqual({
      channel: "webrtc",
      server: { host: "peers.test", path: "/psi/" },
      role: "acceptor",
    });

    const handoff = manager.getJobHandoff(id);
    expect(handoff?.channel).toBe("webrtc");
    expect(handoff?.template.argv.slice(0, 2)).toEqual(["alcove", "exchange"]);
    expect(handoff?.template.kind).toBe("config");
    const template = handoff?.template as { yaml: string };
    expect(
      (parseYaml(template.yaml) as { connection: unknown }).connection,
    ).toEqual(composed.connection);
  });

  test("states secure: false for a ws:// server", async () => {
    const { manager, root } = seedManager();
    await manager.authorSignalingServer({ address: "ws://127.0.0.1:9000/" });
    const response = await postJob(validWebrtcIntent());
    const { id } = (await response.json()) as { id: string };
    const composed = parseYaml(
      fs.readFileSync(`${root}/${id}/alcove.yaml`, "utf8"),
    ) as { connection: { server: unknown } };
    expect(composed.connection.server).toEqual({
      host: "127.0.0.1",
      port: 9000,
      path: "/",
      secure: false,
    });
  });

  test.each([
    ["a server key", { server: { host: "elsewhere.test" } }],
    ["a stun key", { stun: ["stun:stun.test:3478"] }],
    ["no side", { side: undefined }],
    ["a file-sync option", { options: { pollIntervalMs: 1000 } }],
    [
      "a run of the opened configuration",
      { sharedSecret: undefined, mountedConfigurationOpened: true },
    ],
  ])("refuses an intent with %s", async (_, overrides) => {
    const { manager, root } = seedManager();
    await manager.authorSignalingServer({ address: "wss://peers.test/psi" });
    // A usable key file beside the configuration, so only the intent refuses.
    fs.writeFileSync(
      path.join(root, JOB_FILE_NAMES.key),
      JSON.stringify({ sharedSecret: VALID_SHARED_SECRET }),
    );
    const response = await postJob({ ...validWebrtcIntent(), ...overrides });
    expect(response.status).toBe(400);
    expect(fs.readdirSync(root)).toEqual([JOB_FILE_NAMES.key]);
  });
});
