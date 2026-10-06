---
title: "Building Core and the CLI Without tsconfig.tsbuildinfo"
---

# Core dist cache buildinfo: why the build is non-incremental

_Status: decided and built. This note records the `RollupError` a stale
`dist/tsconfig.tsbuildinfo` produced, the single condition that flips it, the
alternatives measured and set aside, and the decision taken: both Rollup
compiles of `packages/core` and `apps/cli` run non-incremental through a shared
`tsconfig.rollup.json`. An earlier cache-side decision is recorded as
superseded. See [docs/notes/README.md](README.md)._

## What was measured

A pull request with a `packages/core/dist` cache hit failed the web suite's
`pretest` build with:

    RollupError: rollup.config.ts (43:29): Expected ',', got ':'

-- rollup parsing raw TypeScript because `@rollup/plugin-typescript` served it
no transpiled config. Reproduced byte-for-byte from a fresh clone: build core,
archive `dist/`, delete it, restamp every tracked file to simulate a fresh
checkout, extract the archive back, then run the build the suite's `pretest`
runs.

The single difference that flips the result is whether
`packages/core/.rollup.cache/` is present. `packages/core/tsconfig.json` sets
`composite: true`, and a build compiling under it maintained two artifacts
that had to stay in step: `dist/tsconfig.tsbuildinfo`, which tells TypeScript
"already emitted, skip", and `.rollup.cache/`, the copy
`@rollup/plugin-typescript` serves instead when TypeScript skips emitting.
`.rollup.cache/` is gitignored and was never part of the cached path, so a
fresh checkout has none; a cache **hit** restores the buildinfo without it,
TypeScript decides `rollup.config.ts` is unchanged and emits nothing, the
plugin's cache fallback has nothing to serve, and rollup reads the raw `.ts`
file. A cache **miss** runs a full `npm run build -w packages/core`, which
writes both artifacts together, so the later `pretest` build is served from
`.rollup.cache/` and succeeds -- the asymmetry the symptom shows only on a
hit.

## Mechanism

The restore step's `dist` cache key already hashes `packages/core/src`,
`rollup.config.ts`, and the tsconfig chain, so a hit binds the artifact to its
inputs by content. The buildinfo was the one entry under `dist/` that was state
rather than product: nothing downstream read it (the apps import the built
`core.esm.js` / `core.cjs` / `index.d.ts`, and the freshness guard in
`docs/TESTING.md` compares source-to-dist mtimes, not the buildinfo), and its
own `include` covers `packages/core/test/**` and `vitest.config.ts`, both
outside the cache key -- so a restored buildinfo could describe a file set the
checkout does not have, independent of the `.rollup.cache/` gap.

## Alternatives considered

- **Cache `.rollup.cache/` alongside `dist/`.** Rejected: its filenames embed
  the build's absolute path, so a runner or a local repro tree at a different
  path reproduces the same `RollupError` against a restored copy of its own
  cache. It also duplicates every emitted file a second time.
- **Restamp differently** (e.g. stamping `dist/` older than sources instead of
  touching every file to now). Rejected: the failure reproduces with and
  without the restamp, and with every source-vs-dist mtime ordering tried --
  restamping addresses the freshness guard and is orthogonal to this failure.
- **Exclude the buildinfo from the cached path list alone, without removing
  it on a hit.** Rejected as the sole fix: an entry already saved under its
  content-derived key is immutable, so an exclusion added going forward does
  not stop a currently-cached entry from continuing to restore the buildinfo
  it was saved with.

## Decision

Every compile `@rollup/plugin-typescript` runs is non-incremental, so no
build-info file is read or written. Each of `packages/core` and `apps/cli` has
a `tsconfig.rollup.json` that extends its `tsconfig.json` with
`composite: false`, `incremental: false`, `declaration: false` and
`declarationMap: false`. Both compiles of a build take it:

- `rollup.config.ts` itself, through the `tsconfig` option of `--configPlugin`
  in the `build` script (and core's `dev` script);
- the sources, through the `tsconfig` option of the `typescript()` plugin in
  `rollup.config.ts`.

The failure reaches local builds as well as the CI cache: a build-info file
with no `.rollup.cache/` beside it -- a deleted cache, or a checkout at a new
path, since the cache's paths are absolute -- broke the config compile. A
non-incremental compile has no build-info file to go stale. Measured against
the real build:

- `incremental: false` alone still fails: with `composite` on, the
  config-plugin compile skips `rollup.config.ts`.
- Turning off `composite` in the config-plugin compile alone moves the failure
  to the sources: `src/index.ts` is parsed as raw TypeScript.
- Without the two declaration options, `apps/cli` (whose tsconfig sets
  `declaration`) writes `.d.ts` files into `dist/`.

With all four, a clean build of either workspace produces the same `dist/`
file for file, less the build-info file, and no `.rollup.cache/` directory.
The cost is a full emit on every build. The project-reference typecheck is
unaffected: it reads `tsconfig.json`, which keeps `composite`.

`scripts/rollup-stale-buildinfo.test.mjs` copies both workspaces, leaves the
build-info file an incremental compile writes and no cache, and runs each
`npm run build`; it runs in the `repo-scripts` project, which
`npm run check:all` drives, not in the unit suites, because two full builds
take about a minute.

## Superseded: removing the build-info file on a cache hit

The first fix was confined to CI. A `packages/core/dist` cache hit removed the
restored `tsconfig.tsbuildinfo` before restamping, and the cached path list
excluded it, in `.github/actions/setup/action.yml`. It left local builds
exposed to the same failure, and the non-incremental build replaced it.

## What this does not cover

This is scoped to the TypeScript emit of the Rollup builds. It does not change
what the `packages/core/dist` cache key binds, the freshness guard compared in
`docs/TESTING.md`, or the install-tree cache the same action also restores.
