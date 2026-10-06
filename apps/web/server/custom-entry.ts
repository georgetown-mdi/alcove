import { Server as HttpServer } from "node:http";
import { Server as HttpsServer } from "node:https";

import {
  setupGracefulShutdown,
  startScheduleRunner,
  trapUnhandledNodeErrors,
  // @ts-ignore available at runtime
} from "nitropack/runtime/internal";

// @ts-ignore available at runtime
import "#nitro-internal-pollyfills";

import { useNitroApp, useRuntimeConfig } from "nitropack/runtime";
import { toNodeListener } from "h3";

import { getLogger, setLogLevel } from "@alcove/core";

import {
  bootSftpCredentialScratchDir,
  registerJobManagerShutdown,
  warnJobApiProfileMismatch,
  warnJobRendezvousProvisioning,
} from "../src/jobs/index";
import { ConfigManager } from "../src/utils/serverConfig";
import { jobApiRequestTimeoutMs } from "../src/jobs/routeSupport";

import { attachRequestAbortSignal } from "./requestAbortSignal";
import { hardenUpgradeSurface } from "./upgradeHardening";

import type { AddressInfo } from "node:net";

const configManager = new ConfigManager();
const config = await configManager.load();

const cert = process.env.NITRO_SSL_CERT;
const key = process.env.NITRO_SSL_KEY;

setLogLevel(config.LOG_LEVEL);

const log = getLogger("server-entry");

const nitroApp = useNitroApp();

// Give each handler's `request.signal` the client disconnect.
nitroApp.hooks.hook("request", attachRequestAbortSignal);

const server =
  cert && key
    ? // @ts-ignore part of preset
      new HttpsServer({ key, cert }, toNodeListener(nitroApp.h3App))
    : // @ts-ignore part of preset
      new HttpServer(toNodeListener(nitroApp.h3App));

// Bound a slow or partial request (slowloris) on this server. With the job API
// enabled, the whole-request bound is sized to its largest upload instead.
const requestTimeoutMs = jobApiRequestTimeoutMs();
hardenUpgradeSurface(
  server,
  requestTimeoutMs === undefined ? {} : { requestTimeoutMs },
);

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
const port = (config.PORT || 3000) as number;
const host = process.env.NITRO_HOST || process.env.HOST;

const path = process.env.NITRO_UNIX_SOCKET;

// Fail closed on the pasted-credential scratch directory: when the job API is
// enabled, assert it resolves outside the data root and rendezvous mount, create
// it owner-only, and sweep any credential a prior run orphaned. A no-op when the
// API is disabled.
bootSftpCredentialScratchDir();

// Warn (non-fatal) when JOB_DATA_ROOT is set on a non-console build, so the job
// API stays disabled: the app enables it only in a console build.
warnJobApiProfileMismatch();

// Warn (non-fatal) when the rendezvous mounts cannot run a filedrop exchange as
// provisioned, so an incoherent split pair is reported at boot rather than only at
// the invite chooser, and when a leg's real path could not be read for the pair's
// containment check. SFTP on the same appliance is unaffected.
warnJobRendezvousProvisioning();

// @ts-ignore part of preset
const listener = server.listen(path ? { path } : { port, host }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  const protocol = cert && key ? "https" : "http";
  const addressInfo = listener.address() as AddressInfo;
  if (typeof addressInfo === "string") {
    log.info(`Listening on unix socket ${addressInfo}`);
    return;
  }
  const baseURL = (useRuntimeConfig().app.baseURL || "").replace(/\/$/, "");
  const url = `${protocol}://${
    addressInfo.family === "IPv6"
      ? `[${addressInfo.address}]`
      : addressInfo.address
  }:${addressInfo.port}${baseURL}`;
  log.info(`Listening on ${url}`);
});

// Trap unhandled errors
trapUnhandledNodeErrors();

// Stop the running CLI child on shutdown and hold the process until it has
// exited, so no orphaned CLI outlives the server. A no-op when the job API was
// never enabled. Registered BEFORE the graceful-shutdown handler, whose signal
// listener must run after the child has been signalled.
registerJobManagerShutdown(nitroApp.hooks);

// Graceful shutdown
setupGracefulShutdown(listener, nitroApp);

// Scheduled tasks
if (import.meta._tasks) {
  startScheduleRunner();
}

export default {};
