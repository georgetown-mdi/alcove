import { createServer } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";

import {
  serviceWorkerSource,
  serviceWorkerString,
} from "../utils/serviceWorkerHarness";

import type { AddressInfo } from "node:net";
import type { Browser } from "playwright";
import type { Server } from "node:http";

// The integration project rather than the unit one: this launches a real
// Chromium, which CI installs before this project runs (web_build_and_test.yaml).
//
// The origin here behaves as a static host with a single-page fallback does:
// every path it has no file for answers 200 with the app document as
// text/html, an unknown build asset included. The shipped worker runs in the
// browser against it, and the asset cache is read back from the page.

const PRESENT_ASSET = "/assets/present-AAAA1111.js";
const MISSING_ASSET = "/assets/missing-BBBB2222.js";

const FALLBACK_DOCUMENT = `<!doctype html>
<html><head>
<link rel="modulepreload" href="${PRESENT_ASSET}">
<link rel="modulepreload" href="${MISSING_ASSET}">
</head><body>
<script>navigator.serviceWorker.register("/serviceWorker.js");</script>
</body></html>`;

describe("the service worker on a host that answers a missing asset with its app document", () => {
  let server: Server;
  let origin: string;
  let browser: Browser;
  const requested: Array<string> = [];

  beforeAll(async () => {
    const worker = serviceWorkerSource();
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      requested.push(path);
      if (path === "/serviceWorker.js" || path === PRESENT_ASSET) {
        response.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(path === PRESENT_ASSET ? "export {};" : worker);
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(FALLBACK_DOCUMENT);
    });
    await new Promise<void>((listening) =>
      server.listen(0, "127.0.0.1", listening),
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser.close();
    await new Promise<void>((closed) => server.close(() => closed()));
  });

  it("serves the fallback document to the page and stores only the real asset", async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/`);
    // Install precaches the document's asset graph, the missing asset among
    // it; activate claims the page, after which its fetches pass the worker.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller !== null) return;
      await new Promise((claimed) =>
        navigator.serviceWorker.addEventListener("controllerchange", claimed, {
          once: true,
        }),
      );
    });
    const requestsBefore = requested.filter(
      (path) => path === MISSING_ASSET,
    ).length;

    const served = await page.evaluate(async (path) => {
      const response = await fetch(path);
      return {
        status: response.status,
        contentType: response.headers.get("Content-Type"),
        body: await response.text(),
        controlled: navigator.serviceWorker.controller !== null,
      };
    }, MISSING_ASSET);
    const cached = await page.evaluate(
      async (name) => {
        const cache = await caches.open(name);
        return (await cache.keys()).map(
          (request) => new URL(request.url).pathname,
        );
      },
      `alcove-assets-${serviceWorkerString("CACHE_VERSION")}`,
    );

    expect(served.controlled).toBe(true);
    expect(served.status).toBe(200);
    expect(served.contentType).toContain("text/html");
    expect(served.body).toBe(FALLBACK_DOCUMENT);
    expect(
      requested.filter((path) => path === MISSING_ASSET).length,
    ).toBeGreaterThan(requestsBefore);
    expect(cached).toEqual([PRESENT_ASSET]);
  }, 60_000);
});
