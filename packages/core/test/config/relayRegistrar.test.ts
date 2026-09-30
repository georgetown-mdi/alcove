import { expect, test } from "vitest";

import {
  hasMintedTurnEntry,
  safeParseConnectionConfig,
} from "../../src/config/connection";
import { isRelayRegistrarExchangeId } from "../../src/relayRegistrarProof";

const PASSWORD = "hunter2-not-a-real-password";

function webrtc(
  relayRegistrar: unknown,
  turn: unknown = [{ url: "turns:relay.example.org:443" }],
) {
  return safeParseConnectionConfig({
    channel: "webrtc",
    server: { host: "peers.example.org" },
    turn,
    relay_registrar: relayRegistrar,
  });
}

function messages(result: ReturnType<typeof webrtc>): string {
  return result.success
    ? ""
    : result.error.issues.map((issue) => issue.message).join("\n");
}

test("a registrar with an https address and an exchange id parses", () => {
  const result = webrtc({
    url: "https://relay.example.org:8443",
    exchange_id: "acme-weekly.1",
  });
  expect(result.success).toBe(true);
  if (!result.success || result.data.channel !== "webrtc") return;
  expect(result.data.relayRegistrar).toEqual({
    url: "https://relay.example.org:8443",
    exchangeId: "acme-weekly.1",
  });
});

test.each([
  ["http://relay.example.org:8443", "https://"],
  ["https://relay.example.org:8443/exchanges", "no path"],
  ["https://relay.example.org:8443?x=1", "no path"],
  ["relay.example.org", "not a url"],
])("the registrar url %s is refused", (url, expected) => {
  expect(messages(webrtc({ url, exchange_id: "exchange-1" }))).toContain(
    expected,
  );
});

test("a registrar url holding a user is refused without repeating it", () => {
  const result = webrtc({
    url: `https://owner:${PASSWORD}@relay.example.org:8443`,
    exchange_id: "exchange-1",
  });
  expect(messages(result)).toContain("names a user");
  expect(JSON.stringify(result)).not.toContain(PASSWORD);
});

test.each([
  ["-leading-dash"],
  ["a".repeat(129)],
  ["has space"],
  [`id-${"ab".repeat(32)}`],
  ["alcove-verify-run"],
])("the exchange id %s is refused", (exchangeId) => {
  expect(
    webrtc({ url: "https://relay.example.org", exchange_id: exchangeId })
      .success,
  ).toBe(false);
});

test("a registrar key other than url and exchange_id is refused, not stripped", () => {
  expect(
    messages(
      webrtc({
        url: "https://relay.example.org",
        exchange_id: "exchange-1",
        token: PASSWORD,
      }),
    ),
  ).toContain("relay_registrar has no key token");
});

test("a registrar with no turn entry minted from the secret is refused", () => {
  const message =
    "relay_registrar registers the key this party's own turn entries mint";
  const registrar = { url: "https://relay.example.org", exchange_id: "x-1" };
  expect(messages(webrtc(registrar, []))).toContain(message);
  expect(
    messages(
      webrtc(registrar, [
        {
          url: "turns:relay.example.org:443",
          username: "u",
          credential: "c",
        },
      ]),
    ),
  ).toContain(message);
});

test("hasMintedTurnEntry is true only for an entry with no credential", () => {
  expect(hasMintedTurnEntry(undefined)).toBe(false);
  expect(
    hasMintedTurnEntry([
      { url: "turns:a.example.org", username: "u", credential: "c" },
    ]),
  ).toBe(false);
  expect(hasMintedTurnEntry([{ url: "turns:a.example.org" }])).toBe(true);
});

test("isRelayRegistrarExchangeId holds the registrar's id rule", () => {
  expect(isRelayRegistrarExchangeId("exchange-1")).toBe(true);
  expect(isRelayRegistrarExchangeId("")).toBe(false);
  expect(isRelayRegistrarExchangeId("-x")).toBe(false);
  expect(isRelayRegistrarExchangeId("a/b")).toBe(false);
  expect(isRelayRegistrarExchangeId("F".repeat(64))).toBe(false);
});
