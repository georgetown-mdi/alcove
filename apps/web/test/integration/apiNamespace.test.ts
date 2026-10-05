import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  getFreePort,
  hasBuild,
  hasConsoleBuild,
  spawnConsoleServer,
  spawnProdServer,
  stopProdServer,
  waitForRoot,
} from "./prodServer.js";

import type { ChildProcess } from "node:child_process";

// On the hosted deployment every path under /api outside the broker's subtree
// answers one response, whatever the request's spelling, method, or Accept
// header; on the console deployment -- the console server, a separate build --
// the broker's subtree, its signaling upgrade, and every path but a job route
// written as declared answer that same response. Asserted against the real
// built servers because what would otherwise answer is the router's decision,
// not any handler's: which spellings of the prefix it resolves to a route, which paths
// it answers with a canonicalizing redirect rather than matching as written,
// what it renders for a method a route declares no handler for, and what the
// SSR path returns to a request that excludes HTML are visible only on the
// wire.
//
// This matrix, rather than a unit assertion per shape, is what catches a
// framework version that adds a response shape: the shapes belong to the
// framework, so nothing here enumerates them -- every request below is required
// to answer the one refusal, whatever the framework would have answered.
//
// Two dot-segment targets are written on the wire verbatim instead of driven
// through `fetch`, which resolves a dot segment against the base URL before
// the request leaves. Sent raw, a dot segment reaches the server as written,
// and where the stack resolves it is not this suite's claim: what is required
// is that the hosted build answers the one refusal for it and the console
// server answers the job route. A third, doubly percent-encoded target is
// written the same way to reach the guard's own dot resolution rather than the
// URL parser's; as written it lands under the broker's subtree, so the console
// refuses it too.

/** The whole observable shape of a response. Date and the connection headers
 * are dropped: they vary per request rather than per path, and a probe reads
 * nothing from them. */
interface ResponseShape {
  status: number;
  headers: Array<[string, string]>;
  bodyLength: number;
}

const VOLATILE_HEADERS: ReadonlySet<string> = new Set([
  "date",
  "connection",
  "keep-alive",
]);

/** The two Accept headers a probe reads the namespace with: a browser's, and
 * one excluding HTML, which is what the SSR path refuses with a JSON 500 when
 * a request reaches it. */
const ACCEPT_VALUES: ReadonlyArray<[string, string]> = [
  ["html", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],
  ["json", "application/json"],
];

/** Redirects are read, not followed: the router answers a path it will not
 * match as written with one, and following it would report the canonical
 * path's answer in its place. */
async function shapeOf(
  base: string,
  method: string,
  path: string,
  accept: string,
): Promise<ResponseShape> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Accept: accept },
    redirect: "manual",
  });
  const body = await response.arrayBuffer();
  return {
    status: response.status,
    headers: [...response.headers]
      .filter(([name]) => !VOLATILE_HEADERS.has(name))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    bodyLength: body.byteLength,
  };
}

/** A foreign `Origin` and a rebound `Host`, the headers a page on another site
 * or a DNS-rebinding page sends. */
interface ForeignHeaders {
  origin?: string;
  host?: string;
}

const FOREIGN_ORIGIN = "http://evil.example";
const FOREIGN_HOST = "evil.example";

/** The header variants the broker's routes and its upgrade are driven with. */
const FOREIGN_VARIANTS: ReadonlyArray<[string, ForeignHeaders]> = [
  ["no foreign header", {}],
  ["a foreign Origin", { origin: FOREIGN_ORIGIN }],
  ["a rebound Host", { host: FOREIGN_HOST }],
  ["both", { origin: FOREIGN_ORIGIN, host: FOREIGN_HOST }],
];

/** The `Host` line, and an `Origin` line when one is given, for a raw request. */
function requestHeaderLines(base: string, foreign: ForeignHeaders): string {
  const { hostname, port } = new URL(base);
  const host = foreign.host ?? `${hostname}:${port}`;
  const origin =
    foreign.origin === undefined ? "" : `Origin: ${foreign.origin}\r\n`;
  return `Host: ${host}\r\n${origin}`;
}

/** How long a raw-socket probe waits for the whole response before giving up. */
const RAW_PROBE_TIMEOUT_MS = 10_000;

/** The shape and body a server answers a request target written on the wire
 * verbatim, so no client library resolves the target first. The probe asks for
 * the connection to close and reads to end of stream, which is why it needs no
 * framing of its own; `Connection` is already among the volatile headers the
 * shape drops. */
function rawShapeOf(
  base: string,
  target: string,
  accept: string,
  foreign: ForeignHeaders = {},
): Promise<ResponseShape & { body: string }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    const socket = connect(Number(port), hostname, () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\n${requestHeaderLines(base, foreign)}` +
          `Accept: ${accept}\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.setTimeout(RAW_PROBE_TIMEOUT_MS, () => {
      socket.destroy(new Error(`no answer for the raw target ${target}`));
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(parseRawResponse(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Read a raw HTTP/1.1 response into the same shape {@link shapeOf} reports,
 * with the bytes after the head as the body -- chunk framing included, since
 * nothing here de-frames it. */
function parseRawResponse(raw: Buffer): ResponseShape & { body: string } {
  const separator = raw.indexOf("\r\n\r\n");
  if (separator === -1)
    throw new Error(`no header terminator in a ${raw.byteLength}-byte answer`);
  const [statusLine, ...headerLines] = raw
    .subarray(0, separator)
    .toString("latin1")
    .split("\r\n");
  const body = raw.subarray(separator + 4);
  return {
    status: Number(statusLine.split(" ")[1]),
    headers: headerLines
      .map((line): [string, string] => [
        line.slice(0, line.indexOf(":")).trim().toLowerCase(),
        line.slice(line.indexOf(":") + 1).trim(),
      ])
      .filter(([name]) => !VOLATILE_HEADERS.has(name))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    bodyLength: body.byteLength,
    body: body.toString("utf8"),
  };
}

/** What the server answers a signaling WebSocket upgrade: the status of its
 * response head, and whether the broker's OPEN frame followed a `101`. */
interface UpgradeAnswer {
  status: number;
  opened: boolean;
}

/** How long an upgrade probe waits for the OPEN frame after a `101`. */
const UPGRADE_PROBE_TIMEOUT_MS = 5_000;

let upgradeProbeSeq = 0;

/** Dial the signaling upgrade with the broker's default key, the one a client
 * uses, over a raw socket so `Host` and `Origin` are written as given. */
function upgradeAnswerOf(
  base: string,
  foreign: ForeignHeaders,
): Promise<UpgradeAnswer> {
  const { hostname, port } = new URL(base);
  const id = `namespace-probe-${(upgradeProbeSeq += 1)}`;
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    let status: number | undefined;
    const socket = connect(Number(port), hostname, () => {
      socket.write(
        `GET /api/peerjs?key=peerjs&id=${id}&token=tok&version=1.5.5 ` +
          `HTTP/1.1\r\n${requestHeaderLines(base, foreign)}` +
          "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    });
    const finish = (answer: UpgradeAnswer | Error) => {
      clearTimeout(timer);
      socket.destroy();
      if (answer instanceof Error) reject(answer);
      else resolve(answer);
    };
    const timer = setTimeout(() => {
      finish(
        status === undefined
          ? new Error(`no answer to the upgrade for ${id}`)
          : { status, opened: false },
      );
    }, UPGRADE_PROBE_TIMEOUT_MS);
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const separator = raw.indexOf("\r\n\r\n");
      if (separator === -1) return;
      status = Number(
        raw.subarray(0, separator).toString("latin1").split(" ")[1],
      );
      if (status !== 101) {
        finish({ status, opened: false });
        return;
      }
      if (raw.subarray(separator + 4).includes('"type":"OPEN"'))
        finish({ status, opened: true });
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      finish(
        status === undefined
          ? new Error(`no answer to the upgrade for ${id}`)
          : { status, opened: false },
      );
    });
  });
}

/** The one refusal: the job gate's own empty 404 (jobEmptyResponse in
 * src/jobs/gate.ts) with the security headers the server entry applies to every
 * response. Written out rather than read from the app, so a change to either
 * side of the wire shows here. */
const REFUSAL: ResponseShape = {
  status: 404,
  headers: [
    ["cache-control", "no-store"],
    ["content-length", "0"],
    ["content-security-policy", "frame-ancestors 'none'"],
    ["referrer-policy", "no-referrer"],
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
  ],
  bodyLength: 0,
};

/** The refusal as `method` reads it. Node's HTTP server sends no
 * `Content-Length` on a bodiless HEAD response -- for every path alike, inside
 * the namespace and out -- so that one header is dropped from what a HEAD
 * request is held to rather than the request being left out of the matrix. */
function refusalFor(method: string): ResponseShape {
  if (method !== "HEAD") return REFUSAL;
  return {
    ...REFUSAL,
    headers: REFUSAL.headers.filter(([name]) => name !== "content-length"),
  };
}

/** Every request the refusal has to answer identically. Each row is a request
 * form a probe would use to tell a declared route from an unknown path:
 *
 * - a declared job route, and one reached by a method it declares no handler
 *   for (the coverage module declares POST only, the slot module GET only),
 * - a path with no route at all, under /api and under /api/jobs,
 * - the namespace root itself, with and without its trailing slash,
 * - a trailing and a doubled slash on a declared and an unknown path, which the
 *   router canonicalizes with a redirect rather than matching as written,
 * - the prefix case-varied and percent-encoded, and a segment after it
 *   percent-encoded, all of which the router resolves to the declared route,
 * - a percent-encoded separator, which reaches the namespace only once decoded,
 * - a dot segment written past the allowlisted prefix, which `fetch` resolves to
 *   `/api/jobs/slot` before the request leaves, so the row drives that resolved
 *   path and the target as written is driven over a raw socket instead,
 * - an encoded space on the prefix's trailing edge, on a segment after it, and
 *   on the tail, which the router resolves to the declared route for some of
 *   those positions and to nothing for others,
 * - a query string on a declared route, which the path the refusal reads
 *   excludes,
 * - methods other than GET, HEAD and OPTIONS among them.
 *
 * A row tagged `jobRoute` is one the console server resolves to a job route
 * that answers `200` where the API is enabled; it matches a route only as
 * written, with no trailing slash and no case-varied or encoded segment, so
 * every other row answers the console's refusal. The console arm drives every
 * row against that split, so a spelling it stops resolving, or starts
 * resolving, fails there instead of passing here over nothing.
 */
const REFUSED: ReadonlyArray<
  readonly [method: string, path: string, resolvesTo?: "jobRoute"]
> = [
  ["GET", "/api/jobs/slot", "jobRoute"],
  ["GET", "/api/jobs"],
  ["GET", "/api/jobs/inputs/coverage"],
  ["GET", "/api/nothing-here"],
  ["GET", "/api/jobs/nothing-here"],
  ["GET", "/api"],
  ["GET", "/api/"],
  ["GET", "/api/jobs/slot/"],
  ["GET", "/api/nothing-here/"],
  ["GET", "/api//jobs/slot"],
  ["GET", "/api//nothing-here"],
  ["GET", "/API/jobs/slot"],
  ["GET", "/Api/jobs/slot"],
  ["GET", "/API/nothing-here"],
  ["GET", "/%61pi/jobs/slot"],
  ["GET", "/%41PI/jobs/slot"],
  ["GET", "/%61pi/nothing-here"],
  ["GET", "/api/%6aobs/slot"],
  ["GET", "/api/jobs/%73lot"],
  ["GET", "/api%2Fjobs/slot"],
  // Resolved to /api/jobs/slot by the URL parser before it is sent; the
  // unresolved target is RAW_TARGETS below.
  ["GET", "/api/peerjs/%2e%2e/jobs/slot", "jobRoute"],
  ["GET", "/api/jobs/slot%20"],
  ["GET", "/api/%20jobs/slot"],
  ["GET", "/api/jobs%20/slot"],
  ["GET", "/api/jobs/slot?x=1", "jobRoute"],
  ["POST", "/api/nothing-here"],
  ["POST", "/api/jobs/slot"],
  ["DELETE", "/api/jobs/slot"],
  ["PATCH", "/api/jobs/inputs/coverage"],
  ["OPTIONS", "/api/nothing-here"],
  ["HEAD", "/api/jobs/slot", "jobRoute"],
];

/** The matrix's rows as a request each arm drives. */
const REFUSED_REQUESTS: ReadonlyArray<[string, string]> = REFUSED.map(
  ([method, path]) => [method, path],
);

/** The rows the console server answers with the job route. */
const JOB_ROUTE_REQUESTS: ReadonlyArray<[string, string]> = REFUSED.filter(
  (row) => row[2] === "jobRoute",
).map(([method, path]) => [method, path]);

/** The rows the console server answers with the refusal. */
const CONSOLE_REFUSED_REQUESTS: ReadonlyArray<[string, string]> =
  REFUSED.filter((row) => row[2] !== "jobRoute").map(([method, path]) => [
    method,
    path,
  ]);

/** Paths the refusal does not reach, each held to the answer it has with no
 * refusal installed: a page outside the namespace, a path whose decoded form
 * leaves it, and one whose first segment is `api` only as written -- `%20`
 * decodes that segment to `api `, which is not the namespace, so the path
 * resolves to no route on either deployment profile and answers the site's
 * ordinary shapes. */
const UNTOUCHED: ReadonlyArray<string> = [
  "/nothing-here",
  "/ap%69x",
  "/api%20/jobs/slot",
];

/** The targets the matrix writes on the wire verbatim: a dot segment past the
 * allowlisted prefix, spelled plainly and percent-encoded. `fetch` resolves
 * both to `/api/jobs/slot` before sending, so driven through it neither reaches
 * the server as written. */
const RAW_TARGETS: ReadonlyArray<string> = [
  "/api/peerjs/../jobs/slot",
  "/api/peerjs/%2e%2e/jobs/slot",
];

/** A double-encoded dot segment: `%25` decodes to `%`, so neither the URL
 * parser nor `fetch` resolves it the way they resolve `..` and `%2e%2e`, and
 * it reaches the entry as written. Written on the wire alongside
 * {@link RAW_TARGETS} to exercise the guard's own dot resolution, which
 * refuses it once its own percent-decoding rounds reach `..`. */
const DOUBLE_ENCODED_DOT_TARGET = "/api/peerjs/%252e%252e/jobs/slot";

/** What the job route answers for a free slot, as it appears in the raw
 * response body: the probe reads chunk framing around it, so the payload is
 * matched inside the body rather than as the whole of it. */
const SLOT_FREE = '{"occupied":false}';

/** The broker's own route, in the spellings a client writes it: the peer server
 * attaches its WebSocket upgrade listener on the first GET under this subtree
 * (src/peerServer.ts), so a hosted refusal reaching it would stop public
 * signaling rather than harden anything. */
const BROKER_PATHS: ReadonlyArray<string> = [
  "/api/peerjs/id",
  "/api/peerjs/id/",
  "/API/peerjs/id",
  "/%61pi/peerjs/id",
];

/** Each broker route, and the status the hosted build answers it with: the
 * server description, a fresh id, and peer discovery, which is off. */
const BROKER_ROUTES: ReadonlyArray<[path: string, hostedStatus: number]> = [
  ["/api/peerjs", 200],
  ["/api/peerjs/id", 200],
  ["/api/peerjs/peerjs/peers", 401],
];

/** Every broker route under every foreign-header variant. */
const BROKER_ROUTE_REQUESTS: ReadonlyArray<
  [path: string, variant: string, foreign: ForeignHeaders, hostedStatus: number]
> = BROKER_ROUTES.flatMap(([path, hostedStatus]) =>
  FOREIGN_VARIANTS.map(
    ([variant, foreign]): [string, string, ForeignHeaders, number] => [
      path,
      variant,
      foreign,
      hostedStatus,
    ],
  ),
);

describe.skipIf(!hasBuild || !hasConsoleBuild)(
  "the /api namespace's refusal",
  () => {
    let hosted: ChildProcess | undefined;
    let consoleServer: ChildProcess | undefined;
    const roots: Array<string> = [];
    let hostedBase = "";
    let consoleBase = "";

    beforeAll(async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "alcove-api-ns-data-"));
      // The built server runs as an ordinary user here, so relocate the
      // pasted-credential scratch dir off the root-owned default it boots on.
      const credentialDir = mkdtempSync(join(tmpdir(), "alcove-api-ns-cred-"));
      roots.push(dataRoot, credentialDir);

      const hostedPort = await getFreePort();
      const hostedServer = await spawnProdServer(hostedPort, {
        // The hosted build leaves the profile unset; a data root it never reads
        // would not enable the API, so none is supplied.
        VITE_DEPLOYMENT_PROFILE: "",
        JOB_DATA_ROOT: "",
      });
      hosted = hostedServer.child;
      hostedBase = `http://127.0.0.1:${hostedPort}`;
      await waitForRoot(`${hostedBase}/`, hosted, hostedServer.getLaunchError);

      const consolePort = await getFreePort();
      const spawned = await spawnConsoleServer(consolePort, {
        JOB_DATA_ROOT: dataRoot,
        JOB_SFTP_CREDENTIAL_DIR: credentialDir,
      });
      consoleServer = spawned.child;
      consoleBase = `http://127.0.0.1:${consolePort}`;
      await waitForRoot(
        `${consoleBase}/`,
        consoleServer,
        spawned.getLaunchError,
      );
    }, 90_000);

    afterAll(async () => {
      await stopProdServer(hosted);
      await stopProdServer(consoleServer);
      for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true });
    });

    describe.each(ACCEPT_VALUES)("under Accept: %s", (_name, accept) => {
      test.each(REFUSED_REQUESTS)(
        "a hosted probe reads the one refusal for %s %s",
        async (method, path) => {
          expect(await shapeOf(hostedBase, method, path, accept)).toEqual(
            refusalFor(method),
          );
        },
      );

      test.each(RAW_TARGETS)(
        "a hosted probe reads the one refusal for a verbatim GET %s",
        async (target) => {
          const { body, ...shape } = await rawShapeOf(
            hostedBase,
            target,
            accept,
          );
          expect(shape).toEqual(REFUSAL);
          expect(body).toBe("");
        },
      );

      test("a hosted probe reads the one refusal for a verbatim double-encoded dot segment", async () => {
        const { body, ...shape } = await rawShapeOf(
          hostedBase,
          DOUBLE_ENCODED_DOT_TARGET,
          accept,
        );
        expect(shape).toEqual(REFUSAL);
        expect(body).toBe("");
      });

      test.each(BROKER_PATHS)(
        "the broker still answers GET %s on the hosted build",
        async (path) => {
          const answered = await shapeOf(hostedBase, "GET", path, accept);
          expect(answered.status).toBe(200);
          expect(answered.bodyLength).toBeGreaterThan(0);
        },
      );

      test.each(UNTOUCHED)(
        "a path outside /api is untouched: %s",
        async (path) => {
          const rendered = await shapeOf(hostedBase, "GET", path, accept);
          expect(rendered).not.toEqual(REFUSAL);
          expect(rendered.bodyLength).toBeGreaterThan(0);
        },
      );
    });

    // Against the console server, where the job API is enabled. The refusal
    // reads the same enablement the per-route gate reads, so a mis-keyed one
    // darkens the console's own API here rather than failing silently. Every
    // other row of the matrix is one the console server answers with the same
    // refusal: it matches a route only as written, so no spelling of one tells a
    // probe more than an unknown path does.
    describe("where the job API is enabled", () => {
      test("the matrix names the spellings this arm re-drives", () => {
        expect(JOB_ROUTE_REQUESTS.length).toBeGreaterThan(0);
      });

      describe.each(ACCEPT_VALUES)("under Accept: %s", (_name, accept) => {
        test.each(CONSOLE_REFUSED_REQUESTS)(
          "the console reads the one refusal for %s %s",
          async (method, path) => {
            expect(await shapeOf(consoleBase, method, path, accept)).toEqual(
              refusalFor(method),
            );
          },
        );
      });

      test.each(JOB_ROUTE_REQUESTS)(
        "the job route answers %s %s",
        async (method, path) => {
          const answered = await shapeOf(
            consoleBase,
            method,
            path,
            ACCEPT_VALUES[1][1],
          );
          expect(answered.status).toBe(200);
          if (method !== "HEAD") expect(answered.bodyLength).toBeGreaterThan(0);
        },
      );

      test.each(RAW_TARGETS)(
        "the job route answers a verbatim GET %s",
        async (target) => {
          const answered = await rawShapeOf(
            consoleBase,
            target,
            ACCEPT_VALUES[1][1],
          );
          expect(answered.status).toBe(200);
          expect(answered.body).toContain(SLOT_FREE);
        },
      );

      test("the one refusal for a verbatim GET double-encoded dot segment written under the broker's subtree", async () => {
        const { body, ...shape } = await rawShapeOf(
          consoleBase,
          DOUBLE_ENCODED_DOT_TARGET,
          ACCEPT_VALUES[1][1],
        );
        expect(shape).toEqual(REFUSAL);
        expect(body).toBe("");
      });
    });

    // The console serves no PeerJS route and no signaling upgrade, whatever the
    // request's Origin or Host; the hosted build answers them as it always has.
    describe("the broker's routes and signaling upgrade by profile", () => {
      test.each(BROKER_ROUTE_REQUESTS)(
        "the console answers the one refusal for GET %s with %s",
        async (path, _variant, foreign) => {
          const { body, ...shape } = await rawShapeOf(
            consoleBase,
            path,
            ACCEPT_VALUES[1][1],
            foreign,
          );
          expect(shape).toEqual(REFUSAL);
          expect(body).toBe("");
        },
      );

      test.each(BROKER_ROUTE_REQUESTS)(
        "the hosted build answers GET %s with %s",
        async (path, _variant, foreign, hostedStatus) => {
          const answered = await rawShapeOf(
            hostedBase,
            path,
            ACCEPT_VALUES[1][1],
            foreign,
          );
          expect(answered.status).toBe(hostedStatus);
        },
      );

      test.each(FOREIGN_VARIANTS)(
        "the console refuses the signaling upgrade with %s",
        async (_variant, foreign) => {
          expect(await upgradeAnswerOf(consoleBase, foreign)).toEqual({
            status: 404,
            opened: false,
          });
        },
      );

      test.each(FOREIGN_VARIANTS)(
        "the hosted build opens the signaling upgrade with %s",
        async (_variant, foreign) => {
          expect(await upgradeAnswerOf(hostedBase, foreign)).toEqual({
            status: 101,
            opened: true,
          });
        },
      );
    });
  },
);
