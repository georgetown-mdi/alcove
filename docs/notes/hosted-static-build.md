# Hosted static build

`npm run build:hosted -w apps/web` writes the hosted app as a static site to `dist/hosted/`. The entry is `src/hostedClient.tsx`; the documents are written by `hosted/routeDocuments.ts`. The build fails before bundling unless `VITE_SIGNALING_SERVER_URL` is set (environment or `.env` file), since the hosted origin serves no signaling; see [DEPLOYMENT.md](../DEPLOYMENT.md#peer-coordination-server).

## One document per warmed route

The app-shell worker (`public/serviceWorker.js`) warms each path in its `SHELL_ROUTES` by fetching the document and caching the assets that document names. A single shared document would name only the shell's code, leaving every other route unusable offline. So each route gets its own document: `hosted/index.html` with the root route's head plus a `modulepreload` link for every chunk holding the route file's modules and that chunk's static imports, and a stylesheet link for the stylesheets those chunks import. The root's document is `index.html`; every other is its path plus `.html`, which a static host serves at the extensionless path (`/saved/_` is `saved/_.html`).

The page list is the worker's own list, so the two cannot disagree. Lazily imported code is not linked: it is fetched when used.

Measured against a real build, each route's document names a superset of what the TanStack Start build's server-rendered document names, so no route loses code the Start deployment would have warmed.

## No catch-all rewrite

The build writes no `_redirects` or `404.html` and fails if one is present in its output. With neither file, Cloudflare Pages answers an unmatched path with the root `index.html`, while a catch-all rewrite to a document makes Cloudflare Pages loop.
