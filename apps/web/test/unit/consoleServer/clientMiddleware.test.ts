import http from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import {
  createConsoleHandler,
  createConsoleServer,
  listenConsoleServer,
} from "../../../server/console/app";

import { send } from "./serverHarness";

import type { AddressInfo } from "node:net";
import type { ClientMiddleware } from "../../../server/console/app";

const servers: Array<http.Server> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Start the console server with no job routes and `middleware` answering
 * client requests, and resolve with its port. */
async function serveClient(middleware: ClientMiddleware): Promise<number> {
  const server = createConsoleServer(createConsoleHandler({ routes: [] }), {
    clientMiddleware: middleware,
  });
  servers.push(server);
  await listenConsoleServer(server, { port: 0, host: "127.0.0.1" });
  return (server.address() as AddressInfo).port;
}

describe("the development client middleware", () => {
  test("a request the middleware passes on answers 404", async () => {
    const port = await serveClient((_req, _res, next) => next());
    const answer = await send(port, { path: "/exchange" });
    expect(answer.status).toBe(404);
    expect(answer.headers["x-content-type-options"]).toBe("nosniff");
  });

  test("a middleware error before the response starts answers 500", async () => {
    const port = await serveClient((_req, _res, next) =>
      next(new Error("transform failed")),
    );
    expect((await send(port, { path: "/exchange" })).status).toBe(500);
  });

  test("a middleware error after the response started closes the connection", async () => {
    const port = await serveClient((_req, res, next) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial", () => next(new Error("transform failed")));
    });
    const complete = await new Promise<boolean>((resolve, reject) => {
      const request = http.get(
        { host: "127.0.0.1", port, path: "/exchange", agent: false },
        (response) => {
          response.resume();
          response.on("close", () => resolve(response.complete));
        },
      );
      request.on("error", reject);
    });
    expect(complete).toBe(false);
  });
});
