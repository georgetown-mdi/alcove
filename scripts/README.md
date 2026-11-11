# scripts/

Executables CI and contributors run against this repository. Most are the
`check:*` guards `npm run check:all` drives from the one list in
[`run-checks.mjs`](run-checks.mjs), which also states what keeps each excluded
check off it. Beside them:

- `check-doc-links.mjs`, the doc-link checker;
- `dev.mjs`, the `npm run dev` launcher;
- `stryker-security.mjs`, the mutation run;
- `verify-prebuild-provenance.mjs` and `check-release-version.mjs`, the release
  and provenance verifiers;
- `revendor-psi.mjs`, the tree rewrite of a PSI re-vendor that
  `psi_revendor.yaml` runs;
- `npm-audit-retry.mjs`, the production-scope dependency audit with a bounded
  retry, the blocking audit step of `static_checks.yaml`;
- `check-node-modules-drift.mjs`, the dependency-drift check
  `.github/actions/setup` runs after a cache restore;
- `check-playwright-browser.mjs`, the installed-Chromium check the dev
  container's `post-create.sh` runs;
- `merge-claude-settings.mjs`, the Claude settings merge the dev container's
  `post-create.sh` runs;
- `generate-os-package-attribution.mjs`, the OS-layer attribution generator,
  from which `image_smoke.yaml` regenerates each image's list beside `NOTICE`;
- `assert-image-capabilities.mjs`, which `image_smoke.yaml` runs to exercise
  an image against what the shipped file-drop support scripts ask of it, and
  `derive-image-dependencies.mjs`, the module that reads that set out of the
  scripts;
- `list-node-modules-packages.mjs`, the package lister `image_smoke.yaml` runs
  over the built image's tree and the lockfile's, to diff the two;
- `wait-container-pair.mjs`, the container-pair wait that `image_smoke.yaml`'s
  bind-mount smoke step runs the exchange under;
- [`required-suites.mjs`](required-suites.mjs), which prints the builds, test
  suites, and gates a diff needs, as read from the workflows CI runs;
- `slowest-test-files.mjs`, the ranking of slowest test files CI writes into
  each test job's summary;
- `scheduled-run-streak.mjs`, the tally of each scheduled workflow's red
  streak, which docs/TESTING.md names;
- `list-stress-jobs.mjs`, the job list `nightly_core_stress.yaml` runs its
  tiers from;
- `pack-broker-core.mjs`, the packer of the core files the signaling broker
  runs, which `broker_core_build.yaml` archives, signs, and publishes;
- `release-line.mjs`, the newest-release-line decision `release.yaml` reads
  before it deploys production or moves the `latest` image tags;
- `hosted-site-manifest.mjs`, the hosted web application's manifest writer,
  which `release.yaml` runs on the builds it deploys and a partner runs to
  compare a served site against the signed manifest;
- `check-served-security-txt.mjs`, the check of a Pages deployment's served
  security.txt the deploy workflows run after each upload;
- `relay-deployment-check.mjs`, the relay host's deployment check
  `nightly_relay_deployment.yaml` runs;
- `check-broker-front-logs.mjs`, the check of the broker's TLS front logs
  `broker_front_logs.yaml` runs;
- `compare-regex-with-re2.mjs`, the comparison of re2js with C++ RE2 over the
  regex golden cases, with its reference program `re2-reference.py`, which
  `re2js_reference.yaml` runs on a pull request that moves re2js's version;
- `single-pass-bench.mjs`, the single-pass PSI measurement harness behind the
  dataset ceiling in docs/spec/PROTOCOL.md, run by hand and not a check;
- `eslint-strip-type-aware-layer.mjs`, the helper the eslint meta-tests share
  to lint through the repository config without its type-aware layer;
- the helper modules the checks import, in [`lib/`](lib).

A check's test sits beside it; a guard that asserts a workflow, Dockerfile or
config directly is the test alone. Both run in the vitest project `scripts`:

```sh
npx vitest run --project scripts
```

## What belongs here, and what belongs next door

Who RUNS the file decides the directory, not what the file reads: a check whose
whole subject is `.claude/` or `CLAUDE.md` belongs here, because CI runs it.

- CI or a contributor runs it from a plain checkout: here.
- An agent session or the harness runs it -- board tooling, worktree
  provisioning, the Workflow bodies the slash commands invoke by path:
  [`.claude/scripts/`](../.claude/scripts/README.md).
- Claude Code runs it on a tool event, deciding whether the call proceeds:
  [`.claude/hooks/`](../.claude/hooks).

A new check is also a new line in `run-checks.mjs`, in `CHECKS` or in
`OUT_OF_CHECK_ALL` with what keeps it off the merge path; the test beside that
file fails while a `check:*` script is in neither.
