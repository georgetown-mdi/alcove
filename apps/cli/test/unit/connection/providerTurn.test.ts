import { describe, expect, test } from "vitest";

import {
  ConnectionError,
  UsageError,
  generateSharedSecret,
  sanitizeErrorForDisplay,
  statesItsOwnNextStep,
} from "@alcove/core";
import type { TurnProviderEntry, WebRTCConnectionConfig } from "@alcove/core";

import {
  PROVIDER_TURN_ATTEMPT_LIFETIME_MS,
  mintProviderTurn,
  providerTurnMintError,
  providerTurnNotice,
  providerTurnPerAttempt,
} from "../../../src/connection/webrtc/providerTurn";
import { buildErrorEvent } from "../../../src/eventStream";
import {
  webRtcDialFrom,
  webRtcDialWithProviderTurn,
} from "../../../src/run/prepare";
import { exitCodeForError } from "../../../src/util/exit";

const TOKEN = "placeholder-turn-api-token-1111";
const PROVIDER: TurnProviderEntry = {
  provider: "cloudflare",
  keyId: "0123456789abcdef0123456789abcdef",
  apiToken: TOKEN,
};

const STATIC_ENTRY = {
  url: "turns:relay.example.org:443",
  username: "static-user",
  credential: "static-credential",
};

const CONNECTION: WebRTCConnectionConfig = {
  channel: "webrtc",
  server: { host: "peers.example.org" },
  role: "inviter",
  turn: [PROVIDER, STATIC_ENTRY],
};

function answer(credential: string): string {
  return JSON.stringify({
    iceServers: [
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turns:turn.cloudflare.com:5349?transport=tcp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: `user-${credential}`,
        credential,
      },
    ],
  });
}

/** A stubbed minting API answering each call with the next credential. */
function stubbedApi(status = 201) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(answer(`minted-${calls.length}`), { status });
  };
  return { calls, fetch };
}

describe("minting a run's provider entries", () => {
  test("puts the kept servers in the entry's place and leaves the rest", async () => {
    const api = stubbedApi();
    const run = await mintProviderTurn(CONNECTION, {
      fetch: api.fetch,
      now: () => new Date("2026-11-11T12:00:00Z"),
    });
    expect(run?.connection.turn).toEqual([
      {
        url: "turns:turn.cloudflare.com:443?transport=tcp",
        username: "user-minted-1",
        credential: "minted-1",
      },
      {
        url: "turns:turn.cloudflare.com:5349?transport=tcp",
        username: "user-minted-1",
        credential: "minted-1",
      },
      STATIC_ENTRY,
    ]);
    expect(run?.expiresAt.toISOString()).toBe("2026-11-11T13:00:00.000Z");
    expect(api.calls).toHaveLength(1);
    const sent = JSON.parse(String(api.calls[0]?.init.body)) as { ttl: number };
    expect(sent.ttl).toBeLessThanOrEqual(3600);
    expect(api.calls[0]?.url).toContain(`/keys/${PROVIDER.keyId}/`);
    expect(
      (api.calls[0]?.init.headers as Record<string, string>)["Authorization"],
    ).toBe(`Bearer ${TOKEN}`);
  });

  test("mints nothing for a connection with no provider entry", async () => {
    const api = stubbedApi();
    expect(
      await mintProviderTurn(
        { ...CONNECTION, turn: [{ url: "turns:relay.example.org:443" }] },
        { fetch: api.fetch },
      ),
    ).toBeUndefined();
    expect(api.calls).toHaveLength(0);
  });

  test("the run's notice states the expiry and no credential", async () => {
    const run = await mintProviderTurn(CONNECTION, {
      fetch: stubbedApi().fetch,
    });
    if (run === undefined) throw new Error("nothing minted");
    const notice = providerTurnNotice(run);
    expect(notice).toMatch(/^the Cloudflare TURN credential was minted/);
    expect(notice).toContain(run.expiresAt.toISOString());
    expect(notice).not.toContain("minted-1");
    expect(notice).not.toContain(TOKEN);
  });
});

describe("a mint that fails", () => {
  test.each([
    [401, UsageError, "api_token"],
    [403, UsageError, "api_token"],
    [404, UsageError, "key_id"],
    [429, ConnectionError, "again later"],
    [503, ConnectionError, "again later"],
  ])(
    "a %i answer names the provider and the status",
    async (status, errorClass, nextStep) => {
      const failure = await mintProviderTurn(CONNECTION, {
        fetch: stubbedApi(status).fetch,
      }).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(errorClass);
      const message = (failure as Error).message;
      expect(message).toContain("Cloudflare did not mint a TURN credential");
      expect(message).toContain(`HTTP ${status}`);
      expect(message).toContain(nextStep);
      expect(statesItsOwnNextStep(failure)).toBe(true);
    },
  );

  test("a malformed answer is a transport failure naming the provider", async () => {
    const failure = await mintProviderTurn(CONNECTION, {
      fetch: async () => new Response("{}", { status: 201 }),
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as ConnectionError).kind).toBe("transport");
    expect((failure as Error).message).toContain(
      "its answer was not a list of TURN servers",
    );
  });

  test.each([
    ["refused", { kind: "refused", status: 401 }],
    ["refused", { kind: "refused", status: 500 }],
    ["unreachable", { kind: "unreachable", reason: "network" }],
    ["unreachable", { kind: "unreachable", reason: "timeout" }],
    ["malformed", { kind: "malformed", problem: "no-kept-url" }],
  ] as const)(
    "a %s mint never puts the token in the error or its event",
    (_label, outcome) => {
      const failure = providerTurnMintError("cloudflare", outcome);
      expect(failure.message).not.toContain(TOKEN);
      expect(sanitizeErrorForDisplay(failure)).not.toContain(TOKEN);
      const event = buildErrorEvent(
        failure,
        "prepare",
        exitCodeForError(failure),
      );
      expect(JSON.stringify(event)).not.toContain(TOKEN);
      expect(event.message).toContain("Cloudflare");
    },
  );

  test("a token-bearing answer body and network error stay out of the error", async () => {
    for (const fetch of [
      async () =>
        new Response(`{"error":"token ${TOKEN} refused"}`, { status: 401 }),
      async () => {
        throw new TypeError(`connect failed, Bearer ${TOKEN}`);
      },
    ] as Array<typeof globalThis.fetch>) {
      const failure = await mintProviderTurn(CONNECTION, { fetch }).catch(
        (err: unknown) => err as Error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(JSON.stringify(buildErrorEvent(failure, "prepare"))).not.toContain(
        TOKEN,
      );
      expect(sanitizeErrorForDisplay(failure)).not.toContain(TOKEN);
    }
  });
});

describe("connection attempts after the first", () => {
  test("reuse the credential while an attempt fits its lifetime, and mint again for one that would outlast it", async () => {
    const api = stubbedApi();
    let clock = new Date("2026-11-11T12:00:00Z").getTime();
    const run = await mintProviderTurn(CONNECTION, {
      fetch: api.fetch,
      now: () => new Date(clock),
    });
    if (run === undefined) throw new Error("nothing minted");
    const perAttempt = providerTurnPerAttempt(
      run,
      undefined,
      () => new Date(clock),
    );

    clock += 10 * 60 * 1000;
    const second = await perAttempt({
      kind: "partner-not-connected",
      waitedMs: 600_000,
    });
    expect(api.calls).toHaveLength(1);
    expect(second.iceServers[0]).toEqual({
      urls: "turns:turn.cloudflare.com:443?transport=tcp",
      username: "user-minted-1",
      credential: "minted-1",
    });
    expect(second.notice).toContain(
      "with the Cloudflare TURN credential that expires at 2026-11-11T13:00:00.000Z",
    );

    clock = run.expiresAt.getTime() - PROVIDER_TURN_ATTEMPT_LIFETIME_MS + 1;
    const later = await perAttempt({
      kind: "partner-not-connected",
      waitedMs: 0,
    });
    expect(api.calls).toHaveLength(2);
    expect(later.iceServers[0]).toMatchObject({ credential: "minted-2" });
    expect(later.notice).toContain("with a new Cloudflare TURN credential");
    expect(later.notice).not.toContain("minted-2");
  });

  test("the attempt lifetime covers the longest attempt and a channel-open budget", () => {
    expect(PROVIDER_TURN_ATTEMPT_LIFETIME_MS).toBe(15 * 60 * 1000 + 30_000);
  });

  test("mint the derived credential too, for a run that presents one", async () => {
    const run = await mintProviderTurn(
      {
        ...CONNECTION,
        turn: [PROVIDER, { url: "turns:relay.example.org:443" }],
      },
      { fetch: stubbedApi().fetch },
    );
    if (run === undefined) throw new Error("nothing minted");
    const next = await providerTurnPerAttempt(
      run,
      generateSharedSecret(),
    )({
      kind: "signaling-dropped",
    });
    expect(next.iceServers.map((server) => server.urls)).toEqual([
      "turns:turn.cloudflare.com:443?transport=tcp",
      "turns:turn.cloudflare.com:5349?transport=tcp",
      "turns:relay.example.org:443",
    ]);
    expect(next.iceServers[2]?.username).toMatch(/^\d+:alcove$/);
    expect(next.notice).toContain("and a new relay credential that expires at");
  });

  test("a mint that fails for a later attempt ends it with the mint's failure", async () => {
    let calls = 0;
    const run = await mintProviderTurn(CONNECTION, {
      fetch: async () =>
        ++calls === 1
          ? new Response(answer("minted-1"), { status: 201 })
          : new Response("", { status: 401 }),
      now: () => new Date(0),
    });
    if (run === undefined) throw new Error("nothing minted");
    const failure = await providerTurnPerAttempt(
      run,
      undefined,
      () => new Date(run.expiresAt.getTime()),
    )({ kind: "signaling-dropped" }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(UsageError);
    expect((failure as Error).message).toContain("HTTP 401");
  });
});

describe("the run's dial", () => {
  test("selects its relays from the minted connection", async () => {
    const run = await mintProviderTurn(CONNECTION, {
      fetch: stubbedApi().fetch,
    });
    if (run === undefined) throw new Error("nothing minted");
    const sharedSecret = generateSharedSecret();
    const dial = webRtcDialWithProviderTurn(
      webRtcDialFrom(CONNECTION, sharedSecret),
      run,
      undefined,
    );
    expect(dial.relayConnection).toBe(run.connection);
    expect(dial.options.iceServers?.[0]).toMatchObject({
      urls: "turns:turn.cloudflare.com:443?transport=tcp",
      credential: "minted-1",
    });
    expect(dial.options.attemptIceServers).toBeDefined();
  });

  test("names a minted url allowed_relays leaves out", async () => {
    const connection: WebRTCConnectionConfig = {
      ...CONNECTION,
      allowedRelays: ["relay.example.org", "turn.cloudflare.com:5349"],
    };
    const run = await mintProviderTurn(connection, {
      fetch: stubbedApi().fetch,
    });
    if (run === undefined) throw new Error("nothing minted");
    const dial = webRtcDialWithProviderTurn(
      webRtcDialFrom(connection, generateSharedSecret()),
      run,
      undefined,
    );
    expect(dial.options.iceServers?.map((server) => server.urls)).toEqual([
      "turns:turn.cloudflare.com:5349?transport=tcp",
      "turns:relay.example.org:443",
    ]);
    expect(dial.options.relaysLeftOut).toEqual([
      "turns:turn.cloudflare.com:443?transport=tcp",
    ]);
  });
});

describe("which provider entry a run mints", () => {
  const SECOND_PROVIDER: TurnProviderEntry = {
    provider: "cloudflare",
    keyId: "fedcba9876543210fedcba9876543210",
    apiToken: "placeholder-turn-api-token-3333",
  };

  test.each([
    ["after a static turn entry", { turn: [STATIC_ENTRY, PROVIDER] }],
    [
      "that allowed_relays leaves out",
      { turn: [PROVIDER, STATIC_ENTRY], allowedRelays: ["relay.example.org"] },
    ],
    [
      "that allowed_relays leaves out, with no other entry",
      { turn: [PROVIDER], allowedRelays: ["relay.example.org"] },
    ],
  ])("none, for a provider entry %s", async (_label, fields) => {
    const api = stubbedApi();
    expect(
      await mintProviderTurn(
        { ...CONNECTION, ...fields },
        { fetch: api.fetch },
      ),
    ).toBeUndefined();
    expect(api.calls).toHaveLength(0);
  });

  test("the first, after a static entry allowed_relays leaves out", async () => {
    const api = stubbedApi();
    const run = await mintProviderTurn(
      {
        ...CONNECTION,
        turn: [STATIC_ENTRY, PROVIDER],
        allowedRelays: ["turn.cloudflare.com"],
      },
      { fetch: api.fetch },
    );
    expect(api.calls).toHaveLength(1);
    expect(run?.connection.turn?.[0]).toEqual(STATIC_ENTRY);
    expect(run?.connection.turn?.[1]).toMatchObject({
      url: "turns:turn.cloudflare.com:443?transport=tcp",
    });
  });

  test("the first alone, never a second provider entry", async () => {
    const api = stubbedApi();
    const run = await mintProviderTurn(
      { ...CONNECTION, turn: [PROVIDER, SECOND_PROVIDER, STATIC_ENTRY] },
      { fetch: api.fetch, now: () => new Date(0) },
    );
    if (run === undefined) throw new Error("nothing minted");
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.url).toContain(`/keys/${PROVIDER.keyId}/`);
    expect(
      run.connection.turn?.map((entry) => "url" in entry && entry.url),
    ).toEqual([
      "turns:turn.cloudflare.com:443?transport=tcp",
      "turns:turn.cloudflare.com:5349?transport=tcp",
      STATIC_ENTRY.url,
    ]);
    await providerTurnPerAttempt(
      run,
      undefined,
      () => run.expiresAt,
    )({ kind: "signaling-dropped" });
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]?.url).toContain(`/keys/${PROVIDER.keyId}/`);
  });
});
