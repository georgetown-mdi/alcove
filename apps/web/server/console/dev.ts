import path from "node:path";

import { createServer } from "vite";

import type * as RouteTableModule from "./routeTable.ts";
import type * as StartModule from "./start.ts";

/**
 * The console for development (`npm run dev:console -w apps/web`): the same
 * server `main.ts` starts, with the client served by Vite in middleware mode
 * on the same origin in place of the built bundle, and the server's own
 * modules loaded through the console's Vite config so the app's `@`-prefixed
 * imports resolve as they do in the build. Run under Node directly: this file
 * imports nothing Node cannot load by itself.
 */

const appRoot = path.resolve(import.meta.dirname, "../..");

const vite = await createServer({
  root: appRoot,
  configFile: path.join(appRoot, "vite.console.config.ts"),
  appType: "spa",
  server: { middlewareMode: true, ws: false },
});

const { jobRoutes } = (await vite.ssrLoadModule(
  "/server/console/routeTable.ts",
)) as typeof RouteTableModule;
const { startConsoleServer } = (await vite.ssrLoadModule(
  "/server/console/start.ts",
)) as typeof StartModule;

const { hooks } = await startConsoleServer({
  routes: jobRoutes,
  clientMiddleware: vite.middlewares,
});
hooks.hook("close", () => vite.close());
