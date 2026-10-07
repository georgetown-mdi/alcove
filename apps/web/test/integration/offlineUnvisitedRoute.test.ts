import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium } from "playwright";

import {
  serviceWorkerAssetExtractor,
  serviceWorkerString,
  serviceWorkerStringArray,
} from "../utils/serviceWorkerHarness";

import { deployments } from "./deployments";

import type { Browser } from "playwright";
import type { Served } from "./deployments";

// An ordinary tab that has loaded only the front page, then lost its network,
// opens every other route. That holds only if the route warm ran from the tab
// itself: the shell's install-time graph does not hold any other route's code.
// Driven against the built static site behind the static-host harness, with the
// shipped worker and the app's own registration in a real Chromium.

const WARM_TIMEOUT_MS = 30_000;

const shellRoutes = serviceWorkerStringArray("SHELL_ROUTES");
const shellPath = serviceWorkerString("SHELL_PATH");
const assetCache = `alcove-assets-${serviceWorkerString("CACHE_VERSION")}`;
const hashedAssetPathsIn = serviceWorkerAssetExtractor();

/** The routes opened offline: every warmed route but the one loaded online, with
 * a real-looking id in place of the parameter route's placeholder. */
const unvisitedRoutes = shellRoutes
  .filter((route) => route !== shellPath)
  .map((route) => route.replace(/\/_$/, "/abc123"));

describe.each(deployments)(
  "offline navigation to a route not yet visited, over $name",
  ({ available, serve }) => {
    let served: Served | undefined;
    let browser: Browser | undefined;
    let base = "";
    const routeAssets = new Set<string>();

    beforeAll(async () => {
      if (!available) return;
      served = await serve();
      base = served.base;
      for (const route of shellRoutes) {
        const response = await fetch(`${base}${route}`);
        for (const path of hashedAssetPathsIn(await response.text()))
          routeAssets.add(path);
      }
      browser = await chromium.launch({ headless: true });
    }, 120_000);

    afterAll(async () => {
      await browser?.close();
      await served?.stop();
    });

    test.skipIf(!available)(
      "renders each route from the cache after the front page's warm",
      async () => {
        const context = await browser!.newContext();
        const page = await context.newPage();
        const failedAssets: Array<string> = [];
        page.on("requestfailed", (request) => {
          const path = new URL(request.url()).pathname;
          if (path.startsWith("/assets/")) failedAssets.push(path);
        });

        await page.goto(`${base}/`);
        await page.evaluate(async () => {
          await navigator.serviceWorker.ready;
          if (navigator.serviceWorker.controller !== null) return;
          await new Promise((claimed) =>
            navigator.serviceWorker.addEventListener(
              "controllerchange",
              claimed,
              { once: true },
            ),
          );
        });

        expect(routeAssets.size).toBeGreaterThan(0);
        await expect
          .poll(
            async () => {
              const cached = new Set(
                await page.evaluate(async (name) => {
                  const cache = await caches.open(name);
                  return (await cache.keys()).map(
                    (request) => new URL(request.url).pathname,
                  );
                }, assetCache),
              );
              return [...routeAssets].filter((path) => !cached.has(path));
            },
            { timeout: WARM_TIMEOUT_MS, interval: 250 },
          )
          .toEqual([]);

        await context.setOffline(true);
        for (const route of unvisitedRoutes) {
          await page.goto(`${base}${route}`);
          await page.locator("main").first().waitFor();
          expect(
            await page.getByText("Something went wrong!").count(),
            `offline ${route} rendered the error screen`,
          ).toBe(0);
        }
        expect(failedAssets).toEqual([]);

        await context.close();
      },
      WARM_TIMEOUT_MS + 60_000,
    );

    test.skipIf(!available)(
      "shows the app's own error screen for a route whose code never arrived",
      async () => {
        const context = await browser!.newContext();
        // The route documents are refused, so the warm reads no route's code.
        await context.route(
          (url) =>
            url.pathname !== shellPath && shellRoutes.includes(url.pathname),
          (route) => route.abort(),
        );
        const page = await context.newPage();
        await page.goto(`${base}/`);
        await page.evaluate(async () => {
          await navigator.serviceWorker.ready;
          if (navigator.serviceWorker.controller !== null) return;
          await new Promise((claimed) =>
            navigator.serviceWorker.addEventListener(
              "controllerchange",
              claimed,
              { once: true },
            ),
          );
        });

        await context.setOffline(true);
        const route = unvisitedRoutes[0];
        await page.goto(`${base}${route}`);

        // The router's bare fallback has no actions; these are the app's
        // boundary, which renders only inside the theme provider.
        await page.getByRole("button", { name: "Try again" }).waitFor();
        expect(
          await page.getByText("MantineProvider was not found").count(),
        ).toBe(0);

        await context.close();
      },
      60_000,
    );
  },
);
