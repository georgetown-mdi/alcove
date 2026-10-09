import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";

import { JobApiConfigError, jobEmptyResponse } from "@jobs/gate";
import { isApiNamespacePath } from "@utils/apiNamespace";
import { isPathWithin } from "@jobs/pathContainment";
import { rejectDisallowedClientHost } from "@jobs/routeSupport";

/** The document every client route is answered with. */
const INDEX_FILE = "index.html";

/** The build's content-hashed output, whose names change with their bytes. */
const HASHED_ASSET_PREFIX = "/assets/";

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE_CONTROL = "no-cache";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
};

const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

/**
 * The decoded segments of `pathname`, or null when it names nothing this
 * server serves: a segment that does not percent-decode, decodes to a NUL or
 * a path separator, is empty (a trailing or doubled slash), or begins with a
 * dot (a dotfile, `.` or `..`). The root path has no segments.
 */
function decodedSegments(pathname: string): Array<string> | null {
  if (pathname === "/") return [];
  if (!pathname.startsWith("/")) return null;
  const segments: Array<string> = [];
  for (const written of pathname.slice(1).split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(written);
    } catch {
      return null;
    }
    if (segment === "" || segment.startsWith(".") || /[\0/\\]/.test(segment))
      return null;
    segments.push(segment);
  }
  return segments;
}

/**
 * Whether a path that names no file is answered with the index document: a
 * client route, written without percent-encoding, whose last segment has no
 * extension. A missing asset, an encoded path, or any spelling of the `/api`
 * namespace is not.
 */
function isClientRoutePath(pathname: string, segments: Array<string>): boolean {
  return (
    !pathname.includes("%") &&
    !(segments.at(-1) ?? "").includes(".") &&
    !isApiNamespacePath(pathname)
  );
}

/** An open regular file under the root, or null when there is none. */
async function openRegularFile(
  realRoot: string,
  segments: Array<string>,
): Promise<{ handle: fs.promises.FileHandle; size: number } | null> {
  const candidate = path.join(realRoot, ...segments);
  if (!isPathWithin(realRoot, candidate, "strictly-under")) return null;
  let realCandidate: string;
  try {
    realCandidate = await fs.promises.realpath(candidate);
  } catch {
    return null;
  }
  if (
    !isPathWithin(realRoot, realCandidate, "strictly-under") ||
    path
      .relative(realRoot, realCandidate)
      .split(path.sep)
      .some((segment) => segment.startsWith("."))
  )
    return null;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(realCandidate, OPEN_FLAGS);
  } catch {
    return null;
  }
  const stat = await handle.stat().catch(() => null);
  if (stat?.isFile()) return { handle, size: stat.size };
  await handle.close();
  return null;
}

/** The response for an open file, its body read from `handle`. */
async function fileResponse(
  file: { handle: fs.promises.FileHandle; size: number },
  name: string,
  cacheControl: string,
  method: string,
): Promise<Response> {
  const headers = {
    "Content-Type":
      CONTENT_TYPES[path.extname(name).toLowerCase()] ??
      "application/octet-stream",
    "Content-Length": String(file.size),
    "Cache-Control": cacheControl,
  };
  if (method === "HEAD") {
    await file.handle.close();
    return new Response(null, { status: 200, headers });
  }
  const body = Readable.toWeb(
    file.handle.createReadStream(),
  ) as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers });
}

/** The command that builds the client this server serves. */
export const CLIENT_BUILD_COMMAND = "npm run build:console -w apps/web";

/** The real path of `root`, refusing a root with no index document file. An
 * error other than a missing path is rethrown as is. */
function builtClientRoot(root: string): string {
  const indexPath = path.join(root, INDEX_FILE);
  const notBuilt = (): JobApiConfigError =>
    new JobApiConfigError(
      `the console client is not built (no file at ${indexPath}); run ` +
        `${CLIENT_BUILD_COMMAND} from the repository root to build it`,
    );
  try {
    const realRoot = fs.realpathSync(root);
    if (!fs.statSync(path.join(realRoot, INDEX_FILE)).isFile())
      throw notBuilt();
    return realRoot;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw notBuilt();
    throw error;
  }
}

/**
 * The handler serving the built client under `root`: a `GET` or `HEAD`
 * outside the `/api` namespace whose `Host` the job routes would refuse
 * answers their empty `403` ({@link rejectDisallowedClientHost}); otherwise
 * one for a regular file in it answers that file, and one for a client route
 * answers `index.html`. Every other request -- another method, a path under
 * `/api` in any spelling, a dotfile, a directory, a path leaving `root`
 * lexically or through a symlink -- answers the empty no-store `404`. Content-hashed assets
 * are cacheable for a year; everything else is revalidated. `root` and its
 * index document are checked when the handler is created, so a missing
 * bundle throws a {@link JobApiConfigError} at startup.
 */
export function createStaticFileHandler(
  root: string,
): (request: Request) => Promise<Response> {
  const realRoot = builtClientRoot(root);

  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD")
      return jobEmptyResponse(404);
    const pathname = new URL(request.url).pathname;
    if (isApiNamespacePath(pathname)) return jobEmptyResponse(404);
    const hostRefusal = rejectDisallowedClientHost(request);
    if (hostRefusal !== null) return hostRefusal;
    const segments = decodedSegments(pathname);
    if (segments === null) return jobEmptyResponse(404);

    const named = segments.length === 0 ? [INDEX_FILE] : segments;
    const file = await openRegularFile(realRoot, named);
    if (file !== null)
      return fileResponse(
        file,
        named.at(-1)!,
        pathname.startsWith(HASHED_ASSET_PREFIX)
          ? IMMUTABLE_CACHE_CONTROL
          : REVALIDATE_CACHE_CONTROL,
        request.method,
      );
    if (!isClientRoutePath(pathname, segments)) return jobEmptyResponse(404);
    const index = await openRegularFile(realRoot, [INDEX_FILE]);
    if (index === null) return jobEmptyResponse(404);
    return fileResponse(
      index,
      INDEX_FILE,
      REVALIDATE_CACHE_CONTROL,
      request.method,
    );
  };
}
