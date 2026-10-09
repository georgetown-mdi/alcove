import { describe, expect, test } from "vitest";

import { ConnectionError, UsageError } from "../src/errors";
import { MAX_SIGNALING_DISCOVERY_BYTES } from "../src/signalingDiscovery";
import {
  WEB_APP_ADDRESS_REFUSED,
  resolveWebAppSignalingServer,
  webAppOrigin,
} from "../src/webAppSignaling";

const REMEDY = "Give the server itself.";
const APP = new URL("https://app.example.org/");

type Fetch = typeof globalThis.fetch;

function answering(response: () => Response): Fetch {
  return () => Promise.resolve(response());
}

function json(body: unknown): Fetch {
  return answering(() => new Response(JSON.stringify(body)));
}

async function refusal(fetch: Fetch, timeoutMs?: number): Promise<Error> {
  try {
    await resolveWebAppSignalingServer(APP, {
      remedy: REMEDY,
      fetch,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a refusal");
}

describe("resolveWebAppSignalingServer", () => {
  test("reads /alcove.json on the app's origin without following a redirect", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const server = await resolveWebAppSignalingServer(APP, {
      remedy: REMEDY,
      fetch: (input, init) => {
        requests.push({ url: String(input), init });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              signaling_server: "wss://signal.example.org:8443/api/",
            }),
          ),
        );
      },
    });
    expect(server.href).toBe("wss://signal.example.org:8443/api/");
    expect(requests.map(({ url }) => url)).toEqual([
      "https://app.example.org/alcove.json",
    ]);
    expect(requests[0].init?.redirect).toBe("manual");
  });

  test.each([
    [
      "a missing file",
      answering(() => new Response("not found", { status: 404 })),
      /HTTP 404/,
    ],
    [
      "a page instead of a document",
      answering(() => new Response("<!doctype html><html></html>")),
      /not a document naming a ws:\/\/ or wss:\/\/ server/,
    ],
    [
      "a document with no server",
      json({ server: "wss://signal.example.org/api/" }),
      /not a document naming/,
    ],
    [
      "a server URL with a query",
      json({ signaling_server: "wss://signal.example.org/api/?key=x" }),
      /not a document naming/,
    ],
    [
      "a document past the size bound",
      json({
        signaling_server: "wss://signal.example.org/api/",
        padding: "x".repeat(MAX_SIGNALING_DISCOVERY_BYTES),
      }),
      new RegExp(`larger than ${MAX_SIGNALING_DISCOVERY_BYTES} bytes`),
    ],
    [
      "a redirect",
      answering(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://elsewhere.example.org/" },
          }),
      ),
      /redirect \(HTTP 302\), which is not followed/,
    ],
    [
      "a server whose scheme differs from the address's",
      json({ signaling_server: "ws://signal.example.org/api/" }),
      /names a ws:\/\/ server, and an https:\/\/ address needs a wss:\/\/ one/,
    ],
  ])(
    "refuses %s as a usage error ending on the caller's remedy",
    async (_name, fetch, detail) => {
      const err = await refusal(fetch);
      expect(err).toBeInstanceOf(UsageError);
      expect(err.message).toMatch(detail);
      expect(err.message).toMatch(
        /^https:\/\/app\.example\.org does not publish the address of its coordination server at \/alcove\.json /,
      );
      expect(err.message.endsWith(` ${REMEDY}`)).toBe(true);
    },
  );

  test.each([
    [
      "an app that cannot be reached",
      () => Promise.reject(new TypeError("fetch failed")),
      "the request failed",
    ],
    [
      "a server error",
      answering(() => new Response(null, { status: 503 })),
      "HTTP 503",
    ],
    [
      "a connection that fails while the answer is read",
      answering(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('{"signaling_server":"wss://'),
                );
                controller.error(new Error("socket closed"));
              },
            }),
          ),
      ),
      "the connection failed while reading the answer",
    ],
  ] as Array<[string, Fetch, string]>)(
    "reports %s as a transport failure ending on the caller's remedy",
    async (_name, fetch, detail) => {
      const err = await refusal(fetch);
      expect(err).toBeInstanceOf(ConnectionError);
      expect((err as ConnectionError).kind).toBe("transport");
      expect(err.message).toContain(detail);
      expect(err.message).toContain(APP.origin);
      expect(err.message.endsWith(` ${REMEDY}`)).toBe(true);
    },
  );

  test("an app that does not answer within the time bound is a transport failure", async () => {
    const err = await refusal(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
      20,
    );
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).toContain("no answer within 20ms");
    expect(err.message.endsWith(` ${REMEDY}`)).toBe(true);
  });

  test("an address naming more than the app is refused before any request", async () => {
    let requests = 0;
    for (const address of [
      "https://app.example.org/accept#token",
      "https://app.example.org/?q=1",
      "https://user:pw@app.example.org/",
      "wss://app.example.org/",
    ]) {
      const refused = resolveWebAppSignalingServer(new URL(address), {
        remedy: REMEDY,
        fetch: () => {
          requests += 1;
          throw new Error("not reached");
        },
      });
      await expect(refused).rejects.toBeInstanceOf(UsageError);
      await expect(refused).rejects.toThrow(WEB_APP_ADDRESS_REFUSED);
    }
    expect(requests).toBe(0);
  });

  test("webAppOrigin takes a bare web app address to its origin", () => {
    expect(webAppOrigin(new URL("http://127.0.0.1:8080"))).toBe(
      "http://127.0.0.1:8080",
    );
  });
});
