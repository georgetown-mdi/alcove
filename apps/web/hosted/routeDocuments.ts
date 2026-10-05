import { existsSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ColorSchemeScript } from "@mantine/core";

import { rootDocumentHead } from "../src/utils/documentHead.ts";

import { declaredRoutes, matchesRoutePattern } from "./declaredRoutes.ts";
import { serviceWorkerStringArray } from "./serviceWorkerSource.ts";

import type { HtmlTagDescriptor, Plugin, Rollup } from "vite";

type OutputChunk = Rollup.OutputChunk;

/** Files whose presence makes a static host rewrite or replace unmatched paths.
 * A catch-all rewrite to a document loops on Cloudflare Pages, and with neither
 * file the host answers an unmatched path with the root `index.html`. */
const CATCH_ALL_FILES = ["_redirects", "404.html"];

/** The output file serving `route`: the root's is `index.html`, every other
 * route's is its path plus `.html`, which a static host serves at the
 * extensionless path. */
export function routeDocumentFileName(route: string): string {
  return route === "/" ? "index.html" : `${route.slice(1)}.html`;
}

/** The root route's head as tags for the template, so a document served before
 * any script runs has the same title, icons and manifest the root route
 * renders. */
function rootHeadTags(): Array<HtmlTagDescriptor> {
  const meta = rootDocumentHead.meta.map((entry): HtmlTagDescriptor => {
    if ("title" in entry)
      return { tag: "title", children: entry.title, injectTo: "head-prepend" };
    if ("charSet" in entry)
      return {
        tag: "meta",
        attrs: { charset: entry.charSet },
        injectTo: "head-prepend",
      };
    const attrs = Object.fromEntries(
      Object.entries(entry).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    return { tag: "meta", attrs, injectTo: "head-prepend" };
  });
  const links = rootDocumentHead.links.map((entry): HtmlTagDescriptor => ({
    tag: "link",
    attrs: { ...entry },
    injectTo: "head",
  }));
  return [...meta, ...links];
}

/** Every chunk `entries` reach through static imports, the entries included. */
function staticImportClosure(
  entries: Array<OutputChunk>,
  chunksByFileName: Map<string, OutputChunk>,
): Array<OutputChunk> {
  const reached = new Map<string, OutputChunk>();
  const pending = [...entries];
  for (let chunk = pending.pop(); chunk !== undefined; chunk = pending.pop()) {
    if (reached.has(chunk.fileName)) continue;
    reached.set(chunk.fileName, chunk);
    for (const imported of chunk.imports) {
      const next = chunksByFileName.get(imported);
      if (next !== undefined) pending.push(next);
    }
  }
  return [...reached.values()];
}

/** The `/assets/...` URLs a document must declare for `route`: the code of every
 * chunk holding the route file's modules, the code split off it included, with
 * their static imports and the stylesheets those import. */
function routeAssetUrls(
  routeFiles: Array<string>,
  chunks: Array<OutputChunk>,
  base: string,
): { scripts: Array<string>; stylesheets: Array<string> } {
  const files = new Set(routeFiles);
  const holding = chunks.filter((chunk) =>
    chunk.moduleIds.some((id) => files.has(id.replace(/\?.*$/, ""))),
  );
  if (holding.length === 0)
    throw new Error(
      `no chunk of the hosted build holds ${routeFiles.join(" or ")}`,
    );
  const closure = staticImportClosure(
    holding,
    new Map(chunks.map((chunk) => [chunk.fileName, chunk])),
  );
  return {
    scripts: closure.map((chunk) => `${base}${chunk.fileName}`),
    stylesheets: closure.flatMap((chunk) =>
      [...(chunk.viteMetadata?.importedCss ?? [])].map(
        (css) => `${base}${css}`,
      ),
    ),
  };
}

/** `shell` with a modulepreload or stylesheet link added before `</head>` for
 * every URL it does not already name. */
function withAssetLinks(
  shell: string,
  {
    scripts,
    stylesheets,
  }: { scripts: Array<string>; stylesheets: Array<string> },
): string {
  const absent = (url: string) => !shell.includes(`"${url}"`);
  const links = [
    ...[...new Set(stylesheets)]
      .filter(absent)
      .map((url) => `<link rel="stylesheet" crossorigin href="${url}">`),
    ...[...new Set(scripts)]
      .filter(absent)
      .map((url) => `<link rel="modulepreload" crossorigin href="${url}">`),
  ];
  if (links.length === 0) return shell;
  return shell.replace("</head>", `  ${links.join("\n    ")}\n  </head>`);
}

/**
 * Writes the hosted static site's documents: one per entry of the app-shell
 * worker's SHELL_ROUTES, each the built template plus links to that route's own
 * code, with the root's as `index.html`.
 *
 * The worker caches what a route's served document names, so a document naming
 * only the shell's code would leave every other route unusable offline. The
 * page list is the worker's own list, so the two cannot disagree.
 *
 * @param templateFileName - the template's output name, relative to the app
 * root (`hosted/index.html`), which is replaced by the documents.
 */
export function hostedRouteDocuments(templateFileName: string): Plugin {
  let base = "/";
  let outDir = "";
  return {
    name: "alcove-hosted-route-documents",
    apply: "build",
    configResolved(config) {
      base = config.base;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    transformIndexHtml(html) {
      return {
        html: html.replace(
          "</head>",
          `  ${renderToStaticMarkup(createElement(ColorSchemeScript))}\n  </head>`,
        ),
        tags: rootHeadTags(),
      };
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const template = bundle[templateFileName];
        if (template?.type !== "asset")
          throw new Error(`the hosted build emitted no ${templateFileName}`);
        const shell = String(template.source);
        delete bundle[templateFileName];

        const chunks = Object.values(bundle).filter(
          (output): output is OutputChunk => output.type === "chunk",
        );
        const routes = declaredRoutes();
        for (const route of serviceWorkerStringArray("SHELL_ROUTES")) {
          const routeFiles = routes
            .filter((declared) => matchesRoutePattern(declared.path, route))
            .map((declared) => declared.file);
          if (routeFiles.length === 0)
            throw new Error(
              `SHELL_ROUTES names ${route}, which no route file declares`,
            );
          this.emitFile({
            type: "asset",
            fileName: routeDocumentFileName(route),
            source: withAssetLinks(
              shell,
              routeAssetUrls(routeFiles, chunks, base),
            ),
          });
        }
      },
    },
    closeBundle() {
      const present = CATCH_ALL_FILES.filter((name) =>
        existsSync(path.join(outDir, name)),
      );
      if (present.length > 0)
        throw new Error(
          `the hosted build wrote ${present.join(" and ")}, which make the static host rewrite unmatched paths; remove them`,
        );
    },
  };
}
