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

// The reference relay's front answers the registrar on 443 under a name of its
// own, so the address a refusal suggests names no port.
test("a registrar url naming no port parses, and a refusal's example names none", () => {
  const result = webrtc({
    url: "https://registrar.example.org",
    exchange_id: "exchange-1",
  });
  expect(result.success).toBe(true);
  expect(
    messages(webrtc({ url: "registrar.example.org", exchange_id: "x-1" })),
  ).toMatch(/for example https:\/\/registrar\.example\.org$/);
  expect(
    messages(
      webrtc({ url: "http://registrar.example.org", exchange_id: "x-1" }),
    ),
  ).toMatch(/for example https:\/\/registrar\.example\.org(?!:)/);
});

const FORM =
  "an https:// url naming only a host and an optional port from 1 to 65535, " +
  "for example https://registrar.example.org";

test.each([
  ["http://relay.example.org:8443", `must be ${FORM}`],
  [
    "https://relay.example.org:8443/exchanges",
    `has a path, query, or fragment; write it as ${FORM}`,
  ],
  ["https://relay.example.org:8443?x=1", "has a path, query, or fragment"],
  ["relay.example.org", `is not a url; write it as ${FORM}`],
  ["https://relay.example.org:0", `names port 0; write it as ${FORM}`],
  ["https://relay.example.org#x", "has a path, query, or fragment"],
  ["https://relay.example.org?", "has a path, query, or fragment"],
  ["https://relay.example.org#", "has a path, query, or fragment"],
  ["https://relay.example.org/?#", "has a path, query, or fragment"],
  ["https://relay.example.org//", "has a path, query, or fragment"],
  ["https://relay.example.org/.", `must be written as ${FORM}`],
  ["https:relay.example.org", `must be written as ${FORM}`],
])("the registrar url %s is refused", (url, expected) => {
  expect(messages(webrtc({ url, exchange_id: "exchange-1" }))).toContain(
    `relay_registrar.url ${expected}`,
  );
});

test("a registrar url holding a user is refused without repeating it", () => {
  const result = webrtc({
    url: `https://owner:${PASSWORD}@relay.example.org:8443`,
    exchange_id: "exchange-1",
  });
  expect(messages(result)).toContain(
    `relay_registrar.url names a user; write it as ${FORM}`,
  );
  expect(JSON.stringify(result)).not.toContain(PASSWORD);
});

test.each([
  ["https://hidden-host.example.org?", "query"],
  ["https://hidden-host.example.org/x", "path"],
  ["https://hidden-host.example.org:0", "port 0"],
  ["http://hidden-host.example.org", "https"],
])("a refused registrar url %s is not repeated", (url) => {
  const result = webrtc({ url, exchange_id: "exchange-1" });
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).not.toContain("hidden-host");
});

test.each([
  ["an explicit port 443", "https://relay.example.org:443"],
  ["an upper-case host", "https://Relay.Example.ORG"],
  ["a trailing slash", "https://relay.example.org/"],
  ["all three", "https://Relay.example.org:443/"],
])("a registrar url with %s parses to its origin", (_, url) => {
  const result = webrtc({ url, exchange_id: "exchange-1" });
  expect(result.success).toBe(true);
  if (!result.success || result.data.channel !== "webrtc") return;
  expect(result.data.relayRegistrar?.url).toBe("https://relay.example.org");
});

test("a registrar url with a port other than 443 keeps it in its origin", () => {
  const result = webrtc({
    url: "https://Relay.example.org:8443/",
    exchange_id: "exchange-1",
  });
  if (!result.success || result.data.channel !== "webrtc")
    throw new Error("expected the registrar to parse");
  expect(result.data.relayRegistrar?.url).toBe(
    "https://relay.example.org:8443",
  );
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

test.each([["."], [".."]])(
  "the exchange id %s is refused as a directory name",
  (exchangeId) => {
    expect(
      messages(
        webrtc({ url: "https://relay.example.org", exchange_id: exchangeId }),
      ),
    ).toContain("relay_registrar.exchange_id must not be '.' or '..'");
  },
);

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
