import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";

import {
  WEB_APP_ADDRESS_REFUSED,
  getDefaultLinkageTerms,
  snakeizeKeys,
} from "@alcove/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  SIGNALING_ADDRESS_CREDENTIALS_REFUSED,
  SIGNALING_ADDRESS_SCHEME_REFUSED,
  SIGNALING_UNENCRYPTED_WARNING,
} from "@jobs/signalingServer";
import { JOB_FILE_NAMES } from "@jobContract/intentSchemas";
import { JobManager } from "@jobs/jobManager";

import { route as CreateRoute } from "../../../server/console/routes/index";
import { route as JobRoute } from "../../../server/console/routes/$jobId/index";
import { route as WebrtcRoute } from "../../../server/console/routes/webrtc";

import {
  STUB_CLI_PATH,
  TEST_SIGNALING_ADDRESS,
  TEST_SIGNALING_SERVER,
  VALID_SHARED_SECRET,
  tempDataRoot,
  validWebrtcIntent,
} from "../../utils/jobFixtures";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The relay an accepted invitation names. */
const INVITATION_RELAY = {
  turn: ["turn:relay.test:3478?transport=udp"],
  stun: ["stun:relay.test:3478"],
};

/** A relay other than {@link INVITATION_RELAY}. */
const OTHER_RELAY = { turn: ["turn:other.test"] };

/** The relay the operator sets for this console's own invitations. */
const OWN_RELAY = {
  turn: ["turns:own-relay.test:443?transport=tcp"],
  relayRegistrar: {
    url: "https://registrar.own-relay.test",
    exchangeId: "q3-linkage-7f2c",
  },
};

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

/** Seed the global manager the routes use, pointed at the stub CLI, which by
 * default waits without reaching a handshake. */
function seedManager(
  childEnv: Record<string, string> = {
    STUB_FD3_EVENTS: JSON.stringify([]),
    STUB_DELAY_MS: "5000",
  },
): { manager: JobManager; root: string } {
  const root = tempDataRoot("routes-webrtc");
  roots.push(root);
  fs.mkdirSync(root, { recursive: true });
  vi.stubEnv("JOB_DATA_ROOT", root);
  const manager = new JobManager({
    dataRoot: root,
    binaryPath: STUB_CLI_PATH,
    childEnv,
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
    ["a web app path", "https://app.test/accept", WEB_APP_ADDRESS_REFUSED],
    ["a web app fragment", "https://app.test/#token", WEB_APP_ADDRESS_REFUSED],
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

  test("holds an accepted invitation's relay beside the server, and a later PUT without one drops it", async () => {
    seedManager();
    const put = await putWebrtc({
      address: "wss://peers.test/psi",
      invitationRelay: INVITATION_RELAY,
    });
    expect(put.status).toBe(200);
    expect(await getWebrtc()).toMatchObject({
      host: "peers.test",
      invitationRelay: INVITATION_RELAY,
    });
    expect((await putWebrtc({ address: "wss://peers.test/psi" })).status).toBe(
      200,
    );
    expect(await getWebrtc()).not.toHaveProperty("invitationRelay");
  });

  test("holds the console's own relay beside the server, and a later PUT without one drops it", async () => {
    seedManager();
    const put = await putWebrtc({
      address: "wss://peers.test/psi",
      ownRelay: OWN_RELAY,
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ ownRelay: OWN_RELAY });
    expect(await getWebrtc()).toMatchObject({
      host: "peers.test",
      ownRelay: OWN_RELAY,
    });
    expect((await putWebrtc({ address: "wss://peers.test/psi" })).status).toBe(
      200,
    );
    expect(await getWebrtc()).not.toHaveProperty("ownRelay");
  });

  test("admits each turn url scheme and transport core's rule admits", async () => {
    seedManager();
    const turn = [
      "turn:relay.test",
      "turn:relay.test:3478?transport=udp",
      "turns:relay.test:443?transport=tcp",
      "  turns:padded.test:5349  ",
    ];
    expect(
      (await putWebrtc({ address: "wss://peers.test/psi", ownRelay: { turn } }))
        .status,
    ).toBe(200);
    expect(await getWebrtc()).toMatchObject({
      ownRelay: {
        turn: [
          "turn:relay.test",
          "turn:relay.test:3478?transport=udp",
          "turns:relay.test:443?transport=tcp",
          "turns:padded.test:5349",
        ],
      },
    });
  });

  test.each([
    ["a url that is not turn:", { turn: ["stun:relay.test:3478"] }, /turn:/],
    ["an https url", { turn: ["https://relay.test/"] }, /turn:/],
    [
      "a user before the host",
      { turn: ["turn:user:pass@relay.test"] },
      /names a user before its host/,
    ],
    [
      "a credential in the query",
      { turn: ["turn:relay.test?password=secret"] },
      /no query parameter other than transport/,
    ],
    [
      "udp on a turns: url",
      { turn: ["turns:relay.test?transport=udp"] },
      /tcp/,
    ],
    [
      "an entry holding a credential",
      {
        turn: [{ url: "turn:relay.test", username: "u", credential: "secret" }],
      },
      /The relay is refused/,
    ],
    [
      "a credential beside the urls",
      { ...OWN_RELAY, credential: "secret" },
      /has no key credential/,
    ],
    ["an empty list", { turn: [] }, /names no turn url/],
    [
      "more urls than an invitation names",
      { turn: Array.from({ length: 9 }, (_, i) => `turn:r${i}.test`) },
      /more than 8/,
    ],
    [
      "a registrar that is not https",
      {
        turn: ["turn:relay.test"],
        relayRegistrar: { url: "http://reg.test", exchangeId: "x1" },
      },
      /relay_registrar\.url must be an https/,
    ],
  ])(
    "refuses an own relay with %s, naming the rule and not the url",
    async (_, ownRelay, rule) => {
      seedManager();
      const response = await putWebrtc({
        address: "wss://peers.test/psi",
        ownRelay,
      });
      expect(response.status).toBe(400);
      const { error } = (await response.json()) as { error: string };
      expect(error).toMatch(rule);
      expect(error).not.toContain("secret");
      expect(error).not.toContain("pass@");
      expect(await getWebrtc()).toEqual({ configured: false });
    },
  );

  test.each([
    ["an empty relay", {}],
    ["a relay credential", { ...INVITATION_RELAY, username: "u" }],
    ["a url that is not turn:", { turn: ["https://relay.test/"] }],
    ["an empty list", { turn: [] }],
  ])("refuses an invitation relay with %s", async (_, invitationRelay) => {
    seedManager();
    expect(
      (await putWebrtc({ address: "wss://peers.test/psi", invitationRelay }))
        .status,
    ).toBe(400);
    expect(await getWebrtc()).toEqual({ configured: false });
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
    expect(error).toMatch(/^could not read the coordination server address/);
    expect(error).toMatch(
      /Type the coordination server's own wss:\/\/ address/,
    );
  });

  /** A web app that answers only when the returned `answer` is called. */
  async function heldWebApp(): Promise<{
    app: string;
    answered: () => Promise<() => void>;
  }> {
    let answer: (() => void) | undefined;
    const app = await webApp((_request, response) => {
      answer = () => publishing("ws://signal.test/api/")(_request, response);
    });
    return {
      app,
      answered: async () => {
        await vi.waitFor(() => expect(answer).toBeDefined());
        return answer!;
      },
    };
  }

  test("a refused PUT during the web app's read leaves the PUT to finish", async () => {
    seedManager();
    const { app, answered } = await heldWebApp();
    const put = putWebrtc({ address: app });
    const answer = await answered();
    expect((await putWebrtc({ address: "sftp://peers.test/" })).status).toBe(
      400,
    );
    answer();
    expect((await put).status).toBe(200);
    expect(await getWebrtc()).toMatchObject({
      host: "signal.test",
      webAppOrigin: new URL(app).origin,
    });
  });

  test("a later PUT during the web app's read wins over the PUT", async () => {
    seedManager();
    const { app, answered } = await heldWebApp();
    const put = putWebrtc({ address: app });
    const answer = await answered();
    expect((await putWebrtc({ address: "wss://later.test/psi" })).status).toBe(
      200,
    );
    answer();
    expect((await put).status).toBe(409);
    expect(await getWebrtc()).toMatchObject({ host: "later.test" });
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
  test("with no coordination server authored or named is an empty 400 leaving nothing on disk", async () => {
    const { manager, root } = seedManager();
    const response = await postJob(
      validWebrtcIntent({ signalingServer: undefined }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    expect(fs.readdirSync(root)).toEqual([]);
    expect(manager.occupiedSlotId()).toBeNull();
  });

  test.each([
    ["another server", { host: "elsewhere.test", path: "/psi/" }, true],
    ["another port", { host: "peers.test", port: 8443, path: "/psi/" }, true],
    ["another path", { host: "peers.test", path: "/" }, true],
    ["no server", undefined, true],
    ["a server while the console holds none", TEST_SIGNALING_SERVER, false],
  ])(
    "refuses an invitation naming %s, leaving nothing on disk",
    async (_, signalingServer, authored) => {
      const { manager, root } = seedManager();
      if (authored)
        await manager.authorSignalingServer({
          address: TEST_SIGNALING_ADDRESS,
        });
      const response = await postJob(validWebrtcIntent({ signalingServer }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        reason: "coordination-server-changed",
      });
      expect(fs.readdirSync(root)).toEqual([]);
      expect(manager.occupiedSlotId()).toBeNull();
    },
  );

  test("composes the authored server with the intent's side and no relay", async () => {
    const { manager, root } = seedManager();
    await manager.authorSignalingServer({ address: "wss://peers.test/psi" });
    const response = await postJob(validWebrtcIntent({ side: "acceptor" }));
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const composed = parseYaml(
      fs.readFileSync(`${root}/alcove.yaml`, "utf8"),
    ) as { connection: Record<string, unknown> };
    expect(composed.connection).toEqual({
      channel: "webrtc",
      server: { host: "peers.test", path: "/psi/" },
      role: "acceptor",
    });

    const handoff = manager.getJobHandoff(id);
    expect(handoff?.channel).toBe("webrtc");
    expect(handoff?.template.argv.slice(0, 2)).toEqual(["alcove", "exchange"]);
    expect(handoff?.template.kind).toBe("workingFolder");
    expect(handoff?.template).not.toHaveProperty("yaml");
  });

  test("composes an acceptor's run with the accepted invitation's relay, as alcove accept writes it", async () => {
    const { manager, root } = seedManager();
    await manager.authorSignalingServer({
      address: TEST_SIGNALING_ADDRESS,
      invitationRelay: INVITATION_RELAY,
    });
    const response = await postJob(
      validWebrtcIntent({
        side: "acceptor",
        signalingServer: { ...TEST_SIGNALING_SERVER, relay: INVITATION_RELAY },
      }),
    );
    expect(response.status).toBe(201);
    const composed = parseYaml(
      fs.readFileSync(`${root}/alcove.yaml`, "utf8"),
    ) as { connection: Record<string, unknown> };
    expect(composed.connection).toEqual({
      channel: "webrtc",
      server: { host: "peers.test", path: "/psi/" },
      role: "acceptor",
      invitation_relay: INVITATION_RELAY,
    });
  });

  test("composes an inviter's run with the console's own relay as url-only turn entries and its registrar", async () => {
    const { manager, root } = seedManager();
    await manager.authorSignalingServer({
      address: TEST_SIGNALING_ADDRESS,
      ownRelay: OWN_RELAY,
    });
    const response = await postJob(
      validWebrtcIntent({
        signalingServer: {
          ...TEST_SIGNALING_SERVER,
          relay: { turn: OWN_RELAY.turn },
        },
      }),
    );
    expect(response.status).toBe(201);
    const composed = parseYaml(
      fs.readFileSync(`${root}/alcove.yaml`, "utf8"),
    ) as { connection: Record<string, unknown> };
    expect(composed.connection).toEqual({
      channel: "webrtc",
      server: { host: "peers.test", path: "/psi/" },
      role: "inviter",
      turn: [{ url: "turns:own-relay.test:443?transport=tcp" }],
      relay_registrar: {
        url: "https://registrar.own-relay.test",
        exchange_id: "q3-linkage-7f2c",
      },
    });
  });

  test("composes no own relay for an acceptor's run", async () => {
    const { manager, root } = seedManager();
    await manager.authorSignalingServer({
      address: TEST_SIGNALING_ADDRESS,
      ownRelay: OWN_RELAY,
    });
    expect(
      (await postJob(validWebrtcIntent({ side: "acceptor" }))).status,
    ).toBe(201);
    const composed = parseYaml(
      fs.readFileSync(`${root}/alcove.yaml`, "utf8"),
    ) as { connection: Record<string, unknown> };
    expect(composed.connection).not.toHaveProperty("turn");
    expect(composed.connection).not.toHaveProperty("relay_registrar");
  });

  test.each([
    ["names no relay while one is set", undefined],
    ["names another relay", OTHER_RELAY],
    ["names the relay's registrar too", OWN_RELAY],
  ] as const)(
    "refuses an inviter whose invitation %s, leaving nothing on disk",
    async (_, relay) => {
      const { manager, root } = seedManager();
      await manager.authorSignalingServer({
        address: TEST_SIGNALING_ADDRESS,
        ownRelay: OWN_RELAY,
      });
      const response = await postJob(
        validWebrtcIntent({
          signalingServer: {
            ...TEST_SIGNALING_SERVER,
            ...(relay !== undefined ? { relay } : {}),
          },
        }),
      );
      expect(response.status).toBe(400);
      expect(fs.readdirSync(root)).toEqual([]);
    },
  );

  test("composes no relay for an inviter's run while the console holds an accepted one", async () => {
    const { manager, root } = seedManager();
    await manager.authorSignalingServer({
      address: TEST_SIGNALING_ADDRESS,
      invitationRelay: INVITATION_RELAY,
    });
    expect((await postJob(validWebrtcIntent())).status).toBe(201);
    const composed = parseYaml(
      fs.readFileSync(`${root}/alcove.yaml`, "utf8"),
    ) as { connection: Record<string, unknown> };
    expect(composed.connection).not.toHaveProperty("invitation_relay");
  });

  test.each([
    [
      "an acceptor naming no relay while one is held",
      "acceptor",
      undefined,
      true,
    ],
    ["an acceptor naming another relay", "acceptor", OTHER_RELAY, true],
    [
      "an acceptor naming a relay while none is held",
      "acceptor",
      INVITATION_RELAY,
      false,
    ],
    ["an inviter naming a relay", "inviter", INVITATION_RELAY, true],
  ] as const)(
    "refuses %s, leaving nothing on disk",
    async (_, side, relay, held) => {
      const { manager, root } = seedManager();
      await manager.authorSignalingServer({
        address: TEST_SIGNALING_ADDRESS,
        ...(held ? { invitationRelay: INVITATION_RELAY } : {}),
      });
      const response = await postJob(
        validWebrtcIntent({
          side,
          signalingServer: {
            ...TEST_SIGNALING_SERVER,
            ...(relay !== undefined ? { relay } : {}),
          },
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        reason: "coordination-server-changed",
      });
      expect(fs.readdirSync(root)).toEqual([]);
    },
  );

  test("a run of an opened configuration stating a relay runs it in place", async () => {
    const { manager, root } = seedManager();
    await manager.authorSignalingServer({ address: TEST_SIGNALING_ADDRESS });
    const relayed = stringifyYaml({
      connection: {
        channel: "webrtc",
        role: "inviter",
        server: { host: "elsewhere.test", path: "/psi/" },
        turn: [{ url: "turns:relay.example.org:5349" }],
        relay_registrar: {
          url: "https://registrar.example.org",
          exchange_id: "q3-linkage-7f2c",
        },
        ice_transport_policy: "relay",
      },
      linkage_terms: snakeizeKeys(getDefaultLinkageTerms("County Health")),
    });
    fs.writeFileSync(
      path.join(root, JOB_FILE_NAMES.key),
      JSON.stringify({ sharedSecret: VALID_SHARED_SECRET }),
    );
    fs.writeFileSync(path.join(root, JOB_FILE_NAMES.config), relayed);
    const admitted = await postJob(
      validWebrtcIntent({
        sharedSecret: undefined,
        mountedConfigurationOpened: true,
      }),
    );
    expect(admitted.status).toBe(201);
    expect(
      fs.readFileSync(path.join(root, JOB_FILE_NAMES.config), "utf8"),
    ).toBe(relayed);
  });

  test("a run of an opened configuration on another channel is refused with its token", async () => {
    const { manager, root } = seedManager();
    await manager.authorSignalingServer({ address: TEST_SIGNALING_ADDRESS });
    fs.writeFileSync(
      path.join(root, JOB_FILE_NAMES.key),
      JSON.stringify({ sharedSecret: VALID_SHARED_SECRET }),
    );
    fs.writeFileSync(
      path.join(root, JOB_FILE_NAMES.config),
      stringifyYaml({
        connection: { channel: "filedrop", path: "/data/rendezvous" },
        linkage_terms: snakeizeKeys(getDefaultLinkageTerms("County Health")),
      }),
    );
    const refused = await postJob(
      validWebrtcIntent({
        sharedSecret: undefined,
        mountedConfigurationOpened: true,
      }),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      reason: "opened-configuration-not-runnable",
    });
  });

  test("takes the scheme's default port and a path without its slash as the held server's", async () => {
    const { manager } = seedManager();
    await manager.authorSignalingServer({ address: TEST_SIGNALING_ADDRESS });
    const response = await postJob(
      validWebrtcIntent({
        signalingServer: { host: "peers.test", port: 443, path: "/psi" },
      }),
    );
    expect(response.status).toBe(201);
  });

  test("states secure: false for a ws:// server", async () => {
    const { manager, root } = seedManager();
    await manager.authorSignalingServer({ address: "ws://127.0.0.1:9000/" });
    const response = await postJob(
      validWebrtcIntent({
        signalingServer: { host: "127.0.0.1", port: 9000, path: "/" },
      }),
    );
    expect(response.status).toBe(201);
    const composed = parseYaml(
      fs.readFileSync(`${root}/alcove.yaml`, "utf8"),
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

describe("POST /api/jobs on the webrtc channel and the working folder's files", () => {
  test("writes alcove.yaml and .alcove.key into the working folder when the run starts", async () => {
    const { manager, root } = seedManager();
    await manager.authorSignalingServer({ address: TEST_SIGNALING_ADDRESS });
    const response = await postJob(validWebrtcIntent());
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    expect(fs.readdirSync(root).sort()).toEqual(
      [JOB_FILE_NAMES.config, JOB_FILE_NAMES.key, id].sort(),
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(root, JOB_FILE_NAMES.key), "utf8")),
    ).toEqual({ sharedSecret: VALID_SHARED_SECRET });
    // Written as alcove invite writes it, guidance comments included.
    expect(
      fs.readFileSync(path.join(root, JOB_FILE_NAMES.config), "utf8"),
    ).toMatch(/^#/m);
    expect(fs.readdirSync(path.join(root, id))).not.toContain(
      JOB_FILE_NAMES.key,
    );
    expect(manager.getJobHandoff(id)?.keyFileBesideConfiguration).toBe(true);
  });

  test.each([JOB_FILE_NAMES.config, JOB_FILE_NAMES.key])(
    "refuses with the reason alone when %s is already there",
    async (name) => {
      const { manager, root } = seedManager();
      await manager.authorSignalingServer({ address: TEST_SIGNALING_ADDRESS });
      fs.writeFileSync(path.join(root, name), "another exchange's file\n");
      const response = await postJob(validWebrtcIntent());
      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        JSON.stringify({ reason: "working-folder-configuration-present" }),
      );
      expect(fs.readdirSync(root)).toEqual([name]);
      expect(fs.readFileSync(path.join(root, name), "utf8")).toBe(
        "another exchange's file\n",
      );
      expect(manager.occupiedSlotId()).toBeNull();
    },
  );

  test("refuses a fresh invitation over the files an earlier exchange on this console left", async () => {
    const { manager, root } = seedManager({
      STUB_KEY_FILE: JSON.stringify({ sharedSecret: "C".repeat(42) + "A" }),
      STUB_FD3_EVENTS: JSON.stringify([
        { v: 1, type: "stage", id: "confirming protocol", label: "Confirming" },
        { v: 1, type: "error", category: "exchange", message: "dropped" },
      ]),
      STUB_EXIT_CODE: "69",
    });
    await manager.authorSignalingServer({ address: TEST_SIGNALING_ADDRESS });
    const first = await postJob(validWebrtcIntent());
    const { id } = (await first.json()) as { id: string };
    await vi.waitFor(() => expect(manager.getJob(id)?.terminal).not.toBeNull());
    await manager.deleteJob(id);
    await vi.waitFor(() => expect(manager.occupiedSlotId()).toBeNull());
    expect(fs.existsSync(path.join(root, JOB_FILE_NAMES.key))).toBe(true);

    const fresh = await postJob(
      validWebrtcIntent({ sharedSecret: "B".repeat(42) + "A" }),
    );
    expect(fresh.status).toBe(400);
    expect(await fresh.text()).toBe(
      JSON.stringify({ reason: "working-folder-console-exchange" }),
    );
  });

  test.skipIf(process.getuid?.() === 0)(
    "a working folder that refuses the write is a 500 naming the reason alone, leaving nothing behind",
    async () => {
      const { manager, root } = seedManager();
      await manager.authorSignalingServer({ address: TEST_SIGNALING_ADDRESS });
      fs.chmodSync(root, 0o500);
      try {
        const response = await postJob(validWebrtcIntent());
        expect(response.status).toBe(500);
        expect(await response.text()).toBe(
          JSON.stringify({ reason: "working-folder-unwritable" }),
        );
        expect(fs.readdirSync(root)).toEqual([]);
        expect(manager.occupiedSlotId()).toBeNull();
      } finally {
        fs.chmodSync(root, 0o700);
      }
    },
  );

  test("a run discarded while it waits takes its unchanged files, so a retry writes them again", async () => {
    const { manager, root } = seedManager();
    await manager.authorSignalingServer({ address: TEST_SIGNALING_ADDRESS });
    const first = await postJob(validWebrtcIntent());
    const { id } = (await first.json()) as { id: string };
    await manager.deleteJob(id);
    await vi.waitFor(() => expect(manager.occupiedSlotId()).toBeNull());
    expect(fs.readdirSync(root)).toEqual([]);
    const retry = await postJob(validWebrtcIntent());
    expect(retry.status).toBe(201);
    const { id: retryId } = (await retry.json()) as { id: string };
    expect(fs.readdirSync(root).sort()).toEqual(
      [JOB_FILE_NAMES.config, JOB_FILE_NAMES.key, retryId].sort(),
    );
  });
});

describe("DELETE /api/jobs/:jobId on the webrtc channel", () => {
  test("keeps the authored coordination server for the next create", async () => {
    seedManager();
    expect((await putWebrtc({ address: "wss://peers.test/psi" })).status).toBe(
      200,
    );
    const created = await postJob(validWebrtcIntent());
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(await getWebrtc()).toMatchObject({ configured: true });

    const deleted = (await handler(
      JobRoute,
      "DELETE",
    )({
      request: request(`http://localhost/api/jobs/${id}`, {
        method: "DELETE",
      }),
      params: { jobId: id },
    })) as Response;
    expect(deleted.status).toBe(204);
    expect(await getWebrtc()).toMatchObject({
      configured: true,
      host: "peers.test",
    });
  });
});
