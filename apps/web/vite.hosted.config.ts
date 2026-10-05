import path from "node:path";

import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";

import { hostedRouteDocuments } from "./hosted/routeDocuments.ts";
import { srcAliases } from "./vite.config.ts";

const appRoot = import.meta.dirname;

// Written outside src/, so the checked-in src/routeTree.gen.ts the Start build
// generates is never rewritten; router.tsx's import of it resolves here.
const hostedRouteTree = path.join(appRoot, ".tanstack/hosted/routeTree.gen.ts");

const template = "hosted/index.html";

/**
 * The hosted app as a static site: `vite build --config vite.hosted.config.ts`
 * writes a single-page client to `dist/hosted/`, with one document per route
 * the app-shell worker warms (hosted/routeDocuments.ts) and no server.
 */
export default defineConfig({
  root: appRoot,
  // Read by the root route, whose document this client renders itself.
  define: { "import.meta.env.CLIENT_RENDERED_DOCUMENT": "true" },
  plugins: [
    tanstackRouter({
      target: "react",
      routesDirectory: path.join(appRoot, "src/routes"),
      generatedRouteTree: hostedRouteTree,
      autoCodeSplitting: true,
      codeSplittingOptions: { deleteNodes: ["ssr", "server", "headers"] },
      plugin: { vite: { environmentName: "client" } },
    }),
    viteReact(),
    hostedRouteDocuments(template),
  ],
  resolve: {
    alias: [
      { find: /^\.\/routeTree\.gen$/, replacement: hostedRouteTree },
      ...Object.entries(srcAliases).map(([find, replacement]) => ({
        find,
        replacement,
      })),
    ],
  },
  build: {
    outDir: "dist/hosted",
    emptyOutDir: true,
    manifest: true,
    rollupOptions: { input: path.join(appRoot, template) },
  },
});
