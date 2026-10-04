import path from "node:path";

import { createServer, loadConfigFromFile } from "vite";

import type * as RouteTableModule from "./routeTable.ts";
import type * as StartModule from "./start.ts";

/**
 * The console server for development: the same server `main.ts` starts, its
 * modules loaded through Vite so the app's `@`-prefixed imports resolve as
 * they do in the build, with the aliases read from the app's own Vite config.
 * Run under Node directly (`npm run console-server:dev -w apps/web`): this file
 * imports nothing Node cannot load by itself.
 */

const appRoot = path.resolve(import.meta.dirname, "../..");

const appConfig = await loadConfigFromFile(
  { command: "serve", mode: "development" },
  path.join(appRoot, "vite.config.ts"),
  appRoot,
);
if (appConfig === null)
  throw new Error("The web app's Vite config could not be loaded.");

const vite = await createServer({
  root: appRoot,
  configFile: false,
  appType: "custom",
  server: { middlewareMode: true, ws: false },
  resolve: { alias: appConfig.config.resolve?.alias },
});

const { jobRoutes } = (await vite.ssrLoadModule(
  "/server/console/routeTable.ts",
)) as typeof RouteTableModule;
const { startConsoleServer } = (await vite.ssrLoadModule(
  "/server/console/start.ts",
)) as typeof StartModule;

const { hooks } = await startConsoleServer({ routes: jobRoutes });
hooks.hook("close", () => vite.close());
