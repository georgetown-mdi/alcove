import { expect, test } from "vitest";

import {
  MAX_WEBSOCKET_RELAY_URL_LENGTH,
  safeParseConnectionConfig,
} from "../../src/config/connection";

const PASSWORD = "hunter2-not-a-real-password";

function webrtc(websocketRelay: unknown) {
  return safeParseConnectionConfig({
    channel: "webrtc",
    server: { host: "peers.example.org" },
    websocket_relay: websocketRelay,
  });
}

function messages(result: ReturnType<typeof webrtc>): string {
  return result.success
    ? ""
    : result.error.issues.map((issue) => issue.message).join("\n");
}

const FORM =
  "a wss:// url naming a host, an optional port from 1 to 65535 and the " +
  "relay's path, for example wss://relay.example.org/relay";

test.each([
  ["wss://relay.example.org/relay"],
  ["wss://relay.example.org:8443/relay"],
  ["wss://[2001:db8::1]:443/relay"],
])("the relay url %s parses as written", (url) => {
  const result = webrtc(url);
  expect(result.success).toBe(true);
  if (!result.success || result.data.channel !== "webrtc") return;
  expect(result.data.websocketRelay).toBe(url);
});

test("a relay url is trimmed", () => {
  const result = webrtc("  wss://relay.example.org/relay\n");
  expect(result.success).toBe(true);
  if (!result.success || result.data.channel !== "webrtc") return;
  expect(result.data.websocketRelay).toBe("wss://relay.example.org/relay");
});

test("a connection naming no relay leaves the key unset", () => {
  const result = safeParseConnectionConfig({
    channel: "webrtc",
    server: { host: "peers.example.org" },
  });
  expect(result.success).toBe(true);
  if (!result.success || result.data.channel !== "webrtc") return;
  expect(result.data.websocketRelay).toBeUndefined();
});

test.each([
  ["ws://relay.example.org/relay", `must be ${FORM}`],
  ["https://relay.example.org/relay", `must be ${FORM}`],
  ["relay.example.org/relay", `is not a url; write it as ${FORM}`],
  ["wss://relay.example.org:0/relay", `names port 0; write it as ${FORM}`],
  [
    "wss://relay.example.org/relay?x=1",
    `has a query or fragment; write it as ${FORM}`,
  ],
  ["wss://relay.example.org/relay?", "has a query or fragment"],
  ["wss://relay.example.org/relay#", "has a query or fragment"],
  ["wss://relay.example.org/relay#x", "has a query or fragment"],
])("the relay url %s is refused", (url, expected) => {
  expect(messages(webrtc(url))).toContain(`websocket_relay ${expected}`);
});

test("a relay url holding a user is refused without repeating it", () => {
  const result = webrtc(`wss://owner:${PASSWORD}@relay.example.org/relay`);
  expect(messages(result)).toContain(
    `websocket_relay names a user; write it as ${FORM}`,
  );
  expect(JSON.stringify(result)).not.toContain(PASSWORD);
});

test("a relay url over the length bound is refused", () => {
  const url = `wss://relay.example.org/${"a".repeat(MAX_WEBSOCKET_RELAY_URL_LENGTH)}`;
  expect(messages(webrtc(url))).toContain(
    `websocket_relay is longer than ${MAX_WEBSOCKET_RELAY_URL_LENGTH} characters`,
  );
});

test("a relay url that is not a string is refused", () => {
  expect(webrtc(["wss://relay.example.org/relay"]).success).toBe(false);
});
