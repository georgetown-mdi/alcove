import path from "node:path";

import { exitOnBootFailure, startConsoleServer } from "./start";
import { jobRoutes } from "./routeTable";

/** The console server's process entry point, run as the bundle `npm run
 * build:console-server` writes beside the client `npm run build:console`
 * writes. */
await startConsoleServer({
  routes: jobRoutes,
  staticRoot: path.resolve(import.meta.dirname, "../console"),
}).catch(exitOnBootFailure);
