import { afterEach, describe, expect, test, vi } from "vitest";

import {
  MAX_REGISTRAR_ANSWER_BYTES,
  RELAY_REGISTRAR_REQUEST_TIMEOUT_MS,
  RELAY_REGISTRATION_CANCELLED_REASON,
  RELAY_REGISTRATION_RETRY_DELAYS_MS,
  REMOVED_CREDENTIAL_TEXT,
  REMOVED_EXCHANGE_ID_TEXT,
  REMOVED_RELAY_KEY_TEXT,
  enrollRelayKey,
  enrollRelayKeyWithinWait,
  enrollRelayKeyWithoutToken,
  MAX_REGISTRAR_RETRY_AFTER_SECONDS,
  registerRelayKey,
  relayRegistrationOutcomeDetail,
  sendRelayRegistration,
} from "../src/relayRegistrarClient";
import { deriveRelayExchangeId, deriveRelayKey } from "../src/relayCredential";
import { generateSharedSecret } from "../src/config/connection";
import type { RelayRegistrar } from "../src/config/connection";

// The transport-neutral registrar client both apps share: the request, its
// answer classification, the retries and signals of a registration, and the
// enrollments. The CLI's key-file side of a registration is in
// apps/cli/test/unit/relayKeyRotation.test.ts.

const REGISTRAR: RelayRegistrar = {
  url: "https://relay.example.org:8443",
  exchangeId: "exchange-1",
};

const AUTHORIZATION = "Bearer test-owner-token";

/** A JSON answer with `status`. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The registrar's 200 to an enrollment or registration. */
function registrationAnswer(): Response {
  return jsonResponse(200, {
    message: "exchange-1 registered",
    maxAgeDays: null,
    lapsesAt: null,
  });
}

/** A fetch answering each request with the next of `answers`, recording what
 * was sent; a request past the last answer fails as an unreachable host does. */
function fakeRegistrar(answers: Response[]) {
  const requests: Array<{
    url: string;
    method: string | undefined;
    redirect: RequestRedirect | undefined;
    authorization: string | null;
    body: string;
  }> = [];
  const queue = [...answers];
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method,
      redirect: init?.redirect,
      authorization: new Headers(init?.headers).get("Authorization"),
      body: typeof init?.body === "string" ? init.body : "",
    });
    const next = queue.shift();
    if (next === undefined)
      return Promise.reject(new TypeError("fetch failed"));
    return Promise.resolve(next);
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

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

  test.each([
    ["as sent", (value: string) => value],
    ["URL-encoded", (value: string) => encodeURIComponent(value)],
    ["JSON-escaped", (value: string) => JSON.stringify(value).slice(1, -1)],
    ["base64-encoded", (value: string) => btoa(value)],
  ])(
    "a registrar echoing the exchange id and the relay key %s repeats neither",
    async (_, form) => {
      const key = 'relay key/with "quotes"+=';
      const answer = await sendRelayRegistration(
        {
          registrar: REGISTRAR,
          method: "POST",
          body: JSON.stringify({ key, maxAgeDays: null }),
        },
        {
          fetch: answering([
            [
              409,
              {
                error: `no row for ${form(REGISTRAR.exchangeId)} under ${form(key)}`,
              },
            ],
          ]),
        },
      );
      expect(answer).toEqual({
        kind: "refused",
        status: 409,
        reason: `no row for ${REMOVED_EXCHANGE_ID_TEXT} under ${REMOVED_RELAY_KEY_TEXT}`,
      });
    },
  );

  test("an exchange id echoed overlapping the relay key leaves no part of either", async () => {
    const key = "1".padEnd(64, "f");
    const answer = await sendRelayRegistration(
      {
        registrar: REGISTRAR,
        method: "POST",
        body: JSON.stringify({ key, maxAgeDays: null }),
      },
      {
        fetch: answering([
          [409, { error: `held: exchange-${key} and ${key}exchange-1.` }],
        ]),
      },
    );
    expect(answer.kind === "refused" && answer.reason).toBe(
      `held: ${REMOVED_EXCHANGE_ID_TEXT} and ` +
        `${REMOVED_RELAY_KEY_TEXT}${REMOVED_EXCHANGE_ID_TEXT}.`,
    );
  });

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
        reason: `exchange-id ${REMOVED_EXCHANGE_ID_TEXT} is not enrolled`,
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

// docs/spec/RELAY_CREDENTIALS.md, Registering the rotated relay key: Retries and What
// confirms.
describe("the registrar client's bounds", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a request has 15 s, a registration waits 2 s and 5 s, and an answer holds 4,096 bytes", () => {
    expect(RELAY_REGISTRAR_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(RELAY_REGISTRATION_RETRY_DELAYS_MS).toEqual([2_000, 5_000]);
    expect(MAX_REGISTRAR_ANSWER_BYTES).toBe(4_096);
  });

  test("a request with no timeout set is cut at 15 s, not before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetch = neverAnswering();
    const pending = sendRelayRegistration(PROOF_REQUEST, { fetch });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetch.endings).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch.endings).toEqual(["TimeoutError"]);
    expect(await pending).toMatchObject({
      kind: "unavailable",
      reason: "no answer within 15000 ms",
    });
  });

  test("a registration with no waits set waits 2 s and then 5 s, three attempts in all", async () => {
    const secret = generateSharedSecret();
    const waits: number[] = [];
    const fetch = answering([
      [503, {}],
      [503, {}],
      [503, {}],
      [200, REGISTRAR_ANSWER],
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
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(outcome).toMatchObject({ kind: "unavailable", status: 503 });
    expect(waits).toEqual([2_000, 5_000]);
    expect(fetch.authorizations).toHaveLength(3);
  });

  /** A registrar answer of `bytes` bytes stating a registration. */
  function answerOfBytes(bytes: number): string {
    const empty = JSON.stringify({ ...REGISTRAR_ANSWER, message: "" });
    return JSON.stringify({
      ...REGISTRAR_ANSWER,
      message: "x".repeat(bytes - empty.length),
    });
  }

  test("a 2xx of 4,096 bytes stating the registration confirms it", async () => {
    const text = answerOfBytes(4_096);
    expect(new TextEncoder().encode(text).length).toBe(4_096);
    const answer = await sendRelayRegistration(PROOF_REQUEST, {
      fetch: answeringText(200, text),
    });
    expect(answer).toEqual({
      kind: "registered",
      maxAgeDays: 30,
      lapsesAt: "2026-10-30T00:00:00Z",
    });
  });

  test("a 2xx of 4,097 bytes stating the registration confirms nothing", async () => {
    const text = answerOfBytes(4_097);
    expect(new TextEncoder().encode(text).length).toBe(4_097);
    const answer = await sendRelayRegistration(PROOF_REQUEST, {
      fetch: answeringText(200, text),
    });
    expect(answer).toMatchObject({ kind: "unavailable", status: 200 });
  });
});

// A timer left pending keeps a command-line process alive after its run.
describe("sendRelayRegistration's timeout timer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test.each([
    ["confirmed", 200, REGISTRAR_ANSWER, "registered"],
    ["refused", 401, { error: "unknown key" }, "refused"],
  ])(
    "no timer remains after a request the registrar %s",
    async (_, status, body, kind) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let answerRequest: (() => void) | undefined;
      const fetch = (() =>
        new Promise<Response>((resolve) => {
          answerRequest = () =>
            resolve(new Response(JSON.stringify(body), { status }));
        })) as typeof globalThis.fetch;
      const pending = sendRelayRegistration(PROOF_REQUEST, { fetch });
      expect(vi.getTimerCount()).toBe(1);
      answerRequest?.();
      expect((await pending).kind).toBe(kind);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test("a request aborts with a TimeoutError at the bound, not before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetch = neverAnswering();
    const pending = sendRelayRegistration(PROOF_REQUEST, {
      fetch,
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch.endings).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch.endings).toEqual(["TimeoutError"]);
    expect(await pending).toMatchObject({
      kind: "unavailable",
      reason: "no answer within 1000 ms",
    });
    expect(vi.getTimerCount()).toBe(0);
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

  test("a second proof outside the window is a refusal, stating a reason where the registrar gives none", async () => {
    const secret = generateSharedSecret();
    const fetch = answering([
      [401, { serverTime: 1_767_225_600 }],
      [401, { serverTime: 1_767_225_600 }],
      [200, REGISTRAR_ANSWER],
    ]);
    const outcome = await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: secret,
        registeredSecret: secret,
        maxAgeDays: null,
      },
      { fetch, retryDelaysMs: [1, 1], sleep: () => Promise.resolve() },
    );
    expect(outcome).toEqual({
      kind: "refused",
      status: 401,
      reason: "the proof's time is outside the registrar's window",
    });
    expect(fetch.authorizations).toHaveLength(2);
  });

  test("a cancel between a proof outside the window and its re-signing sends nothing more", async () => {
    const secret = generateSharedSecret();
    const cancel = new AbortController();
    const fetch = answering([
      [401, { error: "stale", serverTime: 1_767_225_600 }],
      [200, REGISTRAR_ANSWER],
    ]);
    let clockReads = 0;
    const outcome = await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: secret,
        registeredSecret: secret,
        maxAgeDays: null,
      },
      {
        fetch,
        signal: cancel.signal,
        // The second read is the one the skewed answer's offset takes.
        now: () => {
          if (++clockReads === 2) cancel.abort();
          return new Date("2026-09-30T00:00:00Z");
        },
      },
    );
    expect(clockReads).toBe(2);
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: RELAY_REGISTRATION_CANCELLED_REASON,
    });
    expect(fetch.authorizations).toHaveLength(1);
  });

  test.each([
    ["a refusal", 409, { error: "held" }, "refused"],
    ["a rejection", 400, { error: "bad body" }, "rejected"],
    ["a confirmation", 200, REGISTRAR_ANSWER, "registered"],
  ])("%s is final", async (_, status, body, kind) => {
    const secret = generateSharedSecret();
    const fetch = answering([
      [status, body],
      [200, REGISTRAR_ANSWER],
    ]);
    const outcome = await registerRelayKey(
      {
        registrar: REGISTRAR,
        signingSecret: secret,
        registeredSecret: secret,
        maxAgeDays: null,
      },
      { fetch, retryDelaysMs: [1, 1], sleep: () => Promise.resolve() },
    );
    expect(outcome.kind).toBe(kind);
    expect(fetch.authorizations).toHaveLength(1);
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

describe("enrollRelayKeyWithoutToken", () => {
  // What the registrar answers an enrollment without a token: the lapse is
  // its own (docs/spec/RELAY_REGISTRAR.md, Enrollment without a token).
  const TOKENLESS_ANSWER = {
    message: "registered",
    maxAgeDays: null,
    lapsesAt: "2026-10-15T13:10:00Z",
  };

  function recording(answers: Array<[number, unknown]>) {
    const queue = [...answers];
    const requests: Array<{
      url: string;
      method: string | undefined;
      body: unknown;
      authorization: string | null;
    }> = [];
    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method,
        body: init?.body,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      const next = queue.shift();
      if (next === undefined)
        return Promise.reject(new TypeError("unreachable"));
      return Promise.resolve(
        new Response(JSON.stringify(next[1]), { status: next[0] }),
      );
    }) as typeof globalThis.fetch;
    return { fetch, requests };
  }

  test("posts the derived key under the derived id with no Authorization header", async () => {
    const secret = generateSharedSecret();
    const { fetch, requests } = recording([[200, TOKENLESS_ANSWER]]);
    const outcome = await enrollRelayKeyWithoutToken(
      { registrarUrl: "https://registrar.example.org", sharedSecret: secret },
      { fetch },
    );
    expect(outcome).toEqual({
      kind: "registered",
      maxAgeDays: null,
      lapsesAt: "2026-10-15T13:10:00Z",
    });
    expect(requests).toEqual([
      {
        url: `https://registrar.example.org/exchanges/${await deriveRelayExchangeId(secret)}`,
        method: "POST",
        body: JSON.stringify({
          key: await deriveRelayKey(secret),
          maxAgeDays: null,
        }),
        authorization: null,
      },
    ]);
  });

  test("a 409, the id held under another key, is final", async () => {
    const { fetch, requests } = recording([
      [409, { error: "exchange holds another key" }],
    ]);
    const outcome = await enrollRelayKeyWithoutToken(
      {
        registrarUrl: "https://registrar.example.org",
        sharedSecret: generateSharedSecret(),
      },
      { fetch },
    );
    expect(outcome).toEqual({
      kind: "refused",
      status: 409,
      reason: "exchange holds another key",
    });
    expect(requests).toHaveLength(1);
  });

  test.each([429, 503])(
    "a %i is not tried again: one attempt in all",
    async (status) => {
      const { fetch, requests } = recording([
        [status, { error: "try again" }],
        [200, TOKENLESS_ANSWER],
      ]);
      const outcome = await enrollRelayKeyWithoutToken(
        {
          registrarUrl: "https://registrar.example.org",
          sharedSecret: generateSharedSecret(),
        },
        { fetch },
      );
      expect(outcome).toMatchObject({ kind: "unavailable", status });
      expect(requests).toHaveLength(1);
    },
  );

  test("an unanswered request is not tried again", async () => {
    let calls = 0;
    const flaky = (() => {
      calls++;
      return calls === 1
        ? Promise.reject(new TypeError("network down"))
        : Promise.resolve(
            new Response(JSON.stringify(TOKENLESS_ANSWER), { status: 200 }),
          );
    }) as typeof globalThis.fetch;
    const outcome = await enrollRelayKeyWithoutToken(
      {
        registrarUrl: "https://registrar.example.org",
        sharedSecret: generateSharedSecret(),
      },
      { fetch: flaky },
    );
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: "it could not be reached (network down)",
    });
    expect(calls).toBe(1);
  });

  test("a proof-window answer is a 401 refusal stating the registrar's reason, or none", async () => {
    for (const [error, reason] of [
      ["stale", "stale"],
      [undefined, undefined],
    ] as const) {
      const { fetch, requests } = recording([
        [401, { error, serverTime: 1_767_225_600 }],
        [200, TOKENLESS_ANSWER],
      ]);
      const outcome = await enrollRelayKeyWithoutToken(
        {
          registrarUrl: "https://registrar.example.org",
          sharedSecret: generateSharedSecret(),
        },
        { fetch },
      );
      expect(outcome).toEqual({ kind: "refused", status: 401, reason });
      expect(requests).toHaveLength(1);
    }
  });

  test("a cancel before the attempt sends nothing", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const { fetch, requests } = recording([[200, TOKENLESS_ANSWER]]);
    const outcome = await enrollRelayKeyWithoutToken(
      {
        registrarUrl: "https://registrar.example.org",
        sharedSecret: generateSharedSecret(),
      },
      { fetch, signal: cancel.signal },
    );
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: RELAY_REGISTRATION_CANCELLED_REASON,
    });
    expect(requests).toEqual([]);
  });
});

describe("relayRegistrationOutcomeDetail", () => {
  test.each<[Parameters<typeof relayRegistrationOutcomeDetail>[0], string]>([
    [{ kind: "refused", status: 409, reason: "held" }, "HTTP 409: held"],
    [{ kind: "rejected", status: 400 }, "HTTP 400"],
    [{ kind: "unavailable", reason: "no route" }, "no route"],
    [{ kind: "unavailable", reason: "" }, "unavailable"],
  ])("%j is stated as %j", (outcome, detail) => {
    expect(relayRegistrationOutcomeDetail(outcome)).toBe(detail);
  });
});

describe("enrollRelayKeyWithinWait", () => {
  const REGISTRAR_URL = "https://registrar.example.org";
  const WAIT_MS = 3_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fetch answering only by rejecting with its signal's reason once that
   * signal aborts, as a registrar that takes the connection and never replies;
   * `called` resolves at its first request. */
  function silent() {
    let markCalled = () => {};
    const called = new Promise<void>((resolve) => {
      markCalled = resolve;
    });
    const fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      markCalled();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason as Error),
        );
      });
    }) as typeof globalThis.fetch;
    return { fetch, called };
  }

  async function enrollWith(
    fetch: typeof globalThis.fetch,
    signal?: AbortSignal,
  ) {
    return enrollRelayKeyWithinWait(
      { registrarUrl: REGISTRAR_URL, sharedSecret: generateSharedSecret() },
      { waitMs: WAIT_MS, fetch, ...(signal !== undefined && { signal }) },
    );
  }

  test("a confirmed enrollment is enrolled, with the registrar's lapse", async () => {
    expect(
      await enrollWith(
        answering([
          [200, { maxAgeDays: null, lapsesAt: "2026-10-15T13:10:00Z" }],
        ]),
      ),
    ).toEqual({ kind: "enrolled", lapsesAt: "2026-10-15T13:10:00Z" });
  });

  test.each([
    [409, "HTTP 409: held"],
    [429, "HTTP 429: held"],
  ])("a %i fails after one attempt, stating it", async (status, detail) => {
    const fetch = answering([
      [status, { error: "held" }],
      [200, { maxAgeDays: null, lapsesAt: null }],
    ]);
    expect(await enrollWith(fetch)).toEqual({
      kind: "failed",
      detail,
      answer: { status, reason: "held" },
    });
    expect(fetch.authorizations).toEqual([null]);
  });

  /** A fetch answering once with `status`, `{ error }` and `Retry-After`. */
  function answeringWithRetryAfter(
    status: number,
    retryAfter: string,
  ): typeof globalThis.fetch {
    return (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "try again" }), {
          status,
          headers: { "Retry-After": retryAfter },
        }),
      )) as typeof globalThis.fetch;
  }

  test.each([429, 503])(
    "a %i states the answer's Retry-After wait in seconds",
    async (status) => {
      expect(
        await enrollWith(answeringWithRetryAfter(status, " 3600 ")),
      ).toEqual({
        kind: "failed",
        detail: `HTTP ${status}: try again`,
        answer: { status, reason: "try again", retryAfterSeconds: 3600 },
      });
    },
  );

  test.each([
    ["an HTTP date", "Wed, 21 Oct 2026 07:28:00 GMT"],
    ["a negative number", "-5"],
    ["a fraction", "1.5"],
    ["a wait past the bound", String(MAX_REGISTRAR_RETRY_AFTER_SECONDS + 1)],
  ])("a Retry-After holding %s states no wait", async (_, retryAfter) => {
    const enrollment = await enrollWith(
      answeringWithRetryAfter(429, retryAfter),
    );
    expect(enrollment).toEqual({
      kind: "failed",
      detail: "HTTP 429: try again",
      answer: { status: 429, reason: "try again" },
    });
  });

  test("a wait at the bound is read", async () => {
    const enrollment = await enrollWith(
      answeringWithRetryAfter(429, String(MAX_REGISTRAR_RETRY_AFTER_SECONDS)),
    );
    expect(enrollment).toMatchObject({
      answer: { retryAfterSeconds: MAX_REGISTRAR_RETRY_AFTER_SECONDS },
    });
  });

  test("an unreachable registrar fails, stating it", async () => {
    expect(await enrollWith(answering([]))).toEqual({
      kind: "failed",
      detail: "it could not be reached (unreachable)",
    });
  });

  test("a registrar client that throws fails, stating the registrar could not be reached", async () => {
    const malformed = (() =>
      Promise.resolve(undefined)) as unknown as typeof globalThis.fetch;
    expect(await enrollWith(malformed)).toEqual({
      kind: "failed",
      detail: "it could not be reached",
    });
  });

  test("the request is cut once the wait passes, and not before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fetch, called } = silent();
    let settled = false;
    const pending = enrollWith(fetch).finally(() => {
      settled = true;
    });
    await called;
    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      kind: "failed",
      detail: `no answer within ${WAIT_MS} ms`,
    });
  });

  test("a cancel during the attempt ends it as cancelled", async () => {
    const cancel = new AbortController();
    const { fetch, called } = silent();
    const pending = enrollWith(fetch, cancel.signal);
    await called;
    cancel.abort();
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
  });

  test("a cancel before the attempt sends nothing", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const fetch = answering([[200, { maxAgeDays: null, lapsesAt: null }]]);
    expect(await enrollWith(fetch, cancel.signal)).toEqual({
      kind: "cancelled",
    });
    expect(fetch.authorizations).toEqual([]);
  });

  test.each([
    ["as is", (value: string) => value],
    ["URL-encoded", (value: string) => encodeURIComponent(value)],
    ["JSON-escaped", (value: string) => JSON.stringify(value).slice(1, -1)],
    ["base64-encoded", (value: string) => btoa(value)],
    [
      "base64-encoded unpadded",
      (value: string) => btoa(value).replace(/=+$/, ""),
    ],
  ])(
    "each of two enrollments sent together repeats neither the other's exchange id nor its relay key %s",
    async (_, form) => {
      const secrets = [generateSharedSecret(), generateSharedSecret()];
      const derived = await Promise.all(
        secrets.map(async (secret) => ({
          exchangeId: await deriveRelayExchangeId(secret),
          key: await deriveRelayKey(secret),
        })),
      );
      const fetch = ((input: string | URL | Request) => {
        const other = derived.find(
          ({ exchangeId }) => !String(input).endsWith(`/${exchangeId}`),
        )!;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: `held by ${form(other.exchangeId)} under ${form(other.key)}`,
            }),
            { status: 409 },
          ),
        );
      }) as typeof globalThis.fetch;
      const enrollments = await Promise.all(
        secrets.map((sharedSecret, at) =>
          enrollRelayKeyWithinWait(
            {
              registrarUrl: REGISTRAR_URL,
              sharedSecret,
              otherSecrets: [secrets[1 - at]!],
            },
            { waitMs: WAIT_MS, fetch },
          ),
        ),
      );
      const reason = `held by ${REMOVED_EXCHANGE_ID_TEXT} under ${REMOVED_RELAY_KEY_TEXT}`;
      const failed = {
        kind: "failed",
        detail: `HTTP 409: ${reason}`,
        answer: { status: 409, reason },
      };
      expect(enrollments).toEqual([failed, failed]);
    },
  );
});

describe("a registrar repeating the exchange id and relay key a request sent", () => {
  /** A registrar refusing each request with an `error` that repeats the
   * exchange id from the request path and the relay key from the body;
   * `echoed` records both. */
  function echoingRegistrar(): typeof globalThis.fetch & {
    echoed: string[];
  } {
    const echoed: string[] = [];
    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const exchangeId = decodeURIComponent(
        String(input).split("/").pop() ?? "",
      );
      const { key } = JSON.parse(String(init?.body)) as { key: string };
      echoed.push(exchangeId, key);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: `exchange ${exchangeId} holds no key ${key}`,
          }),
          { status: 409 },
        ),
      );
    }) as typeof globalThis.fetch & { echoed: string[] };
    fetch.echoed = echoed;
    return fetch;
  }

  const secret = generateSharedSecret();
  test.each<
    [
      string,
      (fetch: typeof globalThis.fetch) => Promise<string>,
      () => Promise<string[]>,
    ]
  >([
    [
      "an enrollment with a token",
      async (fetch) => {
        const outcome = await enrollRelayKey(
          {
            registrar: REGISTRAR,
            sharedSecret: secret,
            maxAgeDays: null,
            ownerToken: "owner-token",
            replace: false,
          },
          { fetch },
        );
        return outcome.kind === "registered"
          ? ""
          : relayRegistrationOutcomeDetail(outcome);
      },
      async () => [REGISTRAR.exchangeId, await deriveRelayKey(secret)],
    ],
    [
      "an enrollment without a token",
      async (fetch) => {
        const enrollment = await enrollRelayKeyWithinWait(
          {
            registrarUrl: "https://registrar.example.org",
            sharedSecret: secret,
          },
          { waitMs: 3_000, fetch },
        );
        return enrollment.kind === "failed" ? enrollment.detail : "";
      },
      async () => [
        await deriveRelayExchangeId(secret),
        await deriveRelayKey(secret),
      ],
    ],
    [
      "a signed registration",
      async (fetch) => {
        const outcome = await registerRelayKey(
          {
            registrar: REGISTRAR,
            signingSecret: secret,
            registeredSecret: secret,
            maxAgeDays: null,
          },
          { fetch },
        );
        return outcome.kind === "registered"
          ? ""
          : relayRegistrationOutcomeDetail(outcome);
      },
      async () => [REGISTRAR.exchangeId, await deriveRelayKey(secret)],
    ],
  ])(
    "%s states the refusal holding neither",
    async (_, register, expectedEchoes) => {
      const fetch = echoingRegistrar();
      const detail = await register(fetch);
      expect(fetch.echoed).toEqual(await expectedEchoes());
      expect(detail).toBe(
        `HTTP 409: exchange ${REMOVED_EXCHANGE_ID_TEXT} holds no key ` +
          REMOVED_RELAY_KEY_TEXT,
      );
    },
  );
});
