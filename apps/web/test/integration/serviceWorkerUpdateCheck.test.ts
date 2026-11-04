import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { chromium } from "playwright";

import {
  serviceWorkerSource,
  serviceWorkerString,
  serviceWorkerStringArray,
} from "../utils/serviceWorkerHarness";

import type { Browser, Page } from "playwright";
import type { AddressInfo } from "node:net";
import type { ManagedAppUpdatePage } from "./managedAppUpdatePage";
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
//
// It also pins the scheduled runner's between-runs apply
// (apps/web/src/psi/managed/managedAppUpdate.ts) against the real worker: the
// page it reloads is under the new worker with nothing left to apply, and a
// takeover the outgoing worker's route warm holds back past the apply's wait
// costs no reload, and is applied at a later ask once it lands.

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

/** The page of the installed app: the app's registration and its runner's
 * between-runs apply, bundled from `managedAppUpdatePage.ts`. */
const MANAGED_DOCUMENT = `<!doctype html>
<html><head></head><body>
<script type="module" src="/managedAppUpdatePage.js"></script>
</body></html>`;

/** Appended to each deployment's worker so a page can ask which deployment
 * controls it. */
function deploymentReply(deployment: number): string {
  return `self.addEventListener("message", (event) => {
  if (event.data === "deployment?") event.source.postMessage(${String(deployment)});
});`;
}

/** Bundle the installed app's page for the browser. */
async function bundleManagedAppUpdatePage(): Promise<string> {
  const appRoot = fileURLToPath(new URL("../..", import.meta.url));
  const output = await build({
    configFile: false,
    root: appRoot,
    logLevel: "error",
    resolve: { tsconfigPaths: true },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(
          new URL("managedAppUpdatePage.ts", import.meta.url),
        ),
        formats: ["es"],
        fileName: "managedAppUpdatePage",
      },
    },
  });
  const outputs = Array.isArray(output) ? output : [output];
  for (const each of outputs)
    if ("output" in each)
      for (const chunk of each.output)
        if (chunk.type === "chunk" && chunk.isEntry) return chunk.code;
  throw new Error("the page bundle has no entry chunk");
}

/** The routes the worker's route warm fetches past the shell's own. */
const WARM_ROUTE_PATHS = new Set(
  serviceWorkerStringArray("SHELL_ROUTES").filter((route) => route !== "/"),
);

describe("the scheduled runner's apply of a waiting worker", () => {
  let server: Server;
  let origin: string;
  let browser: Browser;
  let deployment = 0;
  /** While set, the warm's route requests are held until released, as a slow
   * network holds the outgoing worker's warm. */
  let holdingWarm = false;
  const heldWarm: Array<() => void> = [];
  let warmRequestHeld = (): void => undefined;

  beforeAll(async () => {
    const worker = serviceWorkerSource();
    const pageBundle = await bundleManagedAppUpdatePage();
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const [type, body] =
        path === "/serviceWorker.js"
          ? [
              "text/javascript; charset=utf-8",
              `${worker}\n${deploymentReply(deployment)}\n`,
            ]
          : path === "/managedAppUpdatePage.js"
            ? ["text/javascript; charset=utf-8", pageBundle]
            : path === "/" || path === "/managed"
              ? ["text/html; charset=utf-8", MANAGED_DOCUMENT]
              : ["text/plain", "ok"];
      const respond = () => {
        response.writeHead(200, {
          "Content-Type": type,
          "Cache-Control": "no-store",
        });
        response.end(body);
      };
      if (holdingWarm && WARM_ROUTE_PATHS.has(path)) {
        heldWarm.push(respond);
        warmRequestHeld();
        return;
      }
      respond();
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

  /** What the page sees of the app's registration. A controller that does not
   * say which deployment it is within two seconds reports -1. */
  function snapshot(page: Page) {
    return page.evaluate(async () => {
      const app: ManagedAppUpdatePage = window.managedAppUpdatePage;
      await app.registered;
      const registration = await navigator.serviceWorker.getRegistration();
      const controller = navigator.serviceWorker.controller;
      const controllingDeployment =
        controller === null
          ? undefined
          : await new Promise<number>((answered) => {
              setTimeout(() => {
                answered(-1);
              }, 2000);
              navigator.serviceWorker.addEventListener(
                "message",
                (event: MessageEvent<number>) => {
                  answered(event.data);
                },
                { once: true },
              );
              controller.postMessage("deployment?");
            });
      return {
        controllingDeployment,
        waiting: registration?.waiting !== null,
        updateReady: app.updateReady(),
      };
    });
  }

  /** A page of the installed app controlled by deployment `deployment`, with
   * a newer deployment found and waiting behind it. */
  async function pageWithUpdateWaiting(): Promise<{
    page: Page;
    current: number;
  }> {
    deployment += 1;
    const current = deployment;
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/managed`);
    await expect
      .poll(async () => (await snapshot(page)).controllingDeployment, {
        timeout: 10_000,
      })
      .toBe(current);
    return { page, current };
  }

  async function findUpdate(page: Page): Promise<void> {
    deployment += 1;
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });
    await expect
      .poll(
        () => page.evaluate(() => window.managedAppUpdatePage.updateReady()),
        { timeout: 10_000 },
      )
      .toBe(true);
  }

  /** Ask the runner's apply where it reloads the page, resolving once the
   * reloaded page has loaded, with what the ask answered. */
  async function askAcrossReload(page: Page): Promise<string | null> {
    const reloaded = page.waitForEvent("load");
    await page.evaluate(() => {
      void window.managedAppUpdatePage.applyBetweenRuns().then((applied) => {
        sessionStorage.setItem("applied", String(applied));
      });
    });
    await reloaded;
    return page.evaluate(() => sessionStorage.getItem("applied"));
  }

  const askHere = (page: Page) =>
    page.evaluate(() => window.managedAppUpdatePage.applyBetweenRuns());

  it("reloads once the waiting worker has taken over, so the reloaded page is under it with nothing left to apply", async () => {
    const { page } = await pageWithUpdateWaiting();
    await findUpdate(page);
    const next = deployment;

    expect(await askAcrossReload(page)).toBe("true");

    expect(await snapshot(page)).toEqual({
      controllingDeployment: next,
      waiting: false,
      updateReady: false,
    });
    expect(await askHere(page)).toBe(false);
    await page.context().close();
  }, 60_000);

  it("whose takeover the outgoing worker's warm holds past the wait, makes no reload, and applies at a later ask once it lands", async () => {
    const { page, current } = await pageWithUpdateWaiting();
    const held = new Promise<void>((requested) => {
      warmRequestHeld = requested;
    });
    holdingWarm = true;
    try {
      await page.evaluate((warm) => {
        navigator.serviceWorker.controller?.postMessage(warm);
      }, serviceWorkerString("WARM_ROUTES_MESSAGE"));
      await held;
      await findUpdate(page);
      const next = deployment;
      const { loadedAt, takeoverWaitMs } = await page.evaluate(() => ({
        loadedAt: window.managedAppUpdatePage.loadedAt,
        takeoverWaitMs: window.managedAppUpdatePage.takeoverWaitMs,
      }));

      const askedAt = Date.now();
      expect(await askHere(page)).toBe(false);
      expect(Date.now() - askedAt).toBeGreaterThanOrEqual(takeoverWaitMs - 50);
      // No reload: the same document, still under the outgoing worker, so the
      // window makes its attempt on the current version.
      expect(
        await page.evaluate(() => window.managedAppUpdatePage.loadedAt),
      ).toBe(loadedAt);
      expect(await snapshot(page)).toEqual({
        controllingDeployment: current,
        waiting: true,
        updateReady: true,
      });

      holdingWarm = false;
      for (const respond of heldWarm.splice(0)) respond();
      await expect
        .poll(async () => (await snapshot(page)).controllingDeployment, {
          timeout: 10_000,
        })
        .toBe(next);
      expect(await snapshot(page)).toEqual({
        controllingDeployment: next,
        waiting: false,
        updateReady: true,
      });

      expect(await askAcrossReload(page)).toBe("true");
      expect(await snapshot(page)).toEqual({
        controllingDeployment: next,
        waiting: false,
        updateReady: false,
      });
      expect(await askHere(page)).toBe(false);
    } finally {
      holdingWarm = false;
      for (const respond of heldWarm.splice(0)) respond();
      await page.context().close();
    }
  }, 60_000);
});
