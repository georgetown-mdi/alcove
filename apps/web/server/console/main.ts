import { jobRoutes } from "./routeTable";
import { startConsoleServer } from "./start";

/** The console server's process entry point. */
await startConsoleServer({ routes: jobRoutes });
