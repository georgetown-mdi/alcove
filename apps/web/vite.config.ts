/// <reference types="vitest/config" />
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { defineConfig, loadEnv } from "vite";
import logLibrary from "loglevel";
import { nitroV2Plugin } from "@tanstack/nitro-v2-vite-plugin";
import { playwright } from "@vitest/browser-playwright";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

import { ConfigManager } from "./src/utils/serverConfig.ts";
import { DEV_SIGNALING_PORT_ENV } from "./src/utils/devSignalingPort.ts";

// A type-only import, erased before either config loader resolves anything.
import type * as liveWebrtcLeg from "./test/liveWebrtc/legCommands.ts";
import type { ConfigEnv, Plugin, ProxyOptions } from "vite";

const configManager = new ConfigManager();
const config = await configManager.load({ dotenv: true });

// Set by a vitest run, and by nothing a dev server or a build does.
const underVitest = !!process.env.VITEST;

// The Node half of the live CLI-to-browser WebRTC leg, registered as browser
// commands on the `live-webrtc` project below. It lives in the test tree, which
// the image's builder stage does not copy (Dockerfile), and the config loader
// BUNDLES this file: every literal specifier in it is resolved, a dynamic
// import's included, taken branch or not. Building the path at runtime leaves
// the loader nothing to resolve (scripts/check-web-config-image-load.mjs).
const liveWebrtcLegCommands = underVitest
  ? (
      (await import(
        pathToFileURL(
          path.resolve(import.meta.dirname, "test/liveWebrtc/legCommands.ts"),
        ).href
      )) as typeof liveWebrtcLeg
    ).liveWebrtcLegCommands
  : {};

logLibrary.setDefaultLevel(config.LOG_LEVEL);

// Vite resolution for the `@`-prefixed imports the app uses, shared so the
// inline vitest projects (which do not inherit the root `resolve`) resolve them
// too. tsconfig provides these via explicit `paths` plus a `@*` -> `./src/*`
// catch-all; `@psi` here stands in for that catch-all, which the unit project
// needs because its `src/psi` sources pull in `@utils/*`.
export const srcAliases = {
  "@components": path.resolve(import.meta.dirname, "src/components"),
  "@console": path.resolve(import.meta.dirname, "src/console"),
  "@exchange": path.resolve(import.meta.dirname, "src/exchange"),
  "@jobs": path.resolve(import.meta.dirname, "src/jobs"),
  "@recurring": path.resolve(import.meta.dirname, "src/recurring"),
  "@styles": path.resolve(import.meta.dirname, "src/styles"),
  "@utils": path.resolve(import.meta.dirname, "src/utils"),
  "@psi": path.resolve(import.meta.dirname, "src/psi"),
  "@theme": path.resolve(import.meta.dirname, "src/theme"),
  "@": path.resolve(import.meta.dirname, "src"),
};

// The WASM PSI worker engine. It is imported only by src/psi/workers/psiCrypto.worker.ts, a
// `new Worker(new URL(...))` entry Vite's dependency scanner does not traverse, so it
// is not discovered at startup. Without pre-bundling it in `optimizeDeps.include`, the
// worker's first spawn triggers a dependency re-optimize and a full page reload
// mid-exchange -- which fails a browser test (the reloaded exchange errors) and reloads
// a `npm run dev` session. It must be listed on BOTH the browser test project (below)
// AND the dev server via the root `optimizeDeps` (further below), because the inline
// vitest projects do not inherit the root config -- the same reason srcAliases is
// duplicated. Dev/test only; the production build code-splits the worker and inlines
// its WASM, so `optimizeDeps` never affects `vite build`.
const psiWorkerWasmEngine = "@openmined/psi.js/psi_wasm_worker";

// The features Playwright disables for test stability, in its own order. The
// installed package exports no entry point reaching them, so they are copied
// here and test/integration/chromiumDisableFeaturesSwitch.test.ts holds the
// copy against a real Chromium launch, failing on a bump that changes the list.
const playwrightDisabledFeatures = [
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "BoundaryEventDispatchTracksNodeRemoval",
  "DestroyProfileOnBrowserClose",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "HttpsUpgrades",
  "LensOverlay",
  "MediaRouter",
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "BlockOriginHeaderModificationOnRedirect",
  "Translate",
  "AutoDeElevate",
  "OptimizationHints",
  "msForceBrowserSignIn",
  "msEdgeUpdateLaunchServicesPreferredVersion",
];

// The one --disable-features switch the browser projects launch with. Chromium
// keeps only the LAST --disable-features switch on a command line instead of
// merging duplicates -- measured 2026-09-21 against the chromium playwright
// 1.62.1 installs, where a switch after Playwright's own put the mDNS
// obfuscation back on -- so the feature these projects need is composed into
// Playwright's list rather than passed on a switch of its own.
const browserDisableFeaturesSwitch = `--disable-features=${[
  ...playwrightDisabledFeatures,
  "WebRtcHideLocalIpsWithMdns",
].join(",")}`;

// The Elastic Beanstalk deploy trigger (.github/workflows/eb_deploy.yaml) is a
// hand-written path filter over the sources this build reads, and the bundler is
// the only thing that knows what that set actually is. When
// scripts/check-deploy-trigger-graph.mjs sets this variable, the build records
// every module id it resolves so the check can hold the filter against the real
// graph instead of predicting it. Unset -- every developer build, every CI build
// that is not that check -- no plugin is added at all.
const deployGraphRecordPath = process.env.ALCOVE_DEPLOY_GRAPH_RECORD;

// Records the module ids of one build into recordPath. It contributes no hook
// that can resolve, load, or rewrite a module (`transform` returns null), so the
// artifact a recorded build produces is the artifact a plain build produces --
// which is what makes the recording evidence about the deployed server rather
// than about a build shaped to be measured. Each environment closes its own
// bundle, so the write merges with what is already there; the check names a path
// in a scratch directory of its own, so no earlier run carries into it.
function deployGraphRecorder(recordPath: string): Plugin {
  const moduleIds = new Set<string>();
  return {
    name: "alcove-deploy-graph-recorder",
    apply: "build",
    transform(_code, id) {
      moduleIds.add(id);
      return null;
    },
    closeBundle() {
      let recorded: Array<string> = [];
      try {
        recorded = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      fs.writeFileSync(
        recordPath,
        JSON.stringify([...new Set([...recorded, ...moduleIds])].sort()),
      );
    },
  };
}

/**
 * Refuses a `vite build` for the hosted profile (`VITE_DEPLOYMENT_PROFILE`
 * unset or `hosted`) when `VITE_SIGNALING_SERVER_URL` is unset or blank: the
 * app's own origin serves no signaling. `vite dev` and the console profile
 * fall back to the origin's `/api/`.
 */
export function requireHostedSignalingServer({
  command,
  mode,
}: Pick<ConfigEnv, "command" | "mode">): void {
  if (command !== "build") return;
  const env = loadEnv(mode, import.meta.dirname, "VITE_");
  if (env["VITE_DEPLOYMENT_PROFILE"] === "console") return;
  const signalingServerUrl = env["VITE_SIGNALING_SERVER_URL"] as
    string | undefined;
  if (signalingServerUrl === undefined || signalingServerUrl.trim() === "")
    throw new Error(
      "VITE_SIGNALING_SERVER_URL is not set. A hosted build needs the address of the standalone peer-coordination broker, because the app's own origin serves no signaling. Set it to the broker's ws: or wss: URL and rebuild.",
    );
}

// This server mounts no broker, so its /api/ forwards to the standalone one.
function devSignalingProxy(): Record<string, ProxyOptions> {
  const raw = process.env[DEV_SIGNALING_PORT_ENV];
  if (raw === undefined || raw === "") return {};
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(port >= 1 && port <= 65_535))
    throw new Error(
      `${DEV_SIGNALING_PORT_ENV} must be a port number from 1 to 65535; got ${JSON.stringify(raw)}`,
    );
  return { "/api/": { target: `http://127.0.0.1:${port}`, ws: true } };
}

export default defineConfig((configEnv) => {
  requireHostedSignalingServer(configEnv);
  return {
    server: {
      host: "127.0.0.1",
      port: config.PORT,
      proxy: devSignalingProxy(),
    },
    test: {
      // Run-level, not per-project: vitest reads these once for the run rather
      // than per project, so every project below -- and every project added
      // later -- is covered without registering anything of its own.
      //
      // The dist guard fails the run when the built @alcove/core these suites
      // import is older than its sources, instead of letting the run report
      // failures that belong to the build. The prerequisite guard names (and, in
      // CI, fails on) an environment tool a suite would otherwise skip over
      // silently. The reporter names every skipped test at the end of the run,
      // so a leg that quietly stopped running is visible rather than folded into
      // a count.
      globalSetup: [
        "../../scripts/lib/coreDistFreshness.mjs",
        "./test/requireTestPrerequisites.ts",
      ],
      reporters: ["default", "../../scripts/lib/skippedLegReporter.mjs"],
      // Coverage is an informational REPORT, produced on demand by `npm run
      // coverage` (see package.json), never a gate: there is deliberately NO
      // `thresholds` line (see CONTRIBUTING.md, Coverage). The script runs the
      // unit (node) and browser (real Chromium) projects together and merges
      // their results, so the component, live-exchange, and consent-gate paths
      // exercised only in the browser no longer read as near-zero. Browser
      // coverage is folded into this default run rather than kept a separate
      // opt-in because the report is on-demand and never gates: its cost is
      // paid only when asked for, with no CI stability bar to protect.
      // The integration project stays out: it is a black-box HTTP suite that
      // fetches a separately-spawned dev-server process and imports no src, so
      // under --coverage it measures the empty runner process, not the server.
      // Capturing that server-entry/route-handler code is feasible -- run the
      // spawned server under NODE_V8_COVERAGE and merge its profile -- but
      // low-value: a bespoke merge step outside Vitest's model, to cover thin
      // server-entry and route glue whose behavior the integration suite
      // already asserts end-to-end. So it is out of scope, not a deferred gap.
      coverage: {
        provider: "v8",
        // text -> terminal summary; html + lcov -> browsable/tooling report
        // under coverage/.
        reporter: ["text", "html", "lcov"],
        // Confine the denominator to product source: the test/ suite, fixtures,
        // and this config are all siblings of src/, so scoping include here
        // keeps them out of the report.
        include: ["src/**"],
        // vitest applies its own default excludes (node_modules, the config,
        // test files) on top of these, so list only the code that lives inside
        // src/ but is not hand-written product code.
        exclude: [
          // TanStack Router codegen (routeTree.gen.ts).
          "**/*.gen.ts",
        ],
      },
      projects: [
        {
          test: {
            include: [
              "test/unit/**/*.{test,spec}.ts",
              "test/**/*.unit.{test,spec}.ts",
            ],
            name: "unit",
            environment: "node",
          },
          resolve: { alias: srcAliases },
        },
        {
          test: {
            include: [
              "test/integration/**/*.{test,spec}.ts",
              "test/**/*.integration.{test,spec}.ts",
            ],
            name: "integration",
            environment: "node",
            // requireProdBuild runs FIRST: it fails the project when the built
            // server the suites drive is absent, before the dev server is paid
            // for. It is scoped to this project -- the `browser` project below
            // shares the dev-server setup and needs no production build.
            globalSetup: [
              "./test/integration/requireProdBuild.ts",
              "./test/devServer/globalSetup.ts",
            ],
          },
        },
        {
          test: {
            include: ["test/interop/**/*.{test,spec}.ts"],
            name: "interop",
            environment: "node",
            // The cross-runtime suite: a real `alcove` child process meeting a
            // party built from this app's own exchange modules. A project of its
            // own rather than a file in `integration`, because it needs neither
            // the production server build nor the dev server that project's
            // globalSetup pays for -- its whole world is a temporary directory.
            //
            // A test here is a whole exchange: a rendezvous, a key exchange, and
            // a PSI round per linkage key, with a cold-started Node process
            // loading a WASM engine on one side -- and the arm that pins the web
            // path's AEAD refusal additionally waits out the CLI party's peer
            // budget. The default 5s bounds none of that, and the real deadlines
            // are the ones the file sets: each party's peer budget, and a hard
            // per-invocation kill on the child.
            testTimeout: 180_000,
            globalSetup: ["./test/interop/requireCliBuild.ts"],
          },
          resolve: { alias: srcAliases },
        },
        {
          test: {
            include: [
              "test/browser/**/*.{test,spec}.{ts,tsx}",
              "test/**/*.browser.{test,spec}.{ts,tsx}",
            ],
            name: "browser",
            // The same broker and dev-server setup as the integration project,
            // so a cold `test:browser` is green.
            globalSetup: ["./test/devServer/globalSetup.ts"],
            // A suite's tests share one page, whose session storage would otherwise
            // carry an invitation one test minted into the next test's file step.
            setupFiles: ["./test/browser/clearSessionStorage.ts"],
            browser: {
              // These suites name a locator by a substring of the element's
              // rendered accessible name, which vitest's default exact
              // matching rejects.
              locators: { exact: false },
              // invitedPSI opens a real WebRTC DataConnection between two
              // same-machine peers that configure no STUN/TURN (hermetic -- see
              // invitedPSI.test.ts), so a loopback host candidate is the only way
              // they can connect. Chromium otherwise obfuscates host candidates
              // as `.local` mDNS names that do not resolve in containers/CI (no
              // mDNS responder), leaving no usable candidate -- the connection
              // never opens and the exchange hangs. Disabling the mDNS
              // obfuscation exposes the real loopback host candidate so the peers
              // connect directly. Test browser only -- no effect on the dev
              // server or `npm run build`.
              provider: playwright({
                launchOptions: {
                  args: [browserDisableFeaturesSwitch],
                },
              }),
              headless: true,
              enabled: true,
              // Vitest's default viewport is phone-sized (414x896), below the
              // app's narrow cut-over (NARROW_VIEWPORT_MAX_WIDTH), which would
              // silently flip every suite into the narrow layout. Pin the
              // project to a wide desktop viewport so the wide layout is the
              // deterministic default; a narrow-layout test opts in with
              // page.viewport and restores this default afterwards.
              viewport: { width: 1280, height: 800 },
              instances: [{ browser: "chromium" }],
            },
          },
          // Component browser tests import app sources that use the `@`-prefixed
          // aliases (e.g. `@components/*`, `@psi/*`); like the unit project, the
          // browser project must resolve them since the inline projects do not
          // inherit the root `resolve`.
          resolve: { alias: srcAliases },
          // Pre-bundle the PSI worker engine here too: this project runs the tests
          // that spawn the crypto worker (exchangeLifecycle, psiCryptoWorker), and it
          // does not inherit the root `optimizeDeps`, so without this its first spawn
          // reloads the run on a cold optimizer cache (see psiWorkerWasmEngine).
          optimizeDeps: { include: [psiWorkerWasmEngine] },
        },
        {
          test: {
            include: ["test/liveWebrtc/**/*.{test,spec}.ts"],
            name: "live-webrtc",
            // The live CLI-to-browser leg: a real `alcove` process and a real
            // browser peer completing one WebRTC exchange through the
            // standalone broker. A project of its own, off every other script,
            // because it needs the built CLI and minutes of real ICE, DTLS and
            // WASM work per run -- it runs nightly rather than on a pull
            // request (.github/workflows/nightly_live_webrtc.yaml, and
            // docs/TESTING.md for why).
            //
            // It stands up no dev server: the broker it meets the CLI at is a
            // process of its own, on an origin that is NOT this page's, and the
            // leg's Node side starts it (test/liveWebrtc/legCommands.ts).
            testTimeout: 420_000,
            hookTimeout: 120_000,
            browser: {
              // The same substring locator matching as the browser project
              // above, for the same reason.
              locators: { exact: false },
              // The same loopback-candidate reasoning as the browser project
              // above: the two peers configure a public STUN list they cannot
              // reach here, so a host candidate is the only one that connects,
              // and Chromium otherwise obfuscates those as `.local` mDNS names
              // that do not resolve in a container.
              provider: playwright({
                launchOptions: {
                  args: [browserDisableFeaturesSwitch],
                },
              }),
              headless: true,
              enabled: true,
              instances: [{ browser: "chromium" }],
              // The broker and the `alcove` party the browser half cannot
              // spawn itself. Registered here because this is where vitest
              // takes them; the implementations are in the test tree.
              commands: liveWebrtcLegCommands,
            },
          },
          resolve: { alias: srcAliases },
        },
      ],
    },
    plugins: [
      ...(deployGraphRecordPath
        ? [deployGraphRecorder(deployGraphRecordPath)]
        : []),
      tanstackStart({
        srcDirectory: "src",
      }),
      nitroV2Plugin({ preset: "node-server" }),
      viteReact(),
    ],
    resolve: {
      tsconfigPaths: true,
      alias: srcAliases,
    },
    optimizeDeps: {
      // Pre-bundle the PSI worker engine for the dev server (`npm run dev`) so a first
      // exchange does not reload the page. The browser test project sets its own copy,
      // since inline vitest projects do not inherit this root config (see
      // psiWorkerWasmEngine).
      include: [psiWorkerWasmEngine],
    },
  };
});
