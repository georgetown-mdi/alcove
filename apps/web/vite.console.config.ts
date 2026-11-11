import path from "node:path";

import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";

import {
  bundleNotices,
  bundleNoticesFile,
} from "../../scripts/lib/bundleNotices.mjs";

import {
  browserSshDedupe,
  browserSshDependencyAliases,
  srcAliasEntries,
  zodJitlessChunkOutput,
} from "./vite.config.ts";
import { clientModuleGraphGuard } from "./hosted/moduleGraphGuard.ts";
import { withColorSchemeScript } from "./src/utils/colorSchemeScript.ts";

import type { Plugin } from "vite";

const appRoot = import.meta.dirname;

/** Adds the pre-paint color-scheme script to the console's document, in the
 * build and under `npm run dev:console` alike. */
function consoleColorSchemeScript(): Plugin {
  return {
    name: "alcove-console-color-scheme-script",
    transformIndexHtml: withColorSchemeScript,
  };
}

// Written outside src/, so the checked-in src/routeTree.gen.ts the dev server
// and vitest generate is never rewritten; router.tsx's import of it resolves
// here.
const consoleRouteTree = path.join(
  appRoot,
  ".tanstack/console/routeTree.gen.ts",
);

const notices = bundleNoticesFile();

/**
 * The console's two builds: `vite build` writes the single-page client to
 * `dist/console/`, with the license text of every package it inlines in
 * `third-party-licenses.txt` there, and `vite build --ssr
 * server/console/main.ts` writes the console server, every dependency bundled
 * in, to `dist/console-server/main.mjs`, with the license text of each package
 * it inlines at its head. The server serves the client from the directory
 * beside its own. The client build fails if the page's or a worker's module
 * graph reaches a server-only module or `diffie-hellman`
 * (hosted/moduleGraphGuard.ts).
 */
export default defineConfig(({ isSsrBuild }) => ({
  root: appRoot,
  plugins: [
    tanstackRouter({
      target: "react",
      routesDirectory: path.join(appRoot, "src/routes"),
      generatedRouteTree: consoleRouteTree,
      autoCodeSplitting: true,
      // A route's server handlers stay out of the client bundle; the console
      // server imports the route modules unchanged.
      codeSplittingOptions: { deleteNodes: ["ssr", "server", "headers"] },
      plugin: { vite: { environmentName: "client" } },
    }),
    viteReact(),
    consoleColorSchemeScript(),
    ...(isSsrBuild ? [] : [clientModuleGraphGuard(), notices.client]),
  ],
  worker: { plugins: () => [clientModuleGraphGuard(), notices.worker] },
  resolve: {
    alias: [
      { find: /^\.\/routeTree\.gen$/, replacement: consoleRouteTree },
      ...srcAliasEntries,
      ...browserSshDependencyAliases,
    ],
    dedupe: browserSshDedupe,
  },
  ...(isSsrBuild
    ? {
        ssr: { noExternal: true },
        publicDir: false,
        build: {
          outDir: "dist/console-server",
          emptyOutDir: true,
          rollupOptions: {
            output: { entryFileNames: "main.mjs" },
            plugins: [bundleNotices()],
          },
        },
      }
    : {
        build: {
          outDir: "dist/console",
          emptyOutDir: true,
          rollupOptions: { output: zodJitlessChunkOutput },
        },
      }),
}));
