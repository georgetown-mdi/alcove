import { resolve } from "node:path";

import { startStaticHost } from "../staticHost/server.js";

import {
  getFreePort,
  hasBuild,
  hasHostedBuild,
  hostedOutput,
  spawnProdServer,
  stopProdServer,
  waitForRoot,
  webRoot,
} from "./prodServer.js";

/** A running deployment: its origin and how to stop it. */
export interface Served {
  readonly base: string;
  readonly stop: () => Promise<void>;
}

/** A production build of the hosted app, as the suites that drive both serve
 * it. */
export interface Deployment {
  readonly name: string;
  /** Whether its build is present; the suite skips it otherwise. */
  readonly available: boolean;
  /** Where its `/assets/` files are on disk. */
  readonly assetsDirectory: string;
  readonly serve: () => Promise<Served>;
}

/** The built Start server (`.output`) and the hosted static site
 * (`dist/hosted`) behind the static-host harness. */
export const deployments: ReadonlyArray<Deployment> = [
  {
    name: "the Start server build",
    available: hasBuild,
    assetsDirectory: resolve(webRoot, ".output/public/assets"),
    async serve() {
      const port = await getFreePort();
      const { child, getLaunchError } = await spawnProdServer(port);
      const base = `http://127.0.0.1:${port}`;
      try {
        await waitForRoot(`${base}/`, child, getLaunchError);
      } catch (error) {
        await stopProdServer(child);
        throw error;
      }
      return { base, stop: () => stopProdServer(child) };
    },
  },
  {
    name: "the hosted static build",
    available: hasHostedBuild,
    assetsDirectory: resolve(hostedOutput, "assets"),
    async serve() {
      const host = await startStaticHost(hostedOutput);
      return { base: host.origin, stop: host.close };
    },
  },
];
