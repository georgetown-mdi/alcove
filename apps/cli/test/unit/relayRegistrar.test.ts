import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { ConnectionConfig, RelayRegistrar } from "@alcove/core";

import {
  REMOVED_CREDENTIAL_TEXT,
  relayRegistrarForRun,
  sendRelayRegistration,
} from "../../src/relayRegistrar";
import { promptHiddenText } from "../../src/util/prompt";
import {
  fakeRegistrar,
  jsonResponse,
  registrationAnswer,
} from "./relayRegistrarFake";

const AUTHORIZATION = "Bearer test-owner-token";

const REGISTRAR: RelayRegistrar = {
  url: "https://relay.example.org:8443",
  exchangeId: "exchange-1",
};

describe("relayRegistrarForRun", () => {
  const webrtc = (extra: Record<string, unknown>): ConnectionConfig =>
    ({
      channel: "webrtc",
      server: { host: "peers.example.org" },
      role: "inviter",
      turn: [{ url: "turns:relay.example.org:443?transport=tcp" }],
      relayRegistrar: REGISTRAR,
      ...extra,
    }) as ConnectionConfig;

  test("registers at the registrar of the party's own minted relay", () => {
    expect(relayRegistrarForRun(webrtc({}))).toEqual(REGISTRAR);
  });

  test("registers nothing when the run relays through the invitation's relay", () => {
    expect(
      relayRegistrarForRun(
        webrtc({
          invitationRelay: { turn: ["turns:partner.example.org:443"] },
        }),
      ),
    ).toBeUndefined();
  });

  test("registers nothing when no registrar is named", () => {
    expect(
      relayRegistrarForRun(webrtc({ relayRegistrar: undefined })),
    ).toBeUndefined();
  });
});

describe("sendRelayRegistration", () => {
  test("sends the request to the exchange's path without following redirects", async () => {
    const registrar = fakeRegistrar([registrationAnswer()]);
    await sendRelayRegistration(
      {
        registrar: REGISTRAR,
        method: "PUT",
        body: "{}",
        authorization: "Alcove-Relay-Proof ts=1,mac=x",
      },
      { fetch: registrar.fetch },
    );
    expect(registrar.requests[0]).toMatchObject({
      url: "https://relay.example.org:8443/exchanges/exchange-1",
      method: "PUT",
      redirect: "manual",
      authorization: "Alcove-Relay-Proof ts=1,mac=x",
      body: "{}",
    });
  });

  test("puts an id of every admitted character class in the path unchanged", async () => {
    const registrar = fakeRegistrar([registrationAnswer()]);
    await sendRelayRegistration(
      {
        registrar: { ...REGISTRAR, exchangeId: "_Acme.weekly-2026.v9" },
        method: "PUT",
        body: "{}",
        authorization: "Alcove-Relay-Proof ts=1,mac=x",
      },
      { fetch: registrar.fetch },
    );
    expect(registrar.requests[0]?.url).toBe(
      "https://relay.example.org:8443/exchanges/_Acme.weekly-2026.v9",
    );
  });

  test.each([
    [
      jsonResponse(200, { maxAgeDays: 30, lapsesAt: "2026-01-31T00:00:00Z" }),
      { kind: "registered", maxAgeDays: 30, lapsesAt: "2026-01-31T00:00:00Z" },
    ],
    [
      jsonResponse(409, { error: "exchange-id exchange-1 is not enrolled" }),
      {
        kind: "refused",
        status: 409,
        reason: "exchange-id exchange-1 is not enrolled",
      },
    ],
    [
      jsonResponse(401, { error: "skewed", serverTime: 1767225600 }),
      { kind: "clock-skew", serverTimeSeconds: 1767225600 },
    ],
    [
      jsonResponse(401, { error: "bad proof" }),
      { kind: "refused", status: 401 },
    ],
    [jsonResponse(503, {}), { kind: "unavailable", status: 503 }],
    [jsonResponse(429, {}), { kind: "unavailable", status: 429 }],
    [
      jsonResponse(400, { error: "bad body" }),
      { kind: "rejected", status: 400 },
    ],
    [new Response(null, { status: 302 }), { kind: "rejected", status: 302 }],
  ])("classifies an answer (%#)", async (response, expected) => {
    const registrar = fakeRegistrar([response]);
    const answer = await sendRelayRegistration(
      {
        registrar: REGISTRAR,
        method: "PUT",
        body: "{}",
        authorization: AUTHORIZATION,
      },
      { fetch: registrar.fetch },
    );
    expect(answer).toMatchObject(expected);
  });

  test("a network failure is an unavailable answer, not a throw", async () => {
    const answer = await sendRelayRegistration(
      {
        registrar: REGISTRAR,
        method: "PUT",
        body: "{}",
        authorization: AUTHORIZATION,
      },
      {
        fetch: () => Promise.reject(new TypeError("fetch failed")),
      },
    );
    expect(answer.kind).toBe("unavailable");
  });

  test("a success whose lapsesAt holds control bytes is refused with a fixed reason", async () => {
    const lapsesAt = "2026-01-31T00:00:00Z\u001b[2K\u0007\nforged line";
    const registrar = fakeRegistrar([
      jsonResponse(200, { maxAgeDays: 30, lapsesAt }),
    ]);
    const answer = await sendRelayRegistration(
      {
        registrar: REGISTRAR,
        method: "PUT",
        body: "{}",
        authorization: AUTHORIZATION,
      },
      { fetch: registrar.fetch },
    );
    expect(answer).toEqual({
      kind: "unavailable",
      status: 200,
      reason:
        "its answer states a lapse time that is not a UTC timestamp, so " +
        "the registration is not taken as confirmed",
    });
  });

  test("a reason echoing the credential repeats it in no encoding", async () => {
    const token = "owner/token+with=signs";
    const authorization = `Bearer ${token}`;
    const echoed = [
      authorization,
      encodeURIComponent(token),
      Buffer.from(authorization).toString("base64"),
      Buffer.from(token).toString("base64").replace(/=+$/, ""),
    ].join(" | ");
    const registrar = fakeRegistrar([jsonResponse(401, { error: echoed })]);
    const answer = await sendRelayRegistration(
      { registrar: REGISTRAR, method: "POST", body: "{}", authorization },
      { fetch: registrar.fetch },
    );
    expect(answer).toEqual({
      kind: "refused",
      status: 401,
      reason: Array(4).fill(REMOVED_CREDENTIAL_TEXT).join(" | "),
    });
  });
});

describe("promptHiddenText", () => {
  test("returns the typed line and writes only the question", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    const answer = promptHiddenText("Token:", { input, output });
    input.write("s3cret-token\n");
    await expect(answer).resolves.toBe("s3cret-token");
    expect(written.join("")).toBe("Token: \n");
  });
});
