# Hosted static build

`npm run build -w apps/web` writes the hosted app as a static site to `dist/hosted/`; it is the hosted app's only build, and no hosted server is built. The entry is `src/hostedClient.tsx`; the documents are written by `hosted/routeDocuments.ts`. The build fails before bundling unless `VITE_SIGNALING_SERVER_URL` is set (environment or `.env` file), since the hosted origin serves no signaling; see [DEPLOYMENT.md](../DEPLOYMENT.md#peer-coordination-server).

## One document per warmed route

The app-shell worker (`public/serviceWorker.js`) warms each path in its `SHELL_ROUTES` by fetching the document and caching the assets that document names. A single shared document would name only the shell's code, leaving every other route unusable offline. So each route gets its own document: `hosted/index.html` with the root route's head plus a `modulepreload` link for every chunk holding the route file's modules and that chunk's static imports, and a stylesheet link for the stylesheets those chunks import. The root's document is `index.html`; every other is its path plus `.html`, which a static host serves at the extensionless path (`/saved/_` is `saved/_.html`).

The page list is the worker's own list, so the two cannot disagree. Lazily imported code is not linked: it is fetched when used.

Measured against a real build of the app's TanStack Start version, each route's document named a superset of what that build's server-rendered document named, so no route loses code the Start deployment warmed.

## No catch-all rewrite

The build writes no `_redirects` or `404.html` and fails if one is present in its output. With neither file, Cloudflare Pages answers an unmatched path with the root `index.html`, while a catch-all rewrite to a document makes Cloudflare Pages loop.

## The host configuration file

The build writes `_headers` (`hosted/headersFile.ts`), the file Cloudflare Pages reads for response headers:

- `/*` gets the four security headers, taken from `securityResponseHeaders` in `src/utils/securityHeaders.ts`, the value the console server applies in code. The reason for each header: [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security).
- `/assets/*` gets `Cache-Control: public, max-age=31536000, immutable`. Every file under `/assets/` has a content hash in its name.

The `/assets/*` rule matches by path, so a missing `/assets/` URL gets the root document with 200 and the one-year immutable `Cache-Control` (a harness test pins this). This is accepted: asset URLs carry a content hash, a URL that misses never becomes valid later, and the service worker refuses to store a response whose content type is not the asset's.

Everything else keeps Pages' default `Cache-Control: public, max-age=0, must-revalidate`, so the documents and `serviceWorker.js` revalidate on every load.

The build emits the file rather than keeping it in `public/`, so the console, which serves `public/`, never serves it.

With `_headers`, the headers reach every response, assets included. `/api/*` on the static host answers with the root document and 200, since the hosted app calls no API; `apiNamespace.test.ts` holds that the build writes nothing a host would serve there.

## Server-only modules

The build fails if the browser bundle or a worker bundle imports a `node:` builtin, `env-schema` or `dotenv` (`hosted/moduleGraphGuard.ts`). A production browser build gives every Node builtin one shared stub id, so the guard records the import specifiers as well as the resolved ids. A bare builtin without the `node:` prefix is not refused: `@openmined/psi.js` imports `url`, which the build stubs.

## Static-host harness

The integration suites serve the build through `test/staticHost/`, which emulates the part of Pages the site relies on ([docs/TESTING.md](../TESTING.md#static-host-harness) names the harness). It:

- serves a path naming a file as that file, `_headers` excepted, and an extensionless path as `<path>.html`;
- serves any other path as the root `index.html` with status 200;
- adds the `_headers` rules matching the request path to every response, over Pages' default revalidating `Cache-Control`;
- refuses to start on an output holding `_redirects` or `404.html`, which change that fallback on Pages, and on `_headers` syntax outside the subset it reads.

Measured on the Pages emulator (wrangler 4.147.0):

- an unmatched path, `/assets/` paths included, gets the root `index.html` with 200 when the output has no `404.html`;
- the `_headers` rules under `/*` reach documents, the fallback document and assets;
- every file's default `Cache-Control` is `public, max-age=0, must-revalidate`.

Not measured, so the harness follows the Pages documentation: an extensionless path served from `<path>.html` (the emulator run used `<path>/index.html`, which Pages answers with a 308 to the trailing-slash path), a `_headers` rule replacing that default `Cache-Control`, and `_headers` itself not being served. The harness refuses `_headers` syntax outside the subset it reads. Before cutover, a preview deployment repeats these checks on the real Pages edge.

`csvWorkerProd` fails on any browser message naming a failed import of peerjs's `PeerErrorType`, which a server render of the page once logged.
