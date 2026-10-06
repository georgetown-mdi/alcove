import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { createServer } from "node:http";

import { headersForPath, parseHeadersFile } from "./headersFile";

import type { AddressInfo } from "node:net";
import type { HeaderRule } from "./headersFile";

// A static file server emulating the part of Cloudflare Pages the hosted build
// relies on. What it emulates, and which of that was measured on Pages:
// docs/notes/hosted-static-build.md, Static-host harness.

/** Files whose presence makes Pages rewrite or replace unmatched paths. */
export const CATCH_ALL_FILES = ["_redirects", "404.html"];

/** Host configuration files in the output, which Pages reads and never serves
 * as a file. */
const CONFIGURATION_FILES = ["_headers"];

function isConfigurationFile(root: string, target: string): boolean {
  return CONFIGURATION_FILES.some((name) => target === join(root, name));
}

/** The Cache-Control Pages sends on a file no `_headers` rule gives one. */
export const DEFAULT_CACHE_CONTROL = "public, max-age=0, must-revalidate";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".xml": "application/xml",
};

/** A running static host. */
export interface StaticHost {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  readonly origin: string;
  readonly close: () => Promise<void>;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** The output file answering `pathname`: the file it names, else the `.html`
 * file an extensionless path names, else the root document. Never a path
 * outside `root`. */
export function resolveStaticFile(root: string, pathname: string): string {
  const fallback = join(root, "index.html");
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return fallback;
  }
  const target = resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return fallback;
  if (decoded.endsWith("/")) {
    const index = join(target, "index.html");
    return isFile(index) ? index : fallback;
  }
  if (isFile(target) && !isConfigurationFile(root, target)) return target;
  if (extname(decoded) === "" && isFile(`${target}.html`))
    return `${target}.html`;
  return fallback;
}

/**
 * Serves `outputDirectory` on a free loopback port. Rejects when the directory
 * has no `index.html`, holds a file in {@link CATCH_ALL_FILES}, or has a
 * `_headers` outside the subset `headersFile.ts` reads.
 */
export async function startStaticHost(
  outputDirectory: string,
): Promise<StaticHost> {
  const root = resolve(outputDirectory);
  if (!isFile(join(root, "index.html")))
    throw new Error(`${root} has no index.html to serve`);
  const catchAll = CATCH_ALL_FILES.filter((name) =>
    existsSync(join(root, name)),
  );
  if (catchAll.length > 0)
    throw new Error(
      `${root} holds ${catchAll.join(" and ")}, which make Cloudflare Pages ` +
        "rewrite unmatched paths instead of serving index.html",
    );
  const headersPath = join(root, "_headers");
  const rules: Array<HeaderRule> = existsSync(headersPath)
    ? parseHeadersFile(readFileSync(headersPath, "utf8"))
    : [];

  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://static.invalid")
      .pathname;
    let headers: Map<string, string>;
    try {
      headers = headersForPath(rules, pathname);
    } catch (error) {
      response
        .writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
        .end(error instanceof Error ? error.message : String(error));
      return;
    }
    const file = resolveStaticFile(root, pathname);
    const body = readFileSync(file);
    response.setHeader(
      "Content-Type",
      CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    );
    response.setHeader("Content-Length", body.length);
    response.setHeader("Cache-Control", DEFAULT_CACHE_CONTROL);
    for (const [name, value] of headers) response.setHeader(name, value);
    response.writeHead(200);
    response.end(request.method === "HEAD" ? undefined : body);
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}
