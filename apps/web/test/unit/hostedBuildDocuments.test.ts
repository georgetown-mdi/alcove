import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  declaredRoutes,
  matchesRoutePattern,
} from "../../hosted/declaredRoutes";
import hostedConfig from "../../vite.hosted.config";
import { requireHostedSignalingServer } from "../../vite.config";
import { routeDocumentFileName } from "../../hosted/routeDocuments";
import { serviceWorkerStringArray } from "../../hosted/serviceWorkerSource";

interface ManifestChunk {
  file: string;
  src?: string;
  imports?: Array<string>;
}

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const outDirectory = `${appRoot}dist/hosted/`;
const manifestPath = `${outDirectory}.vite/manifest.json`;

// Needs `npm run build -w apps/web` first.
describe.skipIf(!existsSync(manifestPath))("the built route documents", () => {
  const readManifest = () =>
    JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      ManifestChunk
    >;

  function staticClosureFiles(
    manifest: Record<string, ManifestChunk>,
    keys: Array<string>,
  ): Set<string> {
    const files = new Set<string>();
    const seen = new Set<string>();
    const pending = [...keys];
    for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
      const chunk = manifest[key] as ManifestChunk | undefined;
      if (seen.has(key) || chunk === undefined) continue;
      seen.add(key);
      files.add(chunk.file);
      pending.push(...(chunk.imports ?? []));
    }
    return files;
  }

  test.each(serviceWorkerStringArray("SHELL_ROUTES"))(
    "%s links every chunk its route file statically imports",
    (route) => {
      const manifest = readManifest();
      const routeFiles = declaredRoutes()
        .filter((declared) => matchesRoutePattern(declared.path, route))
        .map((declared) => relative(appRoot, declared.file));
      const holdingKeys = Object.keys(manifest).filter((key) =>
        routeFiles.includes(manifest[key].src?.replace(/\?.*$/, "") ?? ""),
      );
      const entryKeys = Object.keys(manifest).filter(
        (key) => manifest[key].src === "hosted/index.html",
      );
      const document = readFileSync(
        `${outDirectory}${routeDocumentFileName(route)}`,
        "utf8",
      );
      const linked = new Set(
        [...document.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map(
          (match) => match[1],
        ),
      );

      expect(holdingKeys.length + entryKeys.length).toBeGreaterThan(0);
      const missing = [
        ...staticClosureFiles(manifest, [...holdingKeys, ...entryKeys]),
      ].filter((file) => !linked.has(file));
      expect(missing).toEqual([]);
    },
  );
});

describe("the hosted build's signaling control", () => {
  afterEach(() => vi.unstubAllEnvs());

  const resolve = () =>
    (
      hostedConfig as (env: {
        mode: string;
        command: "build";
      }) => Record<string, unknown>
    )({ mode: "production", command: "build" });

  test.each(["", "   "])("refuses a build with the variable %j", (value) => {
    vi.stubEnv("VITE_SIGNALING_SERVER_URL", value);
    expect(resolve).toThrow(/VITE_SIGNALING_SERVER_URL/);
  });

  test("builds when the variable holds a value", () => {
    vi.stubEnv("VITE_SIGNALING_SERVER_URL", "wss://signaling.example.org/api/");
    expect(resolve()).toHaveProperty("build.outDir", "dist/hosted");
  });
});

describe("the Start build's signaling control", () => {
  afterEach(() => vi.unstubAllEnvs());

  const check = (command: "build" | "serve") => () =>
    requireHostedSignalingServer({ command, mode: "production" });

  test.each([undefined, "hosted"])(
    "refuses a build for the profile %j without the variable",
    (profile) => {
      vi.stubEnv("VITE_DEPLOYMENT_PROFILE", profile);
      vi.stubEnv("VITE_SIGNALING_SERVER_URL", undefined);
      expect(check("build")).toThrow(/VITE_SIGNALING_SERVER_URL/);
    },
  );

  test("leaves the console build to its own origin", () => {
    vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
    vi.stubEnv("VITE_SIGNALING_SERVER_URL", undefined);
    expect(check("build")).not.toThrow();
  });

  test("leaves the dev server to its own origin", () => {
    vi.stubEnv("VITE_DEPLOYMENT_PROFILE", undefined);
    vi.stubEnv("VITE_SIGNALING_SERVER_URL", undefined);
    expect(check("serve")).not.toThrow();
  });
});
