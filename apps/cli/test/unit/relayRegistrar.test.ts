import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import type { ConnectionConfig, RelayRegistrar } from "@alcove/core";

import {
  relayRegistrarForRun,
  sendRelayRegistration,
} from "../../src/relayRegistrar";
import { promptHiddenText } from "../../src/util/prompt";
import { fakeRegistrar, jsonResponse } from "./relayRegistrarFake";

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
    const registrar = fakeRegistrar([jsonResponse(200, {})]);
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
    const registrar = fakeRegistrar([jsonResponse(200, {})]);
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
      { registrar: REGISTRAR, method: "PUT", body: "{}", authorization: "x" },
      { fetch: registrar.fetch },
    );
    expect(answer).toMatchObject(expected);
  });

  test("a network failure is an unavailable answer, not a throw", async () => {
    const answer = await sendRelayRegistration(
      { registrar: REGISTRAR, method: "PUT", body: "{}", authorization: "x" },
      {
        fetch: () => Promise.reject(new TypeError("fetch failed")),
      },
    );
    expect(answer.kind).toBe("unavailable");
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
