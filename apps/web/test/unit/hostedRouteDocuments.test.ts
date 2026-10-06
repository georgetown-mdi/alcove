import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  hostedRouteDocuments,
  routeDocumentFileName,
} from "../../hosted/routeDocuments";
import { declaredRoutes } from "../../hosted/declaredRoutes";
import { rootDocumentHead } from "../../src/utils/documentHead";
import { serviceWorkerStringArray } from "../../hosted/serviceWorkerSource";
import { trackScratchDirs } from "../utils/jobFixtures";

import type { HtmlTagDescriptor, Plugin, Rollup } from "vite";

// The hosted build's document writer, driven over a fabricated bundle. This
// holds the writer's own rules: every warmed route gets a document, a route's document
// names its static import graph and stylesheets, and nothing it imports lazily.

const routesDirectory = fileURLToPath(
  new URL("../../src/routes", import.meta.url),
);
const template = "hosted/index.html";
const templateHtml = [
  "<!doctype html>",
  "<html>",
  "  <head>",
  '    <script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script>',
  '    <link rel="modulepreload" crossorigin href="/assets/jsx-BBBBBBBB.js">',
  '    <link rel="stylesheet" crossorigin href="/assets/index-AAAAAAAA.css">',
  "  </head>",
  "  <body></body>",
  "</html>",
].join("\n");

function chunk(
  fileName: string,
  moduleIds: Array<string>,
  imports: Array<string>,
  importedCss: Array<string> = [],
  dynamicImports: Array<string> = [],
): Rollup.OutputChunk {
  return {
    type: "chunk",
    fileName,
    moduleIds,
    imports,
    dynamicImports,
    viteMetadata: {
      importedCss: new Set(importedCss),
      importedAssets: new Set(),
    },
  } as unknown as Rollup.OutputChunk;
}

function fabricatedBundle(
  entryRouteFiles = declaredRoutes().map(({ file }) => file),
): Rollup.OutputBundle {
  const accept = join(routesDirectory, "accept.tsx");
  const chunks = [
    chunk(
      "assets/index-AAAAAAAA.js",
      [join(routesDirectory, "__root.tsx"), ...entryRouteFiles],
      ["assets/jsx-BBBBBBBB.js"],
      ["assets/index-AAAAAAAA.css"],
    ),
    chunk("assets/jsx-BBBBBBBB.js", ["/jsx.js"], []),
    chunk(
      "assets/accept-CCCCCCCC.js",
      [`${accept}?tsr-split=component`],
      ["assets/index-AAAAAAAA.js", "assets/panel-DDDDDDDD.js"],
      ["assets/accept-CCCCCCCC.css"],
      ["assets/lazy-FFFFFFFF.js"],
    ),
    chunk(
      "assets/panel-DDDDDDDD.js",
      ["/panel.tsx"],
      ["assets/deep-EEEEEEEE.js"],
    ),
    chunk("assets/deep-EEEEEEEE.js", ["/deep.ts"], []),
    chunk("assets/lazy-FFFFFFFF.js", ["/lazy.ts"], []),
  ];
  return {
    [template]: {
      type: "asset",
      fileName: template,
      source: templateHtml,
    } as Rollup.OutputAsset,
    ...Object.fromEntries(chunks.map((c) => [c.fileName, c])),
  };
}

interface PluginHooks {
  configResolved: (config: unknown) => void;
  transformIndexHtml: (html: string) => {
    html: string;
    tags: Array<HtmlTagDescriptor>;
  };
  generateBundle: {
    handler: (
      this: { emitFile: (file: Rollup.EmittedAsset) => void },
      options: unknown,
      bundle: Rollup.OutputBundle,
    ) => void;
  };
  closeBundle: () => void;
}

function resolvedPlugin(root = "/app"): PluginHooks {
  const plugin = hostedRouteDocuments(template) as Plugin & PluginHooks;
  plugin.configResolved({ base: "/", root, build: { outDir: "dist/hosted" } });
  return plugin;
}

function writtenDocuments(bundle = fabricatedBundle()): Map<string, string> {
  const written = new Map<string, string>();
  resolvedPlugin().generateBundle.handler.call(
    {
      emitFile: (file) => written.set(file.fileName!, String(file.source)),
    },
    {},
    bundle,
  );
  expect(bundle[template]).toBeUndefined();
  return written;
}

const { scratchDir, cleanup } = trackScratchDirs();

afterEach(cleanup);

describe("the hosted build's route documents", () => {
  test("are one per warmed route, the root's as index.html", () => {
    const shellRoutes = serviceWorkerStringArray("SHELL_ROUTES");
    expect(shellRoutes.length).toBeGreaterThan(1);

    expect([...writtenDocuments().keys()].sort()).toEqual(
      shellRoutes.map(routeDocumentFileName).sort(),
    );
    expect(routeDocumentFileName("/")).toBe("index.html");
    expect(routeDocumentFileName("/saved/_")).toBe("saved/_.html");
  });

  test("name a route's static import graph and stylesheets, once each", () => {
    const accept = writtenDocuments().get("accept.html")!;

    for (const script of ["accept-CCCCCCCC", "panel-DDDDDDDD", "deep-EEEEEEEE"])
      expect(accept).toContain(
        `<link rel="modulepreload" crossorigin href="/assets/${script}.js">`,
      );
    expect(accept).toContain(
      '<link rel="stylesheet" crossorigin href="/assets/accept-CCCCCCCC.css">',
    );
    expect(accept).not.toContain("lazy-FFFFFFFF");
    expect(accept.split("/assets/index-AAAAAAAA.js").length).toBe(2);
    expect(accept.split("/assets/index-AAAAAAAA.css").length).toBe(2);
  });

  test("leave a route whose code is all in the shell at the template", () => {
    expect(writtenDocuments().get("relay.html")).toBe(templateHtml);
  });

  test("fail the build when no chunk holds a warmed route's file", () => {
    const withoutRelay = declaredRoutes()
      .map(({ file }) => file)
      .filter((file) => !file.endsWith("/relay.tsx"));

    expect(() => writtenDocuments(fabricatedBundle(withoutRelay))).toThrow(
      "relay.tsx",
    );
  });

  test("start from the root route's head and the color-scheme script", () => {
    const { html, tags } = resolvedPlugin().transformIndexHtml(templateHtml);

    expect(html).toContain('<script data-mantine-script="true">');
    const title = rootDocumentHead.meta.find((entry) => "title" in entry);
    expect(tags).toContainEqual(
      expect.objectContaining({ tag: "title", children: title?.title }),
    );
    expect(tags).toContainEqual(
      expect.objectContaining({
        tag: "link",
        attrs: { rel: "manifest", href: "/site.webmanifest" },
      }),
    );
    expect(tags).toContainEqual(
      expect.objectContaining({ tag: "meta", attrs: { charset: "utf-8" } }),
    );
  });

  test.each(["_redirects", "404.html"])(
    "fail the build when the output holds %s",
    (name) => {
      const root = scratchDir("hosted");
      const plugin = resolvedPlugin(root);
      const outDir = join(root, "dist/hosted");
      expect(() => plugin.closeBundle()).not.toThrow();

      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, name), "");
      expect(() => plugin.closeBundle()).toThrow(name);
    },
  );
});
