import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { snakeizeKeys } from "@alcove/core";

import { JobManager } from "@jobs/jobManager";

import { route as RelayCheckRoute } from "../../../server/console/routes/relay-check";

import {
  STUB_CLI_PATH,
  VALID_SHARED_SECRET,
  tempDataRoot,
  validLinkageTerms,
} from "../../utils/jobFixtures";

type Handler = (ctx: {
  request: Request;
  params: Record<string, string>;
}) => unknown;

const roots: Array<string> = [];

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
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Seed the global manager over a working folder holding a webrtc pair, whose
 * connection has `connection` added, and return the folder.
 */
function seedManager(
  childEnv: Record<string, string> = {},
  connection: Record<string, unknown> = {},
): string {
  const root = tempDataRoot("routes-relay-check");
  roots.push(root);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "alcove.yaml"),
    stringifyYaml(
      snakeizeKeys({
        connection: {
          channel: "webrtc",
          server: { host: "peers.example.org" },
          role: "inviter",
          turn: [{ url: "turn:relay.example.org:3478" }],
          ...connection,
        },
        linkageTerms: validLinkageTerms(),
      }),
    ),
  );
  fs.writeFileSync(
    path.join(root, ".alcove.key"),
    JSON.stringify({ sharedSecret: VALID_SHARED_SECRET }),
    { mode: 0o600 },
  );
  vi.stubEnv("JOB_DATA_ROOT", root);
  (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
    new JobManager({ dataRoot: root, binaryPath: STUB_CLI_PATH, childEnv });
  return root;
}

function handler(method: "GET" | "POST"): Handler {
  return (RelayCheckRoute.handlers as Record<string, Handler>)[method];
}

function request(init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("host", "localhost");
  return new Request("http://localhost/api/jobs/relay-check", {
    ...init,
    headers,
  });
}

async function getOffer(): Promise<Record<string, unknown>> {
  const response = (await handler("GET")({
    request: request(),
    params: {},
  })) as Response;
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function postCheck(body: string): Promise<Response> {
  return (await handler("POST")({
    request: request({
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
    params: {},
  })) as Response;
}

describe("/api/jobs/relay-check", () => {
  test("GET states the hosts and the digest a start names", async () => {
    seedManager();
    const offer = await getOffer();

    expect(offer).toMatchObject({
      status: "available",
      statement: {
        contacted: [{ host: "turn:relay.example.org:3478" }],
      },
    });
    expect(offer.configurationDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("POST runs the check and answers the verdict", async () => {
    seedManager();
    const { configurationDigest } = await getOffer();

    const response = await postCheck(JSON.stringify({ configurationDigest }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "verdict",
      overall: "ok",
      checks: [{ id: "turn_1", status: "ok" }],
    });
  });

  test.each([
    ["a digest that is not one", JSON.stringify({ configurationDigest: "x" })],
    [
      "a key the body does not hold",
      JSON.stringify({ configurationDigest: "0".repeat(64), url: "turn:x" }),
    ],
    ["a body that is not JSON", "{"],
  ])("POST with %s is a 400 with no body", async (_label, body) => {
    seedManager();
    const response = await postCheck(body);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });

  test("POST with a digest of another file is configuration-changed", async () => {
    seedManager();
    const response = await postCheck(
      JSON.stringify({ configurationDigest: "0".repeat(64) }),
    );
    expect(await response.json()).toEqual({ status: "configuration-changed" });
  });

  test("GET states a WebSocket relay among the hosts the check contacts", async () => {
    seedManager({}, { websocketRelay: "wss://relay.example.org/relay" });
    const offer = await getOffer();

    expect(offer).toMatchObject({
      status: "available",
      statement: {
        contacted: [
          { host: "turn:relay.example.org:3478" },
          { host: "wss://relay.example.org/relay" },
        ],
      },
    });
  });

  test("POST over a pair become unavailable answers the reason alone", async () => {
    const root = seedManager(
      {},
      { websocketRelay: "wss://relay.example.org/relay" },
    );
    const { configurationDigest } = await getOffer();
    fs.rmSync(path.join(root, ".alcove.key"));

    const response = await postCheck(JSON.stringify({ configurationDigest }));

    expect(await response.json()).toEqual({
      status: "unavailable",
      reason: "key-file",
    });
  });

  test("POST while a check runs is a 409 with no body", async () => {
    seedManager({ STUB_DELAY_MS: "400" });
    const { configurationDigest } = await getOffer();
    const body = JSON.stringify({ configurationDigest });

    const first = postCheck(body);
    const second = await postCheck(body);

    expect(second.status).toBe(409);
    expect(await second.text()).toBe("");
    expect((await first).status).toBe(200);
  });
});
