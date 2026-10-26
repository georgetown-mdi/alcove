import { describe, expect, test } from "vitest";

import {
  fetchRelayCheckOffer,
  startRelayCheck,
} from "@psi/jobClient/relayCheckClient";

// The console's relay-check answers are re-validated field by field on the
// way in, and anything malformed is the client's `error`, never a throw or a
// partial value the panel would show.

const DIGEST = "a".repeat(64);

const STATEMENT = {
  contactedHeading: "The check contacts:",
  contacted: [{ host: "turn:relay.example:3478", explanation: ["Allocates."] }],
  notContacted: {
    heading: "It does not contact:",
    hosts: [{ host: "turn:later.example", explanation: [] }],
  },
  closing: "Nothing else.",
};

const CHECK = {
  id: "turn_1",
  status: "fail",
  headline: "turn_1: no relay address.",
  meaning: "A run reaches no relay.",
  action: "Check the credential.",
};

/** A fetch answering every request with `body` as JSON at `status`, or with
 * no body where `body` is undefined. */
function answering(body: unknown, status = 200): typeof fetch {
  const text = body === undefined ? null : JSON.stringify(body);
  return () => Promise.resolve(new Response(text, { status }));
}

const failing: typeof fetch = () => Promise.reject(new TypeError("offline"));

const available = {
  status: "available",
  configurationDigest: DIGEST,
  statement: STATEMENT,
  websocketRelayNotChecked: true,
};

describe("fetchRelayCheckOffer", () => {
  test.each<[string, typeof fetch, unknown]>([
    [
      "an available offer",
      answering(available),
      {
        kind: "available",
        configurationDigest: DIGEST,
        statement: STATEMENT,
        websocketRelayNotChecked: true,
      },
    ],
    [
      "an unavailable offer with no WebSocket relay",
      answering({ status: "unavailable", reason: "key-file" }),
      {
        kind: "unavailable",
        reason: "key-file",
        websocketRelayNotChecked: false,
      },
    ],
  ])("%s parses to its value", async (_name, fetchImpl, expected) => {
    expect(await fetchRelayCheckOffer(fetchImpl)).toEqual(expected);
  });

  test.each<[string, typeof fetch]>([
    ["a request that did not complete", failing],
    ["a 500", answering({}, 500)],
    ["an array body", answering([])],
    ["an unknown status", answering({ ...available, status: "ready" })],
    ["an unknown reason", answering({ status: "unavailable", reason: "x" })],
    ["a missing reason", answering({ status: "unavailable" })],
    [
      "a missing digest",
      answering({ ...available, configurationDigest: undefined }),
    ],
    [
      "a digest of the wrong type",
      answering({ ...available, configurationDigest: 1 }),
    ],
    [
      "a statement missing its hosts",
      answering({
        ...available,
        statement: { ...STATEMENT, contacted: undefined },
      }),
    ],
    [
      "a host explanation of the wrong type",
      answering({
        ...available,
        statement: {
          ...STATEMENT,
          contacted: [{ host: "h", explanation: [1] }],
        },
      }),
    ],
    [
      "a notContacted that is not an object",
      answering({
        ...available,
        statement: { ...STATEMENT, notContacted: [] },
      }),
    ],
  ])("%s is an error", async (_name, fetchImpl) => {
    expect(await fetchRelayCheckOffer(fetchImpl)).toEqual({ kind: "error" });
  });
});

describe("startRelayCheck", () => {
  test("it POSTs the digest alone", async () => {
    let init: RequestInit | undefined;
    await startRelayCheck(DIGEST, (_url, requestInit) => {
      init = requestInit;
      return Promise.resolve(new Response("{}", { status: 500 }));
    });
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ configurationDigest: DIGEST }));
  });

  const verdict = {
    status: "verdict",
    overall: "fix_and_retry",
    checks: [CHECK],
  };

  test.each<[string, typeof fetch, unknown]>([
    [
      "a verdict",
      answering(verdict),
      { kind: "verdict", overall: "fix_and_retry", checks: [CHECK] },
    ],
    [
      "an unavailable answer",
      answering({ status: "unavailable", reason: "turn-urls-left-out" }),
      { kind: "unavailable", reason: "turn-urls-left-out" },
    ],
    ["a 409 with no body", answering(undefined, 409), { kind: "busy" }],
    [
      "a 409 naming a running exchange",
      answering({ reason: "exchange-running" }, 409),
      { kind: "exchange-running" },
    ],
    ...(["refused", "timeout", "configuration-changed", "error"] as const).map(
      (kind): [string, typeof fetch, unknown] => [
        `a ${kind} answer`,
        answering({ status: kind }),
        { kind },
      ],
    ),
  ])("%s parses to its value", async (_name, fetchImpl, expected) => {
    expect(await startRelayCheck(DIGEST, fetchImpl)).toEqual(expected);
  });

  const withCheck = (check: Record<string, unknown>) =>
    answering({ ...verdict, checks: [check] });

  test.each<[string, typeof fetch]>([
    ["a request that did not complete", failing],
    ["a 500", answering({}, 500)],
    ["an unknown status", answering({ status: "busy" })],
    ["a status of the wrong type", answering({ status: 1 })],
    ["an unknown reason", answering({ status: "unavailable", reason: "x" })],
    ["an unknown overall", answering({ ...verdict, overall: "fine" })],
    ["checks that are not an array", answering({ ...verdict, checks: {} })],
    ["a check with an unknown status", withCheck({ ...CHECK, status: "bad" })],
    [
      "a check missing its headline",
      withCheck({ ...CHECK, headline: undefined }),
    ],
    ["a check id of the wrong type", withCheck({ ...CHECK, id: 1 })],
    ["a meaning of the wrong type", withCheck({ ...CHECK, meaning: 1 })],
    ["an action of the wrong type", withCheck({ ...CHECK, action: [] })],
  ])("%s is an error", async (_name, fetchImpl) => {
    expect(await startRelayCheck(DIGEST, fetchImpl)).toEqual({ kind: "error" });
  });
});
