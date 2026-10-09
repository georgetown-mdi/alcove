import { createServer } from "node:http";

import { afterEach, describe, expect, test } from "vitest";
import {
  ConnectionError,
  MAX_SIGNALING_DISCOVERY_BYTES,
  UsageError,
} from "@alcove/core";

import { WEB_APP_ADDRESS_REFUSED } from "../../src/connectionFromUrl";
import { exitCodeForError } from "../../src/util/exit";
import { resolveWebAppSignalingServer } from "../../src/webAppSignaling";

import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

/** A loopback web app answering every request with `handler`; resolves to its
 * address and the paths it was asked for. */
async function webApp(
  handler: Handler,
): Promise<{ address: URL; requested: Array<string> }> {
  const requested: Array<string> = [];
  const server = createServer((request, response) => {
    requested.push(request.url ?? "");
    handler(request, response);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  const { port } = server.address() as AddressInfo;
  return { address: new URL(`http://127.0.0.1:${port}/`), requested };
}

function json(body: unknown): Handler {
  return (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a refusal");
}

describe("resolveWebAppSignalingServer", () => {
  test("dials the server the app publishes at /alcove.json", async () => {
    const { address, requested } = await webApp(
      json({ signaling_server: "ws://signal.example.org:8443/api/" }),
    );
    const server = await resolveWebAppSignalingServer(address);
    expect(server.href).toBe("ws://signal.example.org:8443/api/");
    expect(requested).toEqual(["/alcove.json"]);
  });

  test.each([
    [
      "a missing file",
      (_request: IncomingMessage, response: ServerResponse) => {
        response.writeHead(404);
        response.end("not found");
      },
      /HTTP 404/,
    ],
    [
      "the static host's page fallback",
      (_request: IncomingMessage, response: ServerResponse) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><html></html>");
      },
      /not a document naming a ws:\/\/ or wss:\/\/ server/,
    ],
    [
      "a document with no server",
      json({ server: "ws://signal.example.org/api/" }),
      /not a document naming/,
    ],
    [
      "a non-ws URL",
      json({ signaling_server: "http://signal.example.org/api/" }),
      /not a document naming/,
    ],
    [
      "a URL with a query",
      json({ signaling_server: "ws://signal.example.org/api/?key=x" }),
      /not a document naming/,
    ],
    [
      "an oversized answer",
      json({
        signaling_server: "ws://signal.example.org/api/",
        padding: "x".repeat(MAX_SIGNALING_DISCOVERY_BYTES),
      }),
      /larger than 4096 bytes/,
    ],
    [
      "a redirect",
      (_request: IncomingMessage, response: ServerResponse) => {
        response.writeHead(302, { location: "http://elsewhere.example.org/" });
        response.end();
      },
      /redirect \(HTTP 302\), which is not followed/,
    ],
    [
      "a server whose scheme differs from the address's",
      json({ signaling_server: "wss://signal.example.org/api/" }),
      /names a wss:\/\/ server, and an http:\/\/ address needs a ws:\/\/ one/,
    ],
  ])(
    "refuses %s as a usage error naming the address and the forms that work",
    async (_name, handler, detail) => {
      const { address } = await webApp(handler);
      const err = await refusal(resolveWebAppSignalingServer(address));
      expect(err).toBeInstanceOf(UsageError);
      expect(exitCodeForError(err)).toBe(64);
      expect(err.message).toMatch(detail);
      expect(err.message).toContain(
        `${address.origin} does not publish the address of its coordination server at /alcove.json`,
      );
      expect(err.message).toContain("wss://<server>/api/");
      expect(err.message).toContain("`channel: webrtc` in alcove.yaml");
    },
  );

  test("a server error is a transport failure", async () => {
    const { address } = await webApp((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    const err = await refusal(resolveWebAppSignalingServer(address));
    expect(err).toBeInstanceOf(ConnectionError);
    expect(exitCodeForError(err)).toBe(69);
    expect(err.message).toContain("HTTP 503");
  });

  test("an app that does not answer in time is a transport failure", async () => {
    const { address } = await webApp(() => {
      // Never answers.
    });
    const err = await refusal(
      resolveWebAppSignalingServer(address, { timeoutMs: 50 }),
    );
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).toContain("no answer within 50ms");
  });

  test("a connection that fails while the answer is read is a transport failure", async () => {
    const { address } = await webApp((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": "64",
      });
      response.write('{"signaling_server":"ws://');
      setTimeout(() => response.socket?.destroy(), 20);
    });
    const err = await refusal(resolveWebAppSignalingServer(address));
    expect(err).toBeInstanceOf(ConnectionError);
    expect(exitCodeForError(err)).toBe(69);
    expect(err.message).toContain(
      "the connection failed while reading the answer",
    );
  });

  test("an app nothing listens at is a transport failure", async () => {
    const { address } = await webApp(json({}));
    await servers.splice(0)[0].close();
    const err = await refusal(resolveWebAppSignalingServer(address));
    expect(err).toBeInstanceOf(ConnectionError);
    expect(exitCodeForError(err)).toBe(69);
    expect(err.message).toContain(address.origin);
  });

  test("an address naming more than the app is refused before any request", async () => {
    let requests = 0;
    const err = await refusal(
      resolveWebAppSignalingServer(
        new URL("https://app.example.org/accept#token"),
        {
          fetch: () => {
            requests += 1;
            throw new Error("not reached");
          },
        },
      ),
    );
    expect(err.message).toBe(WEB_APP_ADDRESS_REFUSED);
    expect(requests).toBe(0);
  });

  test("an https address takes a wss server and fetches over https", async () => {
    const fetched: Array<string> = [];
    const server = await resolveWebAppSignalingServer(
      new URL("https://app.example.org/"),
      {
        fetch: (input) => {
          fetched.push(String(input));
          return Promise.resolve(
            new Response(
              JSON.stringify({
                signaling_server: "wss://signal.example.org:8443/api/",
              }),
            ),
          );
        },
      },
    );
    expect(fetched).toEqual(["https://app.example.org/alcove.json"]);
    expect(server.href).toBe("wss://signal.example.org:8443/api/");
  });
});
