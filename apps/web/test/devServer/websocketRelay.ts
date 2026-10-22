import { createServer } from "node:http";
import { once } from "node:events";

import { RELAY_PATH } from "@alcove/websocket-relay/protocol";
import { attachWebSocketRelay } from "@alcove/websocket-relay";

import type { AddressInfo } from "node:net";
import type { TestProject } from "vitest/node";

// Vitest globalSetup for the `browser` project: the repository's WebSocket
// relay (packages/websocket-relay), attached to a loopback HTTP server in this
// process, for the relay fallback suite (test/browser/relayFallback.test.ts).
// A page dials it over `ws` through the relay client's socket factory. The
// same server answers two test routes, open to any origin since the page's
// is not this one:
// - `GET /enroll?exchange_id=&key=` enrolls a relay key under an exchange id;
// - `GET /forwarded?key=` lists each binary message the relay forwarded on
//   that key's pairing, as read at the relay: its sender and its base64 bytes.

declare module "vitest" {
  interface ProvidedContext {
    websocketRelay?: {
      /** The relay's `ws://` url, its path included. */
      url: string;
      /** The `http://` origin of the test routes. */
      testOrigin: string;
    };
  }
}

/** One binary message the relay forwarded, as `GET /forwarded` lists it. */
export interface ForwardedMessage {
  from: string;
  base64: string;
}

export default async function setup({
  provide,
}: TestProject): Promise<() => Promise<void>> {
  const enrolled = new Map<string, string>();
  const forwarded = new Map<string, Array<ForwardedMessage>>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("Access-Control-Allow-Origin", "*");
    const exchangeId = url.searchParams.get("exchange_id");
    const key = url.searchParams.get("key");
    if (url.pathname === "/enroll" && exchangeId !== null && key !== null) {
      enrolled.set(exchangeId, key);
      response.writeHead(204).end();
    } else if (url.pathname === "/forwarded" && key !== null) {
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(forwarded.get(key) ?? []));
    } else response.writeHead(404).end();
  });
  const relay = attachWebSocketRelay(server, {
    keyTable: { lookup: (exchangeId) => enrolled.get(exchangeId) },
    reportFault: (message) => console.error(`[websocket-relay] ${message}`),
    testing: {
      observer: {
        forwarded: (key, from, data) => {
          let messages = forwarded.get(key);
          if (messages === undefined) {
            messages = [];
            forwarded.set(key, messages);
          }
          messages.push({ from, base64: data.toString("base64") });
        },
      },
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  console.log(`[websocket-relay] on port ${port}`);
  provide("websocketRelay", {
    url: `ws://127.0.0.1:${port}${RELAY_PATH}`,
    testOrigin: `http://127.0.0.1:${port}`,
  });
  return async () => {
    relay.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
}
