import { describe, expect, test } from "vitest";

import {
  RELAY_REGISTRATION_CANCELLED_REASON,
  REMOVED_CREDENTIAL_TEXT,
  registerRelayKey,
  sendRelayRegistration,
} from "../src/relayRegistrarClient";
import { generateSharedSecret } from "../src/config/connection";
import type { RelayRegistrar } from "../src/config/connection";

// The transport-neutral registrar client both apps share. The CLI's suite
// (apps/cli/test/unit/relayRegistrar.test.ts, relayKeyRotation.test.ts) holds
// the answer classification and the retries; these hold what differs from a
// Node-only client: the credential scrub runs without Node's Buffer.

const REGISTRAR: RelayRegistrar = {
  url: "https://relay.example.org:8443",
  exchangeId: "exchange-1",
};

function answering(
  answers: Array<[number, unknown]>,
): typeof globalThis.fetch & { authorizations: Array<string | null> } {
  const queue = [...answers];
  const authorizations: Array<string | null> = [];
  const fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("Authorization"));
    const next = queue.shift();
    if (next === undefined) return Promise.reject(new TypeError("unreachable"));
    return Promise.resolve(
      new Response(JSON.stringify(next[1]), { status: next[0] }),
    );
  }) as typeof globalThis.fetch & { authorizations: Array<string | null> };
  fetch.authorizations = authorizations;
  return fetch;
}

describe("sendRelayRegistration", () => {
  test.each([
    ["as sent", (token: string) => token],
    ["base64-encoded", (token: string) => btoa(token)],
    [
      "base64-encoded without padding",
      (token: string) => btoa(token).replace(/=+$/, ""),
    ],
    ["URL-encoded", (token: string) => encodeURIComponent(token)],
  ])(
    "a registrar echoing the token %s repeats no credential",
    async (_, form) => {
      const token = "owner token/with+symbols=";
      const answer = await sendRelayRegistration(
        {
          registrar: REGISTRAR,
          method: "POST",
          body: "{}",
          authorization: `Bearer ${token}`,
        },
        { fetch: answering([[401, { error: `refused ${form(token)}` }]]) },
      );
      expect(answer.kind).toBe("refused");
      const reason = answer.kind === "refused" ? (answer.reason ?? "") : "";
      expect(reason).toContain(REMOVED_CREDENTIAL_TEXT);
      expect(reason).not.toContain(form(token));
    },
  );
});

describe("registerRelayKey", () => {
  test("a proof outside the registrar's window is signed again once at its time", async () => {
    const secret = generateSharedSecret();
    const fetch = answering([
      [401, { error: "stale", serverTime: 1_767_225_600 }],
      [200, { maxAgeDays: null, lapsesAt: null }],
    ]);
    const outcome = await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: secret,
        registeredSecret: secret,
        maxAgeDays: null,
      },
      { fetch, now: () => new Date("2026-09-30T00:00:00Z") },
    );
    expect(outcome.kind).toBe("registered");
    expect(fetch.authorizations).toHaveLength(2);
    expect(fetch.authorizations[1]).toMatch(/ts=1767225600,/);
  });

  test("a cancelled registration stops at a registrar that never answers", async () => {
    const secret = generateSharedSecret();
    const cancel = new AbortController();
    let requests = 0;
    const neverAnswering = ((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests++;
      queueMicrotask(() => cancel.abort());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as typeof globalThis.fetch;
    const outcome = await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: secret,
        registeredSecret: secret,
        maxAgeDays: null,
      },
      {
        fetch: neverAnswering,
        timeoutMs: 600_000,
        retryDelaysMs: [600_000, 600_000],
        signal: cancel.signal,
      },
    );
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: RELAY_REGISTRATION_CANCELLED_REASON,
    });
    expect(requests).toBe(1);
  });

  test("a cancel during the wait between attempts makes no further attempt", async () => {
    const secret = generateSharedSecret();
    const cancel = new AbortController();
    const fetch = answering([[503, {}]]);
    const outcome = await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: secret,
        registeredSecret: secret,
        maxAgeDays: null,
      },
      {
        fetch,
        retryDelaysMs: [600_000],
        sleep: () => {
          cancel.abort();
          return new Promise(() => {});
        },
        signal: cancel.signal,
      },
    );
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: RELAY_REGISTRATION_CANCELLED_REASON,
    });
    expect(fetch.authorizations).toHaveLength(1);
  });
});
