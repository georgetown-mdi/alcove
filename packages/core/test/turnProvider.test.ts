import { describe, expect, test } from "vitest";

import {
  CLOUDFLARE_TURN_HOST,
  PROVIDER_TURN_CREDENTIAL_TTL_SECONDS,
  isKeptProviderTurnUrl,
  mintProviderTurnCredential,
  providerTurnEntryToMint,
  providerTurnServersFromAnswer,
  turnProviderMintRequest,
} from "../src/turnProvider";
import { RELAY_CREDENTIAL_MAX_TTL_SECONDS } from "../src/relayCredential";
import { endpointFromConnection } from "../src/config/endpointProducer";
import {
  hasMintedTurnEntry,
  safeParseConnectionConfig,
} from "../src/config/connection";
import type {
  TurnProviderEntry,
  WebRTCConnectionConfig,
} from "../src/config/connection";

const TOKEN = "placeholder-turn-api-token-0000";
const ENTRY: TurnProviderEntry = {
  provider: "cloudflare",
  keyId: "0123456789abcdef0123456789abcdef",
  apiToken: TOKEN,
};

const ANSWER = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "minted-username",
      credential: "minted-credential",
    },
  ],
};

function answering(
  status: number,
  body: string,
  calls: Array<{ url: string; init: RequestInit }> = [],
): typeof globalThis.fetch {
  return async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  };
}

describe("the minting request", () => {
  test("names the key id in the path, sends the token as the bearer, and sets the ttl", () => {
    const request = turnProviderMintRequest(ENTRY);
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "https://rtc.live.cloudflare.com/v1/turn/keys/" +
        "0123456789abcdef0123456789abcdef/credentials/generate-ice-servers",
    );
    expect(request.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(request.body) as { ttl: number };
    expect(body.ttl).toBe(PROVIDER_TURN_CREDENTIAL_TTL_SECONDS);
    expect(body.ttl).toBeGreaterThanOrEqual(60);
    expect(body.ttl).toBeLessThanOrEqual(RELAY_CREDENTIAL_MAX_TTL_SECONDS);
    expect(RELAY_CREDENTIAL_MAX_TTL_SECONDS).toBe(3600);
  });

  test("the token appears in the header alone", () => {
    const request = turnProviderMintRequest(ENTRY);
    expect(request.url).not.toContain(TOKEN);
    expect(request.body).not.toContain(TOKEN);
  });
});

describe("which provider entry a run mints", () => {
  const STATIC = { url: "turns:relay.example.org:443" };
  const SECOND: TurnProviderEntry = { ...ENTRY, keyId: "second-key" };

  test.each<
    [
      string,
      Pick<WebRTCConnectionConfig, "turn" | "allowedRelays">,
      TurnProviderEntry | undefined,
    ]
  >([
    ["the first entry", { turn: [ENTRY, SECOND] }, ENTRY],
    ["none after a kept static entry", { turn: [STATIC, ENTRY] }, undefined],
    [
      "the first after a static entry allowed_relays leaves out",
      { turn: [STATIC, ENTRY], allowedRelays: ["turn.cloudflare.com:5349"] },
      ENTRY,
    ],
    [
      "none where allowed_relays leaves out Cloudflare's host",
      { turn: [ENTRY, STATIC], allowedRelays: ["relay.example.org"] },
      undefined,
    ],
    ["none for a connection with no turn entry", {}, undefined],
  ])("%s", (_label, connection, expected) => {
    expect(providerTurnEntryToMint(connection)).toBe(expected);
  });
});

describe("which urls an answer yields", () => {
  test("keeps only turns: urls on Cloudflare's host, port 443 first", () => {
    expect(providerTurnServersFromAnswer(ANSWER)).toEqual([
      {
        url: "turns:turn.cloudflare.com:443?transport=tcp",
        username: "minted-username",
        credential: "minted-credential",
      },
      {
        url: "turns:turn.cloudflare.com:5349?transport=tcp",
        username: "minted-username",
        credential: "minted-credential",
      },
    ]);
  });

  test.each([
    ["turn: on the host", "turn:turn.cloudflare.com:3478?transport=tcp"],
    ["turns: on another host", "turns:relay.example.org:443?transport=tcp"],
    ["turns: on a lookalike host", "turns:turn.cloudflare.com.example.org:443"],
    ["turns: on a subdomain", "turns:eu.turn.cloudflare.com:443"],
    ["a user before the host", "turns:u@turn.cloudflare.com:443"],
    ["udp on turns:", "turns:turn.cloudflare.com:443?transport=udp"],
    ["stun:", "stun:stun.cloudflare.com:3478"],
  ])("drops %s", (_label, url) => {
    expect(isKeptProviderTurnUrl(url)).toBe(false);
  });

  test("keeps the host however its case is written", () => {
    expect(isKeptProviderTurnUrl("turns:TURN.cloudflare.com:443")).toBe(true);
    expect(CLOUDFLARE_TURN_HOST).toBe("turn.cloudflare.com");
  });

  test("reads one ICE server as readily as a list, and lists a url once", () => {
    expect(
      providerTurnServersFromAnswer({
        iceServers: {
          urls: [
            "turns:turn.cloudflare.com:443?transport=tcp",
            "turns:turn.cloudflare.com:443?transport=tcp",
          ],
          username: "u",
          credential: "c",
        },
      }),
    ).toEqual([
      {
        url: "turns:turn.cloudflare.com:443?transport=tcp",
        username: "u",
        credential: "c",
      },
    ]);
  });

  test.each([
    ["not an object", "nope"],
    ["null", null],
    ["no iceServers", {}],
    ["an empty list", { iceServers: [] }],
    ["a list holding a string", { iceServers: ["turns:x"] }],
  ])("is not a list of ICE servers when it is %s", (_label, answer) => {
    expect(providerTurnServersFromAnswer(answer)).toBeUndefined();
  });

  test("yields nothing from a kept url with no credential", () => {
    expect(
      providerTurnServersFromAnswer({
        iceServers: [{ urls: "turns:turn.cloudflare.com:443" }],
      }),
    ).toEqual([]);
  });
});

describe("a mint against a stubbed API", () => {
  const now = new Date("2026-11-11T12:00:00Z");

  test("sends the request built and yields the kept servers, expiring one ttl after it was sent", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const outcome = await mintProviderTurnCredential(ENTRY, {
      fetch: answering(201, JSON.stringify(ANSWER), calls),
      now: () => now,
    });
    expect(outcome.kind).toBe("minted");
    if (outcome.kind !== "minted") return;
    expect(outcome.servers.map((server) => server.url)).toEqual([
      "turns:turn.cloudflare.com:443?transport=tcp",
      "turns:turn.cloudflare.com:5349?transport=tcp",
    ]);
    expect(outcome.expiresAt.getTime() - now.getTime()).toBe(3600 * 1000);
    expect(calls).toHaveLength(1);
    const request = turnProviderMintRequest(ENTRY);
    expect(calls[0]?.url).toBe(request.url);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.init.headers).toEqual(request.headers);
    expect(calls[0]?.init.body).toBe(request.body);
  });

  test.each([400, 401, 403, 404, 429, 500, 302])(
    "a %i answer is a refusal stating the status alone",
    async (status) => {
      const outcome = await mintProviderTurnCredential(ENTRY, {
        fetch: answering(status, `{"error":"bad token ${TOKEN}"}`),
      });
      expect(outcome).toEqual({ kind: "refused", status });
    },
  );

  test.each([
    ["a body that is not JSON", "<html>"],
    ["a body with no ICE servers", "{}"],
  ])("%s is malformed", async (_label, body) => {
    const outcome = await mintProviderTurnCredential(ENTRY, {
      fetch: answering(201, body),
    });
    expect(outcome).toEqual({ kind: "malformed", problem: "not-ice-servers" });
  });

  test("an answer listing no kept url is malformed", async () => {
    const outcome = await mintProviderTurnCredential(ENTRY, {
      fetch: answering(
        201,
        JSON.stringify({
          iceServers: [
            {
              urls: ["turn:turn.cloudflare.com:3478"],
              username: "u",
              credential: "c",
            },
          ],
        }),
      ),
    });
    expect(outcome).toEqual({ kind: "malformed", problem: "no-kept-url" });
  });

  test("an oversized answer is malformed", async () => {
    const outcome = await mintProviderTurnCredential(ENTRY, {
      fetch: answering(
        201,
        JSON.stringify({ ...ANSWER, padding: "x".repeat(32 * 1024) }),
      ),
    });
    expect(outcome).toEqual({ kind: "malformed", problem: "not-ice-servers" });
  });

  test("a network failure is unreachable, without the failure's text", async () => {
    const outcome = await mintProviderTurnCredential(ENTRY, {
      fetch: async () => {
        throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
      },
    });
    expect(outcome).toEqual({ kind: "unreachable", reason: "network" });
  });

  test("no answer within the timeout is unreachable by timeout", async () => {
    const outcome = await mintProviderTurnCredential(ENTRY, {
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    expect(outcome).toEqual({ kind: "unreachable", reason: "timeout" });
  });
});

describe("the provider form of a turn entry", () => {
  const base = {
    channel: "webrtc",
    server: { host: "peers.example.org" },
    role: "inviter",
  };
  const provider = {
    provider: "cloudflare",
    keyId: "0123456789abcdef0123456789abcdef",
    apiToken: "@/run/secrets/turn-api-token",
  };

  test("parses beside a server entry, in its place", () => {
    const result = safeParseConnectionConfig({
      ...base,
      turn: [provider, { url: "turns:relay.example.org:443" }],
    });
    expect(result.success).toBe(true);
    if (!result.success || result.data.channel !== "webrtc") return;
    expect(result.data.turn?.[0]).toEqual(provider);
  });

  test.each([
    [
      "username and credential",
      { username: "u", credential: "c" },
      "username, credential",
    ],
    ["a url", { url: "turns:turn.cloudflare.com:443" }, "url"],
    ["credential_type", { credentialType: "password" }, "credential_type"],
  ])("refuses %s beside it", (_label, extra, named) => {
    const result = safeParseConnectionConfig({
      ...base,
      turn: [{ ...provider, ...extra }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = result.error.issues.map((issue) => issue.message).join();
    expect(message).toContain("takes its url and credential from the provider");
    expect(message).toContain(`remove ${named}`);
  });

  test("refuses a provider not on the list", () => {
    const result = safeParseConnectionConfig({
      ...base,
      turn: [{ ...provider, provider: "elsewhere" }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toBe(
      "a turn entry's provider is one of cloudflare",
    );
  });

  test.each(["../x", "a/b", "", "a?b"])(
    "refuses the key id %j, named in a request path",
    (keyId) => {
      const result = safeParseConnectionConfig({
        ...base,
        turn: [{ ...provider, keyId }],
      });
      expect(result.success).toBe(false);
    },
  );

  test("is not an entry whose credential is minted from the shared secret", () => {
    const result = safeParseConnectionConfig({
      ...base,
      turn: [provider],
      relayRegistrar: {
        url: "https://registrar.example.org",
        exchangeId: "0123456789abcdef0123456789abcdef",
      },
    });
    expect(result.success).toBe(false);
    expect(hasMintedTurnEntry([{ ...provider, provider: "cloudflare" }])).toBe(
      false,
    );
  });

  test("is left out of the invitation, as a static entry is", () => {
    const result = safeParseConnectionConfig({
      ...base,
      turn: [provider, { url: "turns:relay.example.org:443" }],
    });
    if (!result.success || result.data.channel !== "webrtc")
      throw new Error("the connection did not parse");
    const endpoint = endpointFromConnection(result.data);
    expect(endpoint.channel === "webrtc" && endpoint.relay?.turn).toEqual([
      "turns:relay.example.org:443",
    ]);
    expect(JSON.stringify(endpoint)).not.toContain("cloudflare");
    expect(JSON.stringify(endpoint)).not.toContain("turn-api-token");
  });
});
