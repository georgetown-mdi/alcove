import { createServer } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";

import { serviceWorkerSource } from "../utils/serviceWorkerHarness";

import type { Browser, Page } from "playwright";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// When a real Chromium looks for a redeployed worker on its own, against an
// origin whose worker script a test can redeploy. The integration project
// rather than the browser one: the browser project's pages are served by the
// dev server, which cannot change a worker script's bytes between two looks.
//
// What it pins: an open page that makes requests but no navigation is never
// told of a new deployment, a navigation is what makes the browser look, and
// `registration.update()` looks at once -- which is why the scheduled runner
// asks for a look itself (apps/web/src/psi/managed/managedScheduleRuntime.ts).
// What it cannot pin: Chromium's own longer timers, such as the 24-hour
// staleness rule, which no test waits out.

const DOCUMENT = `<!doctype html>
<html><head></head><body>
<script>navigator.serviceWorker.register("/serviceWorker.js", { updateViaCache: "none" });</script>
</body></html>`;

/** How long the idle page is watched for a look of the browser's own. */
const IDLE_WATCH_MS = 8_000;

describe("the browser's own look for a redeployed worker", () => {
  let server: Server;
  let origin: string;
  let browser: Browser;
  let deployment = 1;
  let workerFetches = 0;

  beforeAll(async () => {
    const worker = serviceWorkerSource();
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/serviceWorker.js") {
        workerFetches += 1;
        response.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(`${worker}\n// deployment ${String(deployment)}\n`);
        return;
      }
      response.writeHead(200, {
        "Content-Type":
          path === "/" ? "text/html; charset=utf-8" : "text/plain",
        "Cache-Control": "no-store",
      });
      response.end(path === "/" ? DOCUMENT : "ok");
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

  /** A page controlled by the worker of the deployment served now. */
  async function controlledPage(): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller !== null) return;
      await new Promise((claimed) =>
        navigator.serviceWorker.addEventListener("controllerchange", claimed, {
          once: true,
        }),
      );
    });
    return page;
  }

  /** Whether a worker other than the controlling one is installing or
   * waiting: the state a found deployment sits in. */
  function newWorkerFound(page: Page): Promise<boolean> {
    return page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return (
        registration !== undefined &&
        (registration.installing !== null || registration.waiting !== null)
      );
    });
  }

  it("is not made by an open page that only fetches, and is made by update() at once", async () => {
    deployment = 1;
    const page = await controlledPage();
    deployment = 2;
    const fetchesBefore = workerFetches;

    // An idle app's own traffic: requests through the worker, timers, no
    // navigation.
    await page.evaluate(async (watchMs) => {
      const until = Date.now() + watchMs;
      while (Date.now() < until) {
        await fetch(`/ping?${String(Date.now())}`);
        await new Promise((tick) => setTimeout(tick, 250));
      }
    }, IDLE_WATCH_MS);

    expect(workerFetches).toBe(fetchesBefore);
    expect(await newWorkerFound(page)).toBe(false);

    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });

    expect(workerFetches).toBe(fetchesBefore + 1);
    expect(await newWorkerFound(page)).toBe(true);
    await page.context().close();
  }, 60_000);

  it("is made at a navigation", async () => {
    deployment = 3;
    const page = await controlledPage();
    deployment = 4;
    const fetchesBefore = workerFetches;

    await page.reload();

    await expect
      .poll(() => newWorkerFound(page), { timeout: 10_000 })
      .toBe(true);
    expect(workerFetches).toBeGreaterThan(fetchesBefore);
    await page.context().close();
  }, 60_000);
});
