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
// most of the answer classification and the retries; these hold the 2xx
// bodies that confirm nothing, the cancel and last-attempt signals, and the
// credential scrub without Node's Buffer.

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

/** A fetch answering once with `status` and the raw `text`. */
function answeringText(status: number, text: string): typeof globalThis.fetch {
  return (() =>
    Promise.resolve(
      new Response(text, {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof globalThis.fetch;
}

/** A fetch whose every request waits until its signal aborts, recording the
 * name of the reason each one ended with. */
function neverAnswering(): typeof globalThis.fetch & { endings: string[] } {
  const endings: string[] = [];
  const fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const reason: unknown = init.signal?.reason;
        endings.push(reason instanceof Error ? reason.name : String(reason));
        reject(reason);
      });
    })) as typeof globalThis.fetch & { endings: string[] };
  fetch.endings = endings;
  return fetch;
}

// What infra/relay/registrar.py answers an enrollment or registration with.
const REGISTRAR_ANSWER = {
  message: "exchange-1 registered",
  maxAgeDays: 30,
  lapsesAt: "2026-10-30T00:00:00Z",
};

const PROOF_REQUEST = {
  registrar: REGISTRAR,
  method: "PUT" as const,
  body: "{}",
  authorization: "Alcove-Relay-Proof ts=1,mac=x",
};

describe("sendRelayRegistration", () => {
  test("the registrar's answer to a registration confirms it", async () => {
    const answer = await sendRelayRegistration(PROOF_REQUEST, {
      fetch: answeringText(200, JSON.stringify(REGISTRAR_ANSWER)),
    });
    expect(answer).toEqual({
      kind: "registered",
      maxAgeDays: 30,
      lapsesAt: "2026-10-30T00:00:00Z",
    });
  });

  test.each([
    [
      "over the answer bound",
      JSON.stringify({ ...REGISTRAR_ANSWER, message: "x".repeat(5000) }),
    ],
    ["HTML", "<!doctype html><html><body>Welcome</body></html>"],
    ["JSON that is not an object", JSON.stringify([REGISTRAR_ANSWER])],
    ["an object stating no registration", JSON.stringify({ ok: true })],
    [
      "an object with no lapse",
      JSON.stringify({ message: "ok", maxAgeDays: 30 }),
    ],
    [
      "a lapse in days that is not a whole number",
      JSON.stringify({ ...REGISTRAR_ANSWER, maxAgeDays: "30" }),
    ],
  ])(
    "a 200 whose body is %s is not a confirmed registration",
    async (_, text) => {
      const answer = await sendRelayRegistration(PROOF_REQUEST, {
        fetch: answeringText(200, text),
      });
      expect(answer).toMatchObject({ kind: "unavailable", status: 200 });
      expect(answer.kind === "unavailable" && answer.reason).toContain(
        "not taken as confirmed",
      );
    },
  );

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

  function failingWith(cause: unknown): typeof globalThis.fetch {
    return (() =>
      Promise.reject(
        new TypeError("fetch failed", { cause }),
      )) as typeof globalThis.fetch;
  }

  test.each([
    [
      "a refused connection",
      { code: "ECONNREFUSED" },
      "no-connection",
      "ECONNREFUSED",
    ],
    [
      "a name that does not resolve",
      { code: "ENOTFOUND" },
      "name-not-resolved",
      "ENOTFOUND",
    ],
    [
      "a name lookup that failed for now",
      { code: "EAI_AGAIN" },
      "name-not-resolved",
      "EAI_AGAIN",
    ],
    ["a reset connection", { code: "ECONNRESET" }, "no-answer", "ECONNRESET"],
    [
      "a connection tried at several addresses",
      new AggregateError([{ code: "EHOSTUNREACH" }], "connect failed"),
      "no-connection",
      "EHOSTUNREACH",
    ],
  ])("%s names the registrar unreachable", async (_, cause, failure, code) => {
    const answer = await sendRelayRegistration(PROOF_REQUEST, {
      fetch: failingWith(cause),
    });
    expect(answer).toMatchObject({
      kind: "unavailable",
      unreachable: {
        kind: "relay-registrar-unreachable",
        host: "relay.example.org",
        port: 8443,
        failure,
        code,
      },
    });
  });

  test.each([
    ["no cause", undefined],
    ["a certificate the client refused", { code: "CERT_HAS_EXPIRED" }],
  ])(
    "a failed fetch with %s does not name the registrar unreachable",
    async (_, cause) => {
      const answer = await sendRelayRegistration(PROOF_REQUEST, {
        fetch: failingWith(cause),
      });
      expect(answer.kind).toBe("unavailable");
      expect(answer).not.toHaveProperty("unreachable");
    },
  );

  test("a registrar url with no port names port 443", async () => {
    const answer = await sendRelayRegistration(
      {
        ...PROOF_REQUEST,
        registrar: { ...REGISTRAR, url: "https://relay.example.org" },
      },
      { fetch: failingWith({ code: "ECONNREFUSED" }) },
    );
    expect(answer).toMatchObject({ unreachable: { port: 443 } });
  });
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

  test("once its last attempt is called, a registration makes that one attempt and it runs to its timeout", async () => {
    const secret = generateSharedSecret();
    const lastAttempt = new AbortController();
    lastAttempt.abort();
    const fetch = neverAnswering();
    const outcome = await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: secret,
        registeredSecret: secret,
        maxAgeDays: null,
      },
      {
        fetch,
        timeoutMs: 20,
        retryDelaysMs: [600_000, 600_000],
        lastAttemptSignal: lastAttempt.signal,
      },
    );
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: "no answer within 20 ms",
      unreachable: {
        kind: "relay-registrar-unreachable",
        host: "relay.example.org",
        port: 8443,
        failure: "no-answer",
        timedOutMs: 20,
      },
    });
    expect(fetch.endings).toEqual(["TimeoutError"]);
  });

  test("a last attempt called during an attempt lets it finish and confirm", async () => {
    const secret = generateSharedSecret();
    const lastAttempt = new AbortController();
    let requests = 0;
    const fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      requests++;
      lastAttempt.abort();
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        setTimeout(
          () => resolve(new Response(JSON.stringify(REGISTRAR_ANSWER))),
          10,
        );
      });
    }) as typeof globalThis.fetch;
    const outcome = await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: secret,
        registeredSecret: secret,
        maxAgeDays: 30,
      },
      { fetch, lastAttemptSignal: lastAttempt.signal },
    );
    expect(outcome.kind).toBe("registered");
    expect(requests).toBe(1);
  });

  test("a last attempt called during the wait between attempts makes one more", async () => {
    const secret = generateSharedSecret();
    const lastAttempt = new AbortController();
    const fetch = answering([
      [503, {}],
      [503, {}],
      [503, {}],
    ]);
    const outcome = await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: secret,
        registeredSecret: secret,
        maxAgeDays: null,
      },
      {
        fetch,
        retryDelaysMs: [600_000, 600_000],
        sleep: () => {
          lastAttempt.abort();
          return new Promise(() => {});
        },
        lastAttemptSignal: lastAttempt.signal,
      },
    );
    expect(outcome).toMatchObject({ kind: "unavailable", status: 503 });
    expect(fetch.authorizations).toHaveLength(2);
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
