import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";

import { ConnectionError } from "../../src/connection/messageConnection";
import { UsageError } from "../../src/errors";
import type { ServerProvision } from "../../src/config/connection";
import {
  DEFAULT_PROVISION_PORT,
  callProvisionEndpoint,
  provisionEndpointLabel,
  provisionRequest,
  serverProvisionOf,
} from "../../src/config/serverProvision";
import { sanitizeErrorForDisplay } from "../../src/utils/sanitizeErrorForDisplay";

const BEARER = "provision-bearer-0123";
const PATH = "/wake/path-token-4567";

const provision: ServerProvision = {
  host: "api.example.org",
  path: PATH,
  auth: { bearer: BEARER },
};

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** A fetch answering every call with `status`, recording what it was sent and
 * whether the body was read. */
function fakeFetch(status: number, body = "server-said-something-secret") {
  const calls: RecordedCall[] = [];
  const state = { bodyCancelled: false, bodyRead: false };
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          state.bodyRead = true;
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
        cancel() {
          state.bodyCancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const nullBody = status === 204 || (status >= 300 && status < 400);
    return new Response(nullBody ? null : stream, {
      status,
      headers:
        nullBody && status >= 300
          ? { location: "https://other.example.org/" }
          : {},
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls, state };
}

/** Render a failure the way the CLI shows it, so an assertion over it covers
 * the whole cause chain. */
function rendered(err: unknown): string {
  return String(sanitizeErrorForDisplay(err));
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

// --- serverProvisionOf -------------------------------------------------------

test("serverProvisionOf reads the block on sftp and webrtc and none on filedrop", () => {
  expect(
    serverProvisionOf({
      channel: "sftp",
      server: { host: "h", provision },
    }),
  ).toBe(provision);
  expect(
    serverProvisionOf({
      channel: "webrtc",
      role: "acceptor",
      server: { host: "h", provision },
    }),
  ).toBe(provision);
  expect(
    serverProvisionOf({ channel: "sftp", server: { host: "h" } }),
  ).toBeUndefined();
  expect(
    serverProvisionOf({ channel: "filedrop", path: "/drop" }),
  ).toBeUndefined();
});

// --- provisionRequest --------------------------------------------------------

test("provisionRequest composes a POST to https host:443/path with a bearer header", () => {
  const { url, init } = provisionRequest(provision);
  expect(url.href).toBe(`https://api.example.org${PATH}`);
  expect(url.port).toBe("");
  expect(DEFAULT_PROVISION_PORT).toBe(443);
  expect(init.method).toBe("POST");
  expect(init.redirect).toBe("manual");
  expect(init.body).toBeUndefined();
  expect(init.headers.get("accept")).toBe("application/json");
  expect(init.headers.get("authorization")).toBe(`Bearer ${BEARER}`);
});

test("provisionRequest takes a stated port, defaults the path to /, and prefixes a bare one", () => {
  expect(
    provisionRequest({ host: "api.example.org", port: 8443 }).url.href,
  ).toBe("https://api.example.org:8443/");
  expect(
    provisionRequest({ host: "api.example.org", path: "start" }).url.href,
  ).toBe("https://api.example.org/start");
  expect(provisionRequest({ host: "::1", port: 9000 }).url.href).toBe(
    "https://[::1]:9000/",
  );
});

test("provisionRequest keeps a query string in the path", () => {
  expect(
    provisionRequest({ host: "api.example.org", path: "/start?id=7" }).url.href,
  ).toBe("https://api.example.org/start?id=7");
});

test("provisionRequest sends HTTP Basic credentials as UTF-8 base64", () => {
  const { init } = provisionRequest({
    host: "api.example.org",
    auth: { username: "user", password: "päss" },
  });
  const header = init.headers.get("authorization") ?? "";
  expect(header.startsWith("Basic ")).toBe(true);
  expect(Buffer.from(header.slice(6), "base64").toString("utf8")).toBe(
    "user:päss",
  );
});

test("provisionRequest sends no authorization header without auth", () => {
  const { init } = provisionRequest({ host: "api.example.org" });
  expect(init.headers.has("authorization")).toBe(false);
});

/** The refusal `provisionRequest` raises for `host`, which must throw. */
function hostRefusal(host: string): Error {
  try {
    provisionRequest({ host });
  } catch (err) {
    return err as Error;
  }
  throw new Error(`provisionRequest accepted ${JSON.stringify(host)}`);
}

test.each([
  ["a path segment", "api.example.org/other"],
  ["userinfo", "user@other.example.org"],
  ["a query", "api.example.org?x"],
  ["a fragment", "api.example.org#x"],
  ["a port", "api.example.org:8080"],
  ["a space", "api example.org"],
  ["a tab", "api.example.org\tother.example.org"],
  ["a carriage return", "api.example.org\rother.example.org"],
  ["a line feed", "api.example.org\nother.example.org"],
  ["an underscore", "api_host.example.org"],
  ["a non-ASCII letter", "münchen.example.org"],
  ["a percent-escape", "api%2eexample.org"],
])(
  "provisionRequest refuses a host holding %s, naming the field",
  (_, host) => {
    const refusal = hostRefusal(host);
    expect(refusal).toBeInstanceOf(UsageError);
    expect(refusal.message).toContain(
      "connection.server.provision.host holds a character a host name cannot contain",
    );
    expect(refusal.message).not.toContain(host);
  },
);

test.each([
  ["a hexadecimal IPv4 address", "0x7f.1"],
  ["a shortened IPv4 address", "127.1"],
  ["an IPv6 address with a zero run written out", "[0:0::1]"],
  ["an IPv4-mapped IPv6 address in dotted form", "::ffff:127.0.0.1"],
])(
  "provisionRequest refuses %s the URL parser would rewrite, naming the field",
  (_, host) => {
    const refusal = hostRefusal(host);
    expect(refusal).toBeInstanceOf(UsageError);
    expect(refusal.message).toContain(
      "connection.server.provision.host is not in the form the request would use",
    );
    expect(refusal.message).not.toContain(host);
  },
);

test.each([
  ["a mixed-case name", "API.Example.org", "api.example.org"],
  [
    "an internationalized name in its xn-- form",
    "xn--mnchen-3ya.de",
    "xn--mnchen-3ya.de",
  ],
  ["an IPv4 address", "127.0.0.1", "127.0.0.1"],
  ["a bare IPv6 address", "::1", "[::1]"],
  ["a bracketed IPv6 address", "[::1]", "[::1]"],
])("provisionRequest sends to %s as written", (_, host, hostname) => {
  expect(provisionRequest({ host }).url.hostname).toBe(hostname);
});

test("provisionRequest keeps a protocol-relative-looking path on the configured host", () => {
  const { url } = provisionRequest({
    host: "api.example.org",
    path: "//other.example.org/x",
  });
  expect(url.host).toBe("api.example.org");
});

test.each([
  ["a line break", "tok\nen-secret"],
  ["a carriage return", "tok\ren-secret"],
  ["a space", "tok en-secret"],
  ["a non-ASCII character", "tokén-secret"],
  ["nothing", ""],
])(
  "provisionRequest refuses a bearer holding %s, naming the field only",
  (_, bearer) => {
    let err: unknown;
    try {
      provisionRequest({ host: "api.example.org", auth: { bearer } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain(
      "connection.server.provision.auth.bearer",
    );
    expect(rendered(err)).not.toContain("secret");
  },
);

test("provisionRequest refuses a Basic username holding a colon", () => {
  expect(() =>
    provisionRequest({
      host: "api.example.org",
      auth: { username: "a:b", password: "pw-secret" },
    }),
  ).toThrow("connection.server.provision.auth.username holds a colon");
});

// --- callProvisionEndpoint: classification ----------------------------------

test.each([200, 201, 202, 204])(
  "an HTTP %s answer resolves, sending one POST",
  async (status) => {
    const { fetch, calls } = fakeFetch(status);
    await expect(
      callProvisionEndpoint(provision, { fetch }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.example.org${PATH}`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  },
);

test.each([
  [
    401,
    UsageError,
    "refused the credentials in connection.server.provision.auth (HTTP 401)",
  ],
  [
    403,
    UsageError,
    "refused the credentials in connection.server.provision.auth (HTTP 403)",
  ],
  [404, UsageError, "refused the request (HTTP 404)"],
  [400, UsageError, "refused the request (HTTP 400)"],
  [301, UsageError, "answered with a redirect (HTTP 301)"],
  [302, UsageError, "answered with a redirect (HTTP 302)"],
  [307, UsageError, "answered with a redirect (HTTP 307)"],
  [408, ConnectionError, "could not start the server (HTTP 408)"],
  [429, ConnectionError, "could not start the server (HTTP 429)"],
  [500, ConnectionError, "could not start the server (HTTP 500)"],
  [503, ConnectionError, "could not start the server (HTTP 503)"],
])(
  "an HTTP %s answer rejects with %o",
  async (status, errorClass, fragment) => {
    const { fetch, state } = fakeFetch(status);
    const err = await caught(callProvisionEndpoint(provision, { fetch }));
    expect(err).toBeInstanceOf(errorClass);
    if (err instanceof ConnectionError) expect(err.kind).toBe("transport");
    expect((err as Error).message).toContain(
      "the provisioning endpoint at api.example.org:443",
    );
    expect((err as Error).message).toContain(fragment);
    expect(state.bodyRead).toBe(false);
    const shown = rendered(err);
    expect(shown).not.toContain(BEARER);
    expect(shown).not.toContain("path-token");
    expect(shown).not.toContain("server-said-something-secret");
  },
);

test("the response body is cancelled unread on success", async () => {
  const { fetch, state } = fakeFetch(200);
  await callProvisionEndpoint(provision, { fetch });
  expect(state.bodyRead).toBe(false);
  expect(state.bodyCancelled).toBe(true);
});

test("a fetch that rejects is a transport failure naming the endpoint, the cause kept", async () => {
  const networkFailure = new TypeError("fetch failed", {
    cause: new Error("getaddrinfo ENOTFOUND api.example.org"),
  });
  const fetch = (async () => {
    throw networkFailure;
  }) as typeof globalThis.fetch;
  const err = await caught(callProvisionEndpoint(provision, { fetch }));
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect((err as Error).message).toContain(
    "could not reach the provisioning endpoint at api.example.org:443",
  );
  expect((err as Error).cause).toBe(networkFailure);
  expect(rendered(err)).not.toContain("path-token");
});

test("provisionEndpointLabel names host and port, never the path", () => {
  expect(provisionEndpointLabel(provision)).toBe(
    "the provisioning endpoint at api.example.org:443",
  );
  expect(provisionEndpointLabel({ host: "::1", port: 8080 })).toBe(
    "the provisioning endpoint at [::1]:8080",
  );
});

// --- real fetch against a loopback server -----------------------------------
// The request always goes to https; these route the composed request to a
// plain-http loopback server by rewriting the scheme and authority only, so the
// options the real fetch receives (redirect, signal, headers) are the ones
// callProvisionEndpoint composed.

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function loopbackFetch(port: number): typeof globalThis.fetch {
  return ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    url.protocol = "http:";
    url.host = `127.0.0.1:${port}`;
    return globalThis.fetch(url, init);
  }) as typeof globalThis.fetch;
}

test("real fetch: a redirect is not followed and the credential never reaches its target", async () => {
  const targetRequests: http.IncomingHttpHeaders[] = [];
  const targetPort = await listen((req, res) => {
    targetRequests.push(req.headers);
    res.writeHead(200).end();
  });
  const received: { method?: string; headers?: http.IncomingHttpHeaders }[] =
    [];
  const port = await listen((req, res) => {
    received.push({ method: req.method, headers: req.headers });
    res
      .writeHead(302, { location: `http://127.0.0.1:${targetPort}/stolen` })
      .end();
  });
  const err = await caught(
    callProvisionEndpoint(provision, { fetch: loopbackFetch(port) }),
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain(
    "answered with a redirect (HTTP 302)",
  );
  expect(received).toHaveLength(1);
  expect(received[0].method).toBe("POST");
  expect(received[0].headers?.authorization).toBe(`Bearer ${BEARER}`);
  expect(targetRequests).toHaveLength(0);
});

test("real fetch: a 2xx answer resolves", async () => {
  const port = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await expect(
    callProvisionEndpoint(provision, { fetch: loopbackFetch(port) }),
  ).resolves.toBeUndefined();
});

test("real fetch: an endpoint that never answers times out as a transport failure", async () => {
  const port = await listen(() => {
    // Hold the request open: no answer is ever written.
  });
  const err = await caught(
    callProvisionEndpoint(provision, {
      fetch: loopbackFetch(port),
      timeoutMs: 200,
    }),
  );
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect((err as Error).message).toContain(
    "the provisioning endpoint at api.example.org:443 did not answer within 200ms",
  );
});

test("real fetch: a refused connection is a transport failure that shows no path", async () => {
  const port = await listen(() => {});
  const server = servers.pop();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  const err = await caught(
    callProvisionEndpoint(provision, { fetch: loopbackFetch(port) }),
  );
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  const shown = rendered(err);
  expect(shown).toContain("could not reach the provisioning endpoint");
  expect(shown).not.toContain("path-token");
  expect(shown).not.toContain(BEARER);
});
