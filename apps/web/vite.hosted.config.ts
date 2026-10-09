import path from "node:path";

import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";

import { requireHostedSignalingServer, srcAliases } from "./vite.config.ts";
import { clientModuleGraphGuard } from "./hosted/moduleGraphGuard.ts";
import { deployGraphRecorderFromEnv } from "./hosted/deployGraphRecorder.ts";
import { hostedHeadersFile } from "./hosted/headersFile.ts";
import { hostedRouteDocuments } from "./hosted/routeDocuments.ts";
import { hostedSignalingDiscoveryFile } from "./hosted/signalingDiscoveryFile.ts";

const appRoot = import.meta.dirname;

// Written outside src/, so the checked-in src/routeTree.gen.ts the dev server
// and vitest generate is never rewritten; router.tsx's import of it resolves
// here.
const hostedRouteTree = path.join(appRoot, ".tanstack/hosted/routeTree.gen.ts");

const template = "hosted/index.html";

const hostedConfig = {
  root: appRoot,
  plugins: [
    ...deployGraphRecorderFromEnv(),
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
    hostedHeadersFile(),
    hostedSignalingDiscoveryFile(),
    clientModuleGraphGuard(),
  ],
  worker: {
    plugins: () => [...deployGraphRecorderFromEnv(), clientModuleGraphGuard()],
  },
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
};

/**
 * The hosted app as a static site, and its only build: `npm run build`
 * writes a single-page client to `dist/hosted/`, with one document per route
 * the app-shell worker warms (hosted/routeDocuments.ts), the host's `_headers`
 * (hosted/headersFile.ts), the published coordination server
 * (hosted/signalingDiscoveryFile.ts) and no server. The build fails if the
 * page's or a worker's module graph reaches a server-only module
 * (hosted/moduleGraphGuard.ts).
 */
export default defineConfig((configEnv) => {
  requireHostedSignalingServer(configEnv);
  return hostedConfig;
});
