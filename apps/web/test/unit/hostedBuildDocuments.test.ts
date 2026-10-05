import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";

import { describe, expect, test } from "vitest";

import {
  declaredRoutes,
  matchesRoutePattern,
} from "../../hosted/declaredRoutes";
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

// Needs `npm run build:hosted -w apps/web` first.
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
