import { describe, expect, test } from "vitest";

import {
  MAX_SIGNALING_SERVER_URL_LENGTH,
  publishedSignalingServerURL,
  signalingDiscoveryDocumentSource,
  signalingServerFromDiscoveryDocument,
} from "../src/signalingDiscovery";

describe("publishedSignalingServerURL", () => {
  test.each([
    [
      "wss://signal.example.org:8443/api/",
      "wss://signal.example.org:8443/api/",
    ],
    ["wss://signal.example.org/api", "wss://signal.example.org/api/"],
    ["ws://127.0.0.1:9000/", "ws://127.0.0.1:9000/"],
    ["wss://signal.example.org", "wss://signal.example.org/"],
  ])("takes %s as %s", (text, href) => {
    expect(publishedSignalingServerURL(text)?.href).toBe(href);
  });

  test.each([
    "https://signal.example.org/api/",
    "http://signal.example.org/api/",
    "sftp://signal.example.org/",
    "not a url",
    "wss://user@signal.example.org/api/",
    "wss://user:pw@signal.example.org/api/",
    "wss://signal.example.org/api/?key=x",
    "wss://signal.example.org/api/?",
    "wss://signal.example.org/api/#",
    "wss://signal.example.org/a%20b/",
    `wss://signal.example.org/${"a".repeat(MAX_SIGNALING_SERVER_URL_LENGTH)}/`,
  ])("refuses %s", (text) => {
    expect(publishedSignalingServerURL(text)).toBeUndefined();
  });
});

describe("signalingServerFromDiscoveryDocument", () => {
  test("reads signaling_server and ignores other fields", () => {
    expect(
      signalingServerFromDiscoveryDocument({
        signaling_server: "wss://signal.example.org:8443/api/",
        other: 1,
      })?.href,
    ).toBe("wss://signal.example.org:8443/api/");
  });

  test.each([
    null,
    "wss://signal.example.org/api/",
    [],
    {},
    { signaling_server: 1 },
    { signalingServer: null },
    { signaling_server: "https://app.example.org/" },
  ])("refuses %j", (value) => {
    expect(signalingServerFromDiscoveryDocument(value)).toBeUndefined();
  });
});

describe("signalingDiscoveryDocumentSource", () => {
  test("writes the normalized URL in a document the reader takes", () => {
    const source = signalingDiscoveryDocumentSource(
      " wss://signal.example.org:8443/api ",
    );
    const parsed: unknown = JSON.parse(source);
    expect(parsed).toEqual({
      signaling_server: "wss://signal.example.org:8443/api/",
    });
    expect(signalingServerFromDiscoveryDocument(parsed)?.href).toBe(
      "wss://signal.example.org:8443/api/",
    );
  });

  test("refuses an address no reader would take", () => {
    expect(() =>
      signalingDiscoveryDocumentSource("https://signal.example.org/"),
    ).toThrow(/cannot be published/);
  });
});
