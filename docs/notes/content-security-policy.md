---
title: "The Web App's Content-Security-Policy"
---

# The web app's Content-Security-Policy: the script policy as measured

_Status: built.
The policy below ships in the hosted build's `_headers` and from the console server.
Its `script-src` was measured on 2026-11-10 through a whole exchange in a production build.
A `connect-src` allowlist was weighed and set aside; the reasons are in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#egress-hardening-and-its-limits)._

## The shipped policy

```text
frame-ancestors 'none';
script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'sha256-8ORoeP7ZoOX1k3ePKBnNzdoHYjwUvC86o4oRkUWMb9Y=';
object-src 'none';
base-uri 'none'
```

Sent as one header line; it is stated once, in `apps/web/src/utils/securityHeaders.ts`.
The hash is that of the color-scheme script every document's head holds (`apps/web/src/utils/colorSchemeScript.ts`).
What each directive does and why `'unsafe-eval'` is there: [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#the-shipped-script-policy).

## How it was measured

- **Build.** `npm run build -w apps/web` from staging at `5c8c65ddd`.
- **Server.** A static server answering as the static-host harness does, sending the candidate policy on every response (documents, assets and worker scripts alike, as the Pages `/*` rule does), with a `report-uri` added to collect the browser's reports.
- **Browser.** Playwright 1.64.1's Chromium 156.0.8078.4, headless, with WebRTC's mDNS host-candidate obfuscation off so two pages on one machine connect.
- **The exchange.** An inviter on `/exchange` chose `test_data/fake_data_1.csv`, named a loopback standalone broker under Connection settings, and created the invitation; an acceptor opened its link, chose `test_data/fake_data_2.csv`, and started.
  Both pages reached "Exchange complete" (10 matched records).
- **The sweep.** After the exchange, a third page loaded every route document (`/`, `/quick`, `/direct`, `/saved`, `/saved/abc`, `/verify`, `/exchange`, and an unmatched path), then chose a 5 MB CSV on `/exchange`.
  That file is above the size the app parses off the page, so the CSV-parse and non-empty-aggregate workers ran; the exchange ran the PSI worker.
- **What was read.** The reports posted to the endpoint, and the pages' and workers' console messages.

## Candidates and what the browser reported

Every candidate also had `object-src 'none'` and `base-uri 'none'`, which drew no report in any run.

| `script-src` | Mode | Exchange | Reports |
| ------------ | ---- | -------- | ------- |
| `'self'` | enforced | fails: WebAssembly compile refused | the inline color-scheme script on each document; `eval` in the main bundle; `wasm-eval` in the PSI engine |
| `'self' 'wasm-unsafe-eval'` + hash | enforced | fails: PSI bindings refused | `eval` in the main bundle; `eval` in the PSI engine's glue |
| `'self' 'unsafe-eval' 'wasm-unsafe-eval'` + hash | enforced | completes | none, sweep included |
| `'self' 'unsafe-eval' 'wasm-unsafe-eval'` | enforced | completes | the inline color-scheme script on `/exchange` and `/accept` (no sweep) |
| `'self'` | report-only | completes | every source below |

The report-only run lists every source the build needs at once:

- **The inline color-scheme script**, on every document. Admitted by its hash.
- **WebAssembly compilation** (`wasm-eval`), by the PSI engine on the page and in the PSI worker.
- **The PSI engine's Emscripten glue** (`eval`): `@openmined/psi.js`'s `psi_wasm_web.js` on the page and `psi_wasm_worker.js` in the PSI worker build their embind binding invokers with `new Function` as the module loads.
  This is the source that needs `'unsafe-eval'`.
- **Zod 4.6.7** (`eval`), on the page and in all three workers: a `Function("")` probe deciding whether its schemas compile to generated functions, then those functions.
  Zod catches a refusal and interprets its schemas instead, so it needs nothing, but its probe is still reported.
- The Closure library's `eval` in the PSI glue (`goog.loadModuleFromSource_`) never ran.

No worker is created from a `blob:` URL: the three workers load from `/assets/`, which `'self'` admits, so the policy needs no `worker-src` and no `blob:` source.

## What removing `'unsafe-eval'` takes

- Rebuild the vendored PSI module so its Emscripten glue generates no functions from strings.
  Emscripten's `-sDYNAMIC_EXECUTION=0` is the setting for that; whether the embind output builds under it and still passes the cross-implementation vectors is unverified.
- Set Zod's `jitless` option in every realm (the page and each worker) before the first parse, so its probe draws no report.
- Drop `'unsafe-eval'`, keep `'wasm-unsafe-eval'`, rebuild, and run `apps/web/test/integration/contentSecurityPolicyExchange.test.ts`.

## Limits

- **Chromium only.** No other browser was driven.
  `'unsafe-eval'` also admits WebAssembly compilation, so a browser that does not recognize `'wasm-unsafe-eval'` still compiles it.
- **The console.** Its pages (`/`, `/exchange`, `/accept`, `/direct`) loaded from the built console server under the policy with no violation, with no job API configured.
  No console exchange was run: the console's exchange runs in the container, not the browser.
- **Development servers.** Under `npm run dev:console`, Vite injects an inline React refresh preamble the policy refused, and the page did not render; the development server sends the policy without `script-src`.
  `npm run dev` sends no security headers.

## The checks that hold it

- `apps/web/test/unit/utils/securityHeaders.test.ts` pins the policy and recomputes the hash from the script's source.
- `apps/web/test/integration/contentSecurityPolicyExchange.test.ts` runs the exchange above against the built site and fails on any report or console message naming the policy.
- `apps/web/test/integration/securityHeaders.test.ts` and `apiNamespace.test.ts` hold the header on the wire from the static host and the console server.
