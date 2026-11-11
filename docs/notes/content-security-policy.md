---
title: "The Web App's Content-Security-Policy"
---

# The web app's Content-Security-Policy: the script policy as measured

_Status: built.
The policy below ships in the hosted build's `_headers` and from the console server.
Its `script-src` was measured on 2026-11-10 through a whole exchange in a production build, and `'unsafe-eval'` was removed after a second measurement the same day against a PSI engine rebuilt without generated functions.
A `connect-src` allowlist was weighed and set aside; the reasons are in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#egress-hardening-and-its-limits)._

## The shipped policy

- `frame-ancestors 'none'`
- `script-src 'self' 'wasm-unsafe-eval'` and one `sha256-` hash source, which admits the inline color-scheme script every document's head holds (`apps/web/src/utils/colorSchemeScript.ts`)
- `object-src 'none'`
- `base-uri 'none'`

The value, hash included, is stated once, in `apps/web/src/utils/securityHeaders.ts`.
What each directive does and why `'wasm-unsafe-eval'` is there: [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#the-shipped-script-policy).

## How it was measured

The first measurement, which settled the policy with `'unsafe-eval'`:

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
| `'self' 'wasm-unsafe-eval'` + hash, rebuilt engine, Zod jitless | enforced | completes | none, sweep included |

The report-only run, against the engine as first vendored, lists every source that build needed at once:

- **The inline color-scheme script**, on every document. Admitted by its hash.
- **WebAssembly compilation** (`wasm-eval`), by the PSI engine on the page and in the PSI worker.
- **The PSI engine's Emscripten glue** (`eval`): `@openmined/psi.js`'s `psi_wasm_web.js` on the page and `psi_wasm_worker.js` in the PSI worker build their embind binding invokers with `new Function` as the module loads.
  This was the source that needed `'unsafe-eval'`.
- **Zod 4.6.7** (`eval`), on the page and in all three workers: a `Function("")` probe deciding whether its schemas compile to generated functions, then those functions.
  Zod catches a refusal and interprets its schemas instead, so it needs nothing, but its probe is still reported.
- The Closure library's `eval` in the PSI glue (`goog.loadModuleFromSource_`) never ran.

No worker is created from a `blob:` URL: the three workers load from `/assets/`, which `'self'` admits, so the policy needs no `worker-src` and no `blob:` source.

## How `'unsafe-eval'` was removed

- **The PSI engine.** The fork links its Emscripten targets with `-sDYNAMIC_EXECUTION=0`.
  In the rebuilt `psi_wasm_web.js`, `psi_wasm_worker.js` and `psi_wasm_node.js`, the two embind `new Function` sites are gone; the one string-to-code call left is the Closure `eval` above, which nothing in the bundle calls (`goog.loadModule` has no caller).
  Against the rebuilt engine, the PSI wire and intersection vectors, the native parity suite, and `npm run check:vectors` pass unchanged.
- **Zod.** `apps/web/src/utils/zodJitless.ts` sets `jitless`, and every page and worker entry imports it first.
  Zod probes when a module builds an object schema, not at the first parse, so the call has to run before any schema module does.
  In a worker, a single bundle, the first import does that.
  On the page it does not: the bundler moves Zod and the schema modules into shared chunks, which run before the entry chunk's own code, and the enforced run reported the probe from every document.
  The hosted and console page builds therefore put Zod and `zodJitless.ts` in one chunk (`zodJitlessChunkOutput` in `apps/web/vite.config.ts`), so the call runs inside the chunk every schema chunk imports.
- **The policy.** `'unsafe-eval'` is dropped; `'wasm-unsafe-eval'` and the hash source stay.

The measurement repeated the first one's exchange and sweep through `apps/web/test/integration/contentSecurityPolicyExchange.test.ts`, against a branch build of the fork (commit `bb71a72`, run [42955257319](https://github.com/georgetown-mdi/OpenMinedPSI/actions/runs/42955257319)) installed in a staging checkout.

**The PSI step's time** did not change beyond run-to-run spread.
`node apps/web/test/bench/browserSameSizeRound.ts --role joiner --elements 100000`, the shipped PSI worker in Chromium against a native partner, twice per build on one Apple-silicon Mac:

| Engine | Round wall time | `createClientRequest` | `computeAssociationTable` |
| ------ | --------------- | --------------------- | ------------------------- |
| as first vendored | 85.4 s, 83.8 s | 46.0 s, 44.9 s | 35.8 s, 35.7 s |
| `DYNAMIC_EXECUTION=0` | 90.0 s, 85.0 s | 47.7 s, 45.8 s | 37.4 s, 35.0 s |

## Limits

- **Chromium only.** No other browser was driven.
  With `'unsafe-eval'` gone, `'wasm-unsafe-eval'` is the only source admitting WebAssembly compilation, so a browser that does not recognize it runs no exchange; which browsers do was not measured.
- **The console.** Under the first policy its pages (`/`, `/exchange`, `/accept`, `/direct`) loaded from the built console server with no violation, with no job API configured.
  They were not driven again without `'unsafe-eval'`; its page build carries the same Zod chunk as the hosted one.
  No console exchange was run: the console's exchange runs in the container, not the browser.
- **Development servers.** Under `npm run dev:console`, Vite injects an inline React refresh preamble the policy refused, and the page did not render; the development server sends the policy without `script-src`.
  `npm run dev` sends no security headers.

## The checks that hold it

- `apps/web/test/unit/utils/securityHeaders.test.ts` pins the policy and recomputes the hash from the script's source.
- `apps/web/test/integration/contentSecurityPolicyExchange.test.ts` runs the exchange and the sweep above against the built site, choosing a generated CSV just large enough to start the CSV-parse and non-empty-aggregate workers, and fails on any report or console message naming the policy.
- `apps/web/test/integration/securityHeaders.test.ts` and `apiNamespace.test.ts` hold the header on the wire from the static host and the console server.
