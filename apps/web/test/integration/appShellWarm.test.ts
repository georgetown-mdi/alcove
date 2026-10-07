import { extname } from "node:path";
import { readdirSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  declaredRoutePaths,
  matchesRoutePattern,
} from "../../hosted/declaredRoutes";

import {
  serviceWorkerAssetExtractor,
  serviceWorkerStorableExtensions,
  serviceWorkerString,
  serviceWorkerStringArray,
} from "../utils/serviceWorkerHarness";

import { deployments } from "./deployments";

import type { Served } from "./deployments";

// The app-shell worker discovers what to cache by reading `/assets/...` paths
// out of the documents the server sends (`hashedAssetPathsIn`), not from a
// build-time manifest -- a coupling to how the build emits module preloads
// that no unit test can hold. This drives the real deployment: the static site
// `npm run build -w apps/web` writes (`dist/hosted`) behind the static-host
// harness. Rebuild before re-running to validate a change; CI always rebuilds
// first.

const READY_TIMEOUT_MS = 30_000;

/** What a page asks the worker to warm, and where the shell's own
 * install-time graph comes from -- both read from the shipped worker. */
const shellRoutes = serviceWorkerStringArray("SHELL_ROUTES");
const shellPath = serviceWorkerString("SHELL_PATH");
const hashedAssetPathsIn = serviceWorkerAssetExtractor();

describe.each(deployments)(
  "the route warm's asset extraction, over $name",
  ({ available, assetsDirectory, serve }) => {
    let served: Served | undefined;
    let base = "";
    /** What the worker's extraction reads out of each warmed route's served
     * document: the assets warming that route would store. */
    const chunksByRoute = new Map<string, Array<string>>();

    beforeAll(async () => {
      if (!available) return;
      served = await serve();
      base = served.base;

      for (const route of shellRoutes) {
        const response = await fetch(`${base}${route}`);
        const document = await response.text();
        if (!response.ok)
          throw new Error(
            `the deployment answered the warmed route ${route} with ` +
              `${response.status}; SHELL_ROUTES names a path this deployment ` +
              `does not serve`,
          );
        chunksByRoute.set(route, hashedAssetPathsIn(document));
      }
    }, READY_TIMEOUT_MS + 20_000);

    afterAll(async () => {
      await served?.stop();
    });

    test.skipIf(!available)(
      "finds assets in every warmed route's document",
      () => {
        const empty = [...chunksByRoute]
          .filter(([, chunks]) => chunks.length === 0)
          .map(([route]) => route);

        expect(empty).toEqual([]);
      },
    );

    test.skipIf(!available)(
      "names only assets this deployment serves",
      async () => {
        const named = [...new Set([...chunksByRoute.values()].flat())];
        expect(named.length).toBeGreaterThan(0);

        const unserved: Array<string> = [];
        for (const path of named) {
          const response = await fetch(`${base}${path}`);
          // Release the socket: only the status matters here.
          await response.body?.cancel();
          if (!response.ok) unserved.push(`${path} (${response.status})`);
        }

        expect(unserved).toEqual([]);
      },
    );

    test.skipIf(!available)(
      "emits only extensions the worker's media-type map can store",
      () => {
        const builtAssets = readdirSync(assetsDirectory, {
          recursive: true,
          withFileTypes: true,
        }).filter((entry) => entry.isFile());
        const storable = serviceWorkerStorableExtensions();
        const emitted = [
          ...new Set(builtAssets.map((entry) => extname(entry.name).slice(1))),
        ];
        expect(emitted.length).toBeGreaterThan(0);

        const missing = emitted.filter(
          (extension) => !storable.includes(extension),
        );
        expect(
          missing,
          `the build emits /assets/ files with extensions ${JSON.stringify(missing)} ` +
            `that ASSET_CONTENT_TYPES in serviceWorker.js (${JSON.stringify(storable)}) ` +
            `does not list, so the worker never stores them; add each to the map`,
        ).toEqual([]);
      },
    );

    test.skipIf(!available)(
      "brings each declared route code the shell's own graph does not",
      () => {
        const shellGraph = new Set(chunksByRoute.get(shellPath) ?? []);
        const declared = declaredRoutePaths();
        // Neither the install graph nor the route list may be empty, or the
        // comparison below would pass by having nothing to compare.
        expect(shellGraph.size).toBeGreaterThan(0);
        expect(declared.length).toBeGreaterThan(1);

        const unwarmed = declared.filter((pattern) => {
          // The shell path is the install-time graph itself, so it has nothing to
          // add beyond it.
          if (pattern === shellPath) return false;
          const warmed = shellRoutes.filter((route) =>
            matchesRoutePattern(pattern, route),
          );
          return !warmed.some((route) =>
            (chunksByRoute.get(route) ?? []).some(
              (chunk) => !shellGraph.has(chunk),
            ),
          );
        });

        expect(unwarmed).toEqual([]);
      },
    );
  },
);
