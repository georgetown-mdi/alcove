---
title: "App-Shell Service Worker"
---

# The app-shell service worker: caching strategy, and why it is hand-written

_Status: decided and built. The worker ships as `apps/web/public/serviceWorker.js`, whose header states the mechanism; the operator-facing behavior is in [MANAGED_EXCHANGE.md](../MANAGED_EXCHANGE.md#installing-the-app). This note records why the two open choices were settled the way they were. See [docs/notes/README.md](README.md)._

Making the hosted web application installable needed two decisions the work could not avoid: what to cache and how, and whether to adopt PWA build tooling or write the worker by hand. Both had defensible answers in more than one direction, so the reasoning is recorded here rather than left implicit in the code.

## What the worker is for, and what it is not for

The installed app is the primary runtime for an unattended recurring exchange: the exchange runs in the app's own window, because WebRTC is unavailable to a service worker and Periodic Background Sync's opportunistic windows cannot sustain a live session. Installability, in a browser, requires a service worker with a fetch handler. So the worker exists to make the app installable and its shell renderable offline -- not to run, resume, or schedule anything.

That framing is what keeps its scope of impact small. It caches the app document and the build's static assets. It never touches the API routes, cross-origin requests, or non-GET requests, so no exchange traffic can reach a cache.

## Caching strategy

A service worker's classic failure is pinning an old deployment: a naive cache-first over everything serves last month's code until someone clears storage. The application is continuously deployed and an app upgrade can invalidate a stored managed-exchange record -- whose recovery is a re-invite, a two-party action -- so stale code is not a cosmetic problem here.

The strategy is chosen per request class, against the shape of what `vite build` actually emits:

- **The app document: network-first.** Whenever the network is reachable the served deployment wins; the cache is only ever a fallback. An installed app's start URL is the origin root, so every launch is also what refreshes the fallback.
- **Build assets: cache-first.** Vite emits them content-hashed under `/assets/`, so a URL names its bytes and a hit cannot be stale. A new deployment's document references new URLs, which miss and are fetched.
- **The manifest and icons: cache-first with a background refresh.** Their URLs are stable and they are tiny, and an install prompt raised offline needs them present.

Two consequences follow. First, "cache-first" is safe here only because of the content hashing; it would be the wrong default for any unhashed asset, which is why the set that gets it is an enumerated list rather than a catch-all. Second, the asset cache is capped and trimmed oldest-first, because a continuously deployed origin otherwise accumulates every past deployment's chunks.

A URL names its bytes only when the server sent those bytes. A static host answers a path it does not have, such as a previous deployment's chunk, with its fallback document as 200 `text/html`; stored under an `/assets/` URL, that document would be served in place of the code until the trim reached it. So every write of a build asset, icon, or the manifest stores a response only when its content type is the one its file extension names. A mismatch is served to the page and not stored.

### One cached document, not one per route

Every route of the app renders client-side from the root document, so a single cached document answers an offline navigation to any path: the client router resolves the route from the address bar. This was verified against a built server rather than assumed -- the root document served at a `/saved/<id>` URL renders that route's surface.

Caching only the root's own response is also the more conservative choice. A deeper route's URL holds its parameters, so storing a response under it would put a saved exchange's id at rest in a second place, beside the record store that already holds it. A query string could hold anything at all. Neither is stored.

### How much of the app is precached, and when

Caching the shell's own asset graph is not enough for the app to open offline: every route past the front page loads its own code chunk, and a chunk never fetched is a chunk not cached. Measured against the hosted static build on 2026-10-06, the shell's graph is 28 files and 4.1 MB; the union across every route is 50 files and 4.8 MB (uncompressed). The exchange machinery is already in the shell's graph, so the other routes add 0.7 MB.

An earlier build put the exchange machinery outside the shell's graph (19 files and 1.5 MB against 43 files and 4.2 MB), and the warm then ran only in an installed app, leaving a tab to fill the rest in as the operator visited routes. Measured on the static host, that left a tab unable to open any route it had not visited once its network went, which is the case an operator meets first. So the split is by timing, not by how the app is being used:

- **Install** caches the shell's graph only, which the page has just loaded anyway.
- **Every page load**, in a tab or an installed app, asks the worker to cache every route's code once the worker controls the page. Already-cached assets are skipped, so after the first warm of a deployment a load costs one small document per route.

When a route's code is missing anyway -- storage refused, or the network went before the warm finished -- the route's error screen says the device is offline and names the recovery.

The route list is hand-written in the worker (`SHELL_ROUTES`), which is exactly the kind of list that goes stale. A unit test reads the route paths out of the route files' own `createFileRoute` calls and fails when one is uncovered, so a new route cannot ship offline-broken unnoticed. What those entries pull out of a real deployment is a second question, and an integration spec answers it against the built server: it runs the worker's own extraction over each warmed route's served document and fails when a route brings back nothing the shell's install-time graph does not already hold.

### The update path

A new worker does **not** call `skipWaiting()` on install. Taking over immediately would purge, on activate, the very asset cache the already-loaded page lazily fetches from -- on an application whose sessions are long-running, interactive exchanges. So a new worker waits, and takes over at the next cold start; a client that has told its operator an update is ready can post a message to shorten that wait.

The order in which the banner's Reload does that is what keeps the choice the operator's. It starts the reload and posts the message from the page's own `pagehide`, the first moment the reload is known to be going through -- so an operator who answers the beforeunload confirmation with Stay keeps the page, its code, and the pending update exactly as they were, and the banner's Reload applies it whenever they are ready. The takeover posted at `pagehide` is the cold start that page would have handed the update anyway. A persisted `pagehide` is skipped: that is the back/forward cache freezing the page, which can be restored still running this code.

A takeover is origin-wide while the banner is per tab, and an installed PWA holding recurring exchanges is ordinarily open in more than one place, so the tab that applies an update is not the only one announcing it. That takeover clears every other tab's waiting worker, leaving those banners with no worker left to message. Applying one falls back to a plain reload, which loads the code the takeover already activated. The waiting worker is read first, so an update that superseded the announced one is still messaged rather than skipped past by the fallback.

The waiting worker is therefore the accurate form of "an update is available", not a way to defer one indefinitely: the network-first document means an online client already renders the current deployment's HTML.

One load lags a worker-logic change, by construction: the confirming reload's own navigation is dispatched while the outgoing worker is still the controller -- the takeover message posts at `pagehide`, after that navigation has begun -- so the first page after a confirmation is fetched under the old worker's rules until the new one activates and claims it. The network-first document and content-hashed assets make that invisible for content; only a change to the worker's own fetch handling arrives one step late, governing from the claim onward and fully at the next load. No in-page ordering removes this: posting before the reload is what re-created the declined-reload harm this path exists to avoid.

## Hand-written, not generated

`vite-plugin-pwa` and Workbox are the obvious alternative, and their central benefit is a build-time precache manifest: the exact asset list, injected into a generated worker.

That benefit is available here without them. The worker fetches the app document at install and reads the asset graph out of it, so the precache is by construction the graph the deployment ships. A path the extraction misses costs one network fetch on first use; a path it invents fails its own precache and is skipped. Neither failure is silent breakage.

Against that, adopting the tooling costs a dependency and its transitive tree on the one surface in the application that intercepts every request the origin makes -- a surface a reviewer should be able to read end to end. The project's dependency policy asks for exactly that conservatism. The worker is a few hundred lines with no imports, its behavior is driven directly in a unit test against a fabricated service-worker global scope, and there is no generated artifact whose contents have to be trusted.

Deriving the graph at install rather than injecting it at build time does couple the worker to the markup the hosted build emits, and that is the one place the trade is worse. One path read wrongly is absorbed, as above; an extraction that stopped matching the emitted preloads altogether would not be, and it would be silent -- install and the warm would both succeed, holding nothing, and the offline promise would narrow to whatever the operator had already visited. A build-time manifest would fail loudly instead. So that failure is not left to the unit suite, which feeds the worker documents this repository writes and would stay green straight through it, but pinned against the production build the app deploys.

The decision would be worth revisiting if the shell's needs grow past caching -- background sync, navigation preload, precise runtime routing across many asset classes -- where re-deriving Workbox's machinery would be the poorer trade.
