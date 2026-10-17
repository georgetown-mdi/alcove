/// <reference types="@vitest/browser-playwright/context" />

import { expect, test } from "vitest";

import { relayTestResultText, runRelayTest } from "@psi/transport/relayTest";

/**
 * The relay test in real Chromium against a relay under a reserved name that
 * never resolves (RFC 6761), which Chromium reports as an
 * `icecandidateerror` within a fraction of a second. A relay that answers 401
 * needs a TURN server, which this suite does not run.
 */
const UNREACHABLE_RELAY_URL = "turns:relay.invalid:443";

test(
  "a relay that cannot be reached is reported as no answer, naming the browser's error",
  { timeout: 40_000 },
  async () => {
    const results = await runRelayTest([
      { url: UNREACHABLE_RELAY_URL, source: "own", transport: "tls" },
    ]);

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.outcome).toMatchObject({
      kind: "no-answer",
      reason: "reported",
    });
    expect(relayTestResultText(result)).toBe(
      "No answer over TLS: the browser reported error 701: Failed to establish connection. " +
        "Check that the relay address is correct and that this network " +
        "allows connections to it, then run the test again.",
    );
  },
);

test.each([
  ["an unparsable url", "turn:relay example.org:3478"],
  ["a scheme that is not a TURN url", "http://relay.example.org"],
])(
  "Chromium refuses %s as an address, reported as not tested",
  async (_name, url) => {
    const results = await runRelayTest([
      { url, source: "own", transport: "udp" },
    ]);
    expect(results.map((result) => result.outcome)).toEqual([
      { kind: "not-asked" },
    ]);
  },
);
