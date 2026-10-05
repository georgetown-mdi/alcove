import path from "node:path";

import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";

import { srcAliases } from "./vite.config.ts";

const appRoot = import.meta.dirname;

// Written outside src/, so the checked-in src/routeTree.gen.ts the hosted
// build generates is never rewritten; router.tsx's import of it resolves here.
const consoleRouteTree = path.join(
  appRoot,
  ".tanstack/console/routeTree.gen.ts",
);

/**
 * The console's two builds: `vite build` writes the single-page client to
 * `dist/console/`, and `vite build --ssr server/console/main.ts` writes the
 * console server, every dependency bundled in, to
 * `dist/console-server/main.mjs`. The server serves the client from the
 * directory beside its own.
 */
export default defineConfig(({ isSsrBuild }) => ({
  root: appRoot,
  // Read by the root route, whose document this client renders itself.
  define: { "import.meta.env.CLIENT_RENDERED_DOCUMENT": "true" },
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
  ],
  resolve: {
    alias: [
      { find: /^\.\/routeTree\.gen$/, replacement: consoleRouteTree },
      ...Object.entries(srcAliases).map(([find, replacement]) => ({
        find,
        replacement,
      })),
    ],
  },
  ...(isSsrBuild
    ? {
        ssr: { noExternal: true },
        publicDir: false,
        build: {
          outDir: "dist/console-server",
          emptyOutDir: true,
          rollupOptions: { output: { entryFileNames: "main.mjs" } },
        },
      }
    : { build: { outDir: "dist/console", emptyOutDir: true } }),
}));
