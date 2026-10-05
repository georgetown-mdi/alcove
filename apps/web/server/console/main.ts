import path from "node:path";

import { jobRoutes } from "./routeTable";
import { startConsoleServer } from "./start";

/** The console server's process entry point, run as the bundle `npm run
 * build:console-server` writes beside the client `npm run build:console`
 * writes. */
await startConsoleServer({
  routes: jobRoutes,
  staticRoot: path.resolve(import.meta.dirname, "../console"),
});
