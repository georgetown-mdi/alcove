---
title: "Pinned Dependency Internals and Upgrade Checklists"
---

# Pinned dependency internals

Two dependency stacks, the CLI's WebRTC peer and the browser SSH client's library are reached past their public
APIs, so their internals are critical and each of their upgrades is reviewed on
its own, with their assumptions and upgrade checklists in [SFTP_STACK.md](SFTP_STACK.md) and [WEBRTC_STACK.md](WEBRTC_STACK.md); a further dependency, the PSI crypto addon, is a vendored local fork, whose controls, the inlined dependencies and npm's install-script policy are in [NPM_INSTALL_POLICY.md](NPM_INSTALL_POLICY.md). This document records how
the pins are versioned and updated, and the install-time policies that stand
beside them: the GitHub Action pin mirror, and the residuals npm's resolver leaves
in this workspace. The review requirement itself is in
[CONTRIBUTING.md](../../CONTRIBUTING.md#dependency-policy); this is the spec-tier
complement -- the assumptions and the procedure. What the two container images
freeze, pin, and install on top of that tree is in
[CONTAINER_IMAGES.md](CONTAINER_IMAGES.md).

**The upgrade-checklist headings are machine-read.** Each `Upgrading ...`
heading below ends in a parenthesised list of the npm packages that section
covers, separated by ` / ` (the spaces keep a scoped name's own slash intact).
`npm run check:dependabot-pin-coverage` reads those names and fails when one of
them is not held out of the batched dependency groups in
`.github/dependabot.yml`, so a package that earns a checklist here cannot ride a
routine batch where the checklist is skimmed rather than worked through. It
fails on those same names two more ways: some workspace manifest must declare
each, so a checklist cannot outlive its dependency, and every manifest declaring
one must use the same spec, so no manifest admits a version the others do not. A new
section follows the same heading form; the check's header states
what else it reads, and
[its design note](../notes/repo-check-scripts.md#dependabot-checklist-pin-coverage)
what it does not cover. A checklist whose text lives in its own file keeps its
`Upgrading` heading here as a pointer, because the check reads this document
only.

That form is for npm packages only, because every name in such a heading is read
as one and looked up in the npm groups. A checklist for a pin in another
ecosystem therefore has a heading of another shape -- "Bumping the FIPS base
image" below is a docker-ecosystem pin, which no npm group can hold. Renaming
one of those to `Upgrading ...` fails the check with a message asking for an npm
exclude entry that would be false.

## Every pin's update route

Every image, package, vendored module and exact tool version the repository
pins, as surveyed on 2026-11-10, with the route that offers it for upgrade:

- **automatic**: a block in `.github/dependabot.yml`, or a scheduled workflow
  the row names, reaches the pin and opens a pull request.
- **scheduled**: a documented manual cadence moves the pin. The dependency
  step of the release checklist
  ([RELEASES.md](../RELEASES.md#4-review-and-audit-dependencies)) bumps the
  FIPS base, which moves the FIPS image's Node runtime with it, and re-checks
  the other scheduled pins every release.
- **planned**: an automatic or scheduled route for the pin is planned and not
  yet in place.
- **none**: nothing offers an upgrade, and the pin moves only when someone
  edits it.

A route says how an upgrade is offered, not how it is reviewed. The reviewed
groups, the literals that move in the same diff and the checklists are in the
section each row links.

| Pin | Where | Recorded as | Route | How it moves |
| --- | --- | --- | --- | --- |
| `@openmined/psi.js` | `lib/openmined-psi.js-<version>.tgz`, a `file:` dependency of `packages/core`, `apps/cli` and `apps/web` | Version in the file name, the sha256 sidecar, and the lockfile `integrity` | automatic | The `npm` block at `/` ignores every version update of it. `psi_revendor.yaml` reads the fork's latest GitHub Release daily and, when its version is newer than the vendored one, verifies the tarball's attestation and opens the re-vendor pull request into `staging` as a draft, by [PREBUILD_REVENDOR.md](../PREBUILD_REVENDOR.md), which stays the manual route. It pushes and opens it with the `ALCOVE_REVENDOR_TOKEN` secret, whose renewal is in [RELEASES.md](../RELEASES.md#4-review-and-audit-dependencies). [The vendored @openmined/psi.js addon](NPM_INSTALL_POLICY.md#the-vendored-openminedpsijs-addon) states what a rebuild must keep. |
| npm registry packages | Every workspace `package.json` and the root `package-lock.json` | Ranges in the manifests apart from one exact version, versions and `integrity` in the lockfile | automatic | The `npm` block at `/`, weekly. The reviewed groups and the routine batch are in [How these packages are versioned](#how-these-packages-are-versioned). |
| `vite` under `vitepress` | The root `package.json` `overrides` entry | The range `^6.4.5` | scheduled | The range admits a later 6.x release, which lands by `npm update vite --package-lock-only` ([The project site's vite override](#the-project-sites-vite-override)), run each release. A Dependabot pull request does not move it: measured 2026-11-10 with the Dependabot CLI 1.97.0, its `vite` bump leaves this entry and the nested copy as they were, with a later release in the range available. |
| wrangler | `.github/wrangler/package.json` and its lockfile | The exact version `4.147.0` | automatic | The `npm` block at `/.github/wrangler`. The six `wranglerVersion` inputs move by hand in the same pull request ([The Pages deploy tool](#the-pages-deploy-tool)). |
| `sharp` and `undici` under wrangler | The `.github/wrangler/package.json` `overrides` entry | The exact versions `0.35.5` and `7.30.2` | scheduled | Each comes out when the locked wrangler resolves that release or a later one, which is checked each release. A Dependabot pull request does not remove either: measured 2026-11-10 with the Dependabot CLI 1.97.0, its wrangler bump from 4.147.0 to 4.158.0 leaves both entries as written, though the `miniflare` that release locks declares `sharp` `0.35.5` itself. |
| Default image base | `Dockerfile`, both stages | The `node:26-alpine` index digest | automatic | The `docker` block at `/`. The freeze literal and the attribution list move in the same diff ([Bumping the default base image](#bumping-the-default-base-image)). |
| FIPS image base | `Dockerfile.fips` | The ECR Public `amazonlinux` index digest, `AL2023_RELEASEVER`, and the certified provider's NVR pins | scheduled | Bumped through [Bumping the FIPS base image](#bumping-the-fips-base-image) at each release, from the dependency step of the release checklist ([RELEASES.md](../RELEASES.md#4-review-and-audit-dependencies)), and when `image_smoke.yaml`'s weekly scan flags a base CVE with a fix. The `docker` block at `/` ignores its three names. |
| FIPS image Node runtime | `Dockerfile.fips` | `ARG NODE_VERSION` (`v26.13.0`) and the two tarball sha256 values | scheduled | No Dependabot block reads it. Each FIPS base bump moves it to the current Node 26 release ([Bumping the FIPS base image](#bumping-the-fips-base-image)), so a Node release waits for the next base rebuild. |
| SFTP relay image base | `packages/sftp-relay/Dockerfile`, both stages | The `node:26-alpine` index digest | automatic | The `docker` block at `/packages/sftp-relay`. |
| TURN relay image | `infra/relay/Dockerfile` | The `coturn/coturn:4.18.0` index digest | automatic | The `docker` block at `/infra/relay`. |
| Broker TLS front image | `infra/broker/Dockerfile` | The `nginx:1.31-alpine` index digest | automatic | The `docker` block at `/infra/broker`. |
| Relay 443 front image | `infra/relay/front/Dockerfile` | The `nginx:1.31-alpine` index digest | automatic | The `docker` block at `/infra/relay/front`. |
| BuildKit daemon image | The four `docker/setup-buildx-action` steps in `release.yaml` and `image_smoke.yaml` | The `moby/buildkit:v0.34.2` index digest in `driver-opts`, and in `.github/builder-images/Dockerfile` | automatic | No Dependabot block reads an action input, so the `docker` block at `/.github/builder-images` moves the Dockerfile's pin, and `scripts/dockerhub-login.test.mjs` fails until the same pull request moves the four inputs by hand. |
| QEMU emulator image | The two `docker/setup-qemu-action` steps in `release.yaml` | The `tonistiigi/binfmt` index digest, and the `qemu-v10.2.3` tag with that digest in `.github/builder-images/Dockerfile` | automatic | The same block and test, for the two inputs. Whether Dependabot compares the `qemu-v` tags as versions is unmeasured until its first run on the block. |
| Commit-pinned actions | Every remote action in `.github/workflows` and `.github/actions` | A commit, with its release tag in a trailing comment | automatic | The `github-actions` block at `/` and each composite action's directory, which has no ignore entry and groups every minor and patch action update into one weekly pull request, each major bump opening its own ([GitHub Action pins and the composite mirror](#github-action-pins-and-the-composite-mirror)). The composite occurrences follow the workflow pins ([The composite mirror](#the-composite-mirror)). No step passes `trivy-action` a `version` input, so the Trivy release it installs is the one the pinned commit selects. |
| Cosign release | The `cosign-release` input of two steps in `pages_deploy.yaml` and three in `release.yaml` | `v3.1.4`, and the `ghcr.io/sigstore/cosign/cosign` tag in `.github/tool-versions/Dockerfile` | automatic | No Dependabot block reads an action input, so the `docker` block at `/.github/tool-versions` moves the Dockerfile's tag, and `scripts/tool-versions.test.mjs` fails until the same pull request moves the five inputs by hand. `broker_core_build.yaml` passes no `cosign-release`, so its Cosign is the release the pinned installer selects. |
| Python | The `actions/setup-python` step in `re2js_reference.yaml` | `python-version` `3.12.10`, and the `python` tag in `.github/tool-versions/Dockerfile` | automatic | The same block and test, for patch releases on the 3.12 line. The block's `ignore` entry holds out minor and major releases, which move by hand. The comparison runs only on a pull request moving re2js, so it does not exercise a bump here. |
| google-re2 | `scripts/re2-reference/requirements.txt`, which `scripts/compare-regex-with-re2.mjs` installs from | `google-re2==1.1.20251105` | automatic | The `pip` block at `/scripts/re2-reference`. As with Python, the comparison does not run on its pull request. |
| Runner images | `runs-on` in `.github/workflows` | `ubuntu-26.04` on most jobs, `ubuntu-24.04` on seven | scheduled | No Dependabot ecosystem reads a runner label, so each release compares them with the runner images GitHub offers. |
| AWS CLI | `.devcontainer/Dockerfile`, infrastructure profile | `AWSCLI_VERSION` (`2.36.38`) and the two archive sha256 values, and the `amazon/aws-cli` tag in `.github/tool-versions/Dockerfile` | automatic | The `docker` block at `/.github/tool-versions` moves the Dockerfile's tag, and `scripts/tool-versions.test.mjs` fails until the same pull request moves `AWSCLI_VERSION`. The two sha256 values move by hand in that pull request, each taken from an archive whose signature verifies, as `.devcontainer/README.md` describes. |
| Cloudflare OpenTofu provider | `infra/hosted/.terraform.lock.hcl` | `5.25.0` with its hashes, under `~> 5.0` in `versions.tf` | automatic | The `opentofu` block at `/infra/hosted`. Measured 2026-11-10 with the Dependabot CLI 1.97.0: the `opentofu` ecosystem rewrites this lock file's version and hashes (5.25.0 to 5.28.1), while the `terraform` ecosystem looks the provider up at `registry.terraform.io`, finds no locked version, and opens no pull request. |

These resolve at build or run time, so they have no pin to route:

- `node-version: "26"` in the workflows and the setup composite, and `.nvmrc`.
- The `macos-latest` and `windows-latest` runners.
- The default image's `apk add samba-client`, against the Alpine mirror
  ([CONTAINER_IMAGES.md](CONTAINER_IMAGES.md#the-docker-images-dependency-freeze)).
- The development container's `node:26-bookworm` base and its Claude Code
  install at `latest`.
- The Windows setup scripts' helper image, `ghcr.io/georgetown-mdi/alcove:latest`
  ([CONTAINER_IMAGES.md](CONTAINER_IMAGES.md#the-helper-image-the-setup-scripts-run-the-probe-in-is-a-mutable-tag)).
- The FIPS provider probe, whose workflow reads its base from `Dockerfile` and
  resolves its OpenSSL tag when it runs.

## How these packages are versioned

The registry packages below take version ranges in their manifests
(`^1.17.0`), not exact versions, apart from the browser SSH client's library. Every workspace manifest is private, and the
Dockerfiles and CI install with `npm ci` from the committed `package-lock.json`,
so the lockfile fixes the version installed; an exact version in a manifest
would change nothing that is installed.

What protects their internals is how an upgrade arrives. Alcove's code uses
those internals, so each upgrade normally comes in a Dependabot pull request
of its stack's reviewed group, held out of the routine `non-critical` batch,
and is checked against its checklist below before it merges. Any upgrade
changes `package-lock.json` in a pull request, and the CLI suites
(`.github/workflows/cli_build_and_test.yaml`) run on every pull request,
driving the real `ssh2` stack against a real SFTP server and two real werift
peers. No check confirms that a pull request moving one of these packages in
the lockfile is its stack's Dependabot pull request: an `npm update` or
`npm audit fix` elsewhere moves it within its range, and review and those
suites are what stand in its way.

An upgrade that breaks an assumption and cannot be fixed in the same pull
request is held back with a range cap (`>=1.17.0 <1.18.0`) or a Dependabot
`ignore` entry for that version, not an exact pin.

- **SFTP stack (`ssh2` / `ssh2-sftp-client`).** The CLI's SFTP adapter
  (`apps/cli/src/connection/ssh2SftpAdapter.ts`) drives `ssh2` internals past the
  public `ssh2-sftp-client` API. Both are declared in `apps/cli/package.json`
  and pulled out of the routine Dependabot batch into the reviewed
  `cryptographic` group (`.github/dependabot.yml`).
- **WebRTC stack (`peerjs` / `peerjs-js-binarypack`).** The web data-channel
  inbound bound reaches into PeerJS reassembly/unpack internals
  (`apps/web/src/psi/transport/boundedReassembly.ts`). Both are declared in
  `apps/web/package.json` and pulled out of the routine Dependabot batch into a
  reviewed `webrtc-stack` group (`.github/dependabot.yml`).
  `peerjs-js-binarypack` is reviewed with `peerjs` because both sides of an
  exchange decode its wire format, not because Alcove uses its internals: Alcove
  calls only its public `pack` and `unpack`, and the bound's marker scan
  (`packages/core/src/connection/binaryPackBounds.ts`) reads the wire format
  itself. `packages/core` declares it too, with the same range, because core's
  PeerJS framing (`packages/core/src/connection/peerjsWire.ts`) unpacks the wire
  with it, and because the marker scan's differential test drives the real
  encoder as its oracle -- so the guard over the shared bound holds whether or
  not an app keeps the dependency.
  The CLI's WebRTC transport uses that framing; the web transport decodes
  through PeerJS itself, plus its own bounded reassembly
  (`apps/web/src/psi/transport/boundedReassembly.ts`).
  The shared WebRTC inbound frame fixtures both transports are held to are
  built with the real packer in core as well
  (`packages/core/src/connection/webrtcInboundFrameFixtures.ts`, published on
  `@alcove/core/testing`). Both declarations must move together -- a browser peer and a CLI
  peer that pack differently cannot exchange a frame, and a core scan or a
  shared fixture set differentiated against a different version than either app
  ships is not testing the shipped assumption.
- **CLI WebRTC peer (`werift`).** The CLI drives werift's `RTCPeerConnection`
  directly rather than running PeerJS in Node
  (`docs/notes/cli-webrtc-stack.md`), so the transport depends on behaviours
  werift's published API does not state -- and its flushing close reaches past
  that API into the SCTP association's send queues, because nothing public
  reports what the peer has actually received. Declared in
  `apps/cli/package.json`, and pulled out of the routine Dependabot batch into
  the same reviewed `webrtc-stack` group (`.github/dependabot.yml`) as the
  browser half it exchanges with, because the two ends speak one data channel
  and a bump on either is reviewed against both. The assumptions and the
  re-verification procedure are in
  [Upgrading the CLI WebRTC peer (werift)](WEBRTC_STACK.md#upgrading-the-cli-webrtc-peer-werift).
  werift 0.27.0 was taken on 2026-11-10, before the seven-day cooldown
  (`.github/dependabot.yml`) ended, by the maintainer's decision: its
  published tarball was first rebuilt byte for byte from the upstream tag
  `v0.27.0`, and it showed no install scripts and no new capability.
- **Browser SSH client library (`@microsoft/dev-tunnels-ssh`).** The web app's SSH client reaches past its main entry. It is declared in `apps/web/package.json` at an exact version, the one exception to the ranges above, and pulled out of the routine Dependabot batch into the reviewed `cryptographic` group (`.github/dependabot.yml`). See [Upgrading the browser SSH client (@microsoft/dev-tunnels-ssh)](#upgrading-the-browser-ssh-client-microsoftdev-tunnels-ssh).
- **PSI crypto addon (`@openmined/psi.js`).** Pinned by construction: an Alcove
  fork vendored as a local `file:` tarball
  (`lib/openmined-psi.js-<version>.tgz`), whose path resolves to exactly the
  committed bytes. See
  [The vendored @openmined/psi.js addon](NPM_INSTALL_POLICY.md#the-vendored-openminedpsijs-addon).

## GitHub Action pins and the composite mirror

Every action a workflow uses is pinned by ref. Every remote action, in a
workflow or a composite action, is pinned to a commit with the release tag in a
trailing comment (`actions/checkout@<commit> # v7.0.1`), at every occurrence, so
one action has one ref across the workflows. The rule pins every organization
alike, the steps that run beside the release signing identity
(`id-token: write`) or the Docker Hub publish token included. The
`github-actions` block in `.github/dependabot.yml` is configured against
`.github/workflows` and each composite action's directory under
`.github/actions`, and has no `ignore` entry, so a within-major release opens a
pull request and moves the pin. One group holds every minor and patch action
update, so a weekly run opens one pull request for them, and each major bump
opens its own.
Measured 2026-11-10 with the Dependabot CLI 1.97.0, with `actions/setup-node`
rolled back in both trees: the block's grouped pull request moves the pin in the
workflows and in `.github/actions/setup/action.yml`, while the block configured
against `/` alone moves the workflows and leaves the composite behind.
`scripts/signed-build-inputs.test.mjs` (run by `npm run test:scripts`, a CI
static check) fails on a remote reference that is not a commit followed by its
`# vX.Y.Z` tag.
The same test fails on an `ignore` entry in that block that names a minor or
patch update type, or names no update type, since such an entry would freeze
every commit pin it covers.

One more invariant keeps that configuration accurate, held by a check rather than
by this document: the composite mirror below.

### The composite mirror

The shared CI prologue composite (`.github/actions/setup/action.yml`) pins
actions of its own. The Dependabot block above lists its directory, and a
mirror check holds it beside the workflows:

**Every action pin under `.github/actions` is identical to a pin under
`.github/workflows`.** A release or advisory then shows on the workflow
occurrence, and the bump answering it cannot land there and leave the composite
stale -- which makes the composite occurrence transitively tracked.

`scripts/check-action-pin-drift.mjs` (`npm run check:action-pin-drift`, a CI
static check in `static_checks.yaml`) holds it rather than prose. It parses
every workflow and every `action.yml` with the `yaml` package and walks each
document for `uses:` values (skipping `./` local and `docker://` references,
which name no remote action). It fails on three conditions: an action named in
both trees with differing refs anywhere it appears, a composite pin naming an
action no workflow uses, and a remote reference naming no ref at all. The second
is what keeps the mirror from being satisfied vacuously -- a composite-only
action has no occurrence on the configured path at all, so it fails closed and
the decision (mirror the pin into a workflow, or extend Dependabot coverage to
`.github/actions`) is made explicitly rather than by omission. The third closes
the same gap one layer down: an unpinned reference (`uses: actions/setup-node`,
a trailing `@` with nothing after it, or a leading `@`) fixes no version.
Nothing in the repository then determines which code the step runs and no
release or advisory has an occurrence to show on -- it cannot stand as either
side of the mirror. Whether GitHub itself rejects that shape is unverified, and
the rule does not rest on it: if GitHub does, the rule never fires.

The comparison is textual. Two occurrences naming one commit agree whatever tag
each trailing comment names, so a comment naming a tag the commit does not carry
is outside the check, as is anything about which paths Dependabot in fact scans --
it enforces this repo's mirror invariant and confirms no tool's coverage. It
reads `uses:` references only, so an action reached another way is invisible to
it, and its ref-agreement rule binds only actions appearing in both trees.

### The Pages deploy tool

`cloudflare/wrangler-action` installs wrangler itself, with an unlocked
`npm i wrangler@<version>`, unless the wrangler already installed in its
`workingDirectory` reports the exact `wranglerVersion` the step passes (read
from the action's source at the pinned commit, `src/wranglerAction.ts`,
`installWrangler`; not driven here).
So the deploy tool has a lockfile of its own:

- `.github/wrangler/` holds a `package.json` naming one exact wrangler version
  and an `overrides` entry holding `sharp` at `0.35.5` and `undici` at
  `7.30.2`, and its `package-lock.json`, and nothing else.
  Each override lifts a transitive package of the pinned wrangler to a release
  with no advisory at moderate or above, and comes out when a wrangler bump
  resolves that release or a later one on its own.
- Each of the six upload steps (two in `pages_deploy.yaml`, two in
  `release.yaml`, one in `site_deploy.yaml`, one in `site_publish.yaml`) runs in
  a job that sparse-checks-out those two files alone, runs `npm ci` there, and passes that directory as
  `workingDirectory` with the locked version as `wranglerVersion`.
- An `npm` block in `.github/dependabot.yml` names that directory, so its
  updates come as Dependabot pull requests against the lockfile.

`scripts/signed-build-inputs.test.mjs` holds the steps to the lockfile: it
fails while a step's `wranglerVersion` differs from the version the lockfile
installs, so a lockfile bump turns the check red until the same pull request
moves all six steps.
The lockfile fixes which package versions install and then run inside the
upload step, where the token is; it does not review them.
`npm ci` there runs without `--ignore-scripts`, so the install scripts of the
locked packages run in the same job, and whether `wrangler pages deploy` works
with those scripts skipped is unmeasured.

## npm resolution residuals

Four records of what npm's resolver leaves behind in this workspace: the
packages the release SBOM omits, what a root `overrides` block does to the
lockfile it is added to or removed from and to later installs, the one override
the root `package.json` holds, and the `brace-expansion` copy the development
tree holds. Their normative residue is short -- the root `package.json` holds
one `overrides` entry, for the project site's `vite`, and two CI checks watch
what an `overrides` block leaves behind, the out-of-range edges and the split
hoist. The measurement behind each is kept so the dead ends are not re-walked.

### The release SBOM's hoisting residual

Release step 9 in [RELEASES.md](../RELEASES.md#9-generate-and-attach-the-sbom) runs `npm sbom` with no workaround flag, and its BOM omits a few packages the shipped tree holds. Re-driven 2026-11-10 against the tree `npm ci` installed from the lockfile as committed (the figures depend on the npm version, 11.20.0):

- `npm sbom --sbom-format cyclonedx --omit=dev -w packages/core -w apps/cli -w apps/web` exits 0 at 101 components, and the same command without `-w apps/web` exits 0 at 55. Every one of those 55 also appears in the 101, by name and version, so the full-scope command closes the web console's runtime set into the BOM rather than dropping it.
- With `--package-lock-only` added, the command lists the same 101 components with the same dependency graph, and no licence for `ssh2`, `cpu-features` and `buildcheck`, which declare theirs only in the older `licenses` array that the lockfile does not record.
- `npm ls --all --omit=dev` exits 0, so the tree reports no peer conflict.
- `yaml` 2.9.1 and `tslib` 2.8.1 are installed in the shipped tree, per `npm ls yaml tslib --omit=dev -w packages/core -w apps/cli -w apps/web`, and absent from the step 9 command's component list, which holds no `tslib` at all.

The residual is a property of how `npm sbom` walks a hoisted entry shared with a dev-only consumer, and RELEASES.md states the query that checks one package's presence when the BOM lacks it.

### What a root `overrides` block changes about later installs

The root `package.json` holds one `overrides` entry, recorded in
[The project site's vite override](#the-project-sites-vite-override). Adding
another is the answer of last resort here rather than a routine fix, for the
three npm behaviors below:
the block is not applied or removed by an ordinary install, it can hand a
dependent a version its declared range excludes, and its mere presence changes
how a later range bump is hoisted.

**Adding or removing an override does not re-resolve the lockfile.** npm leaves
a lockfile whose existing resolution already satisfies its dependents
byte-identical when an override is added, so adding the block appears to do
nothing at all: re-driven 2026-10-01 on 11.17.0 and 11.19.1, `npm install`,
`npm install --package-lock-only`, and each with `--force` return it unchanged.
Removing one does the same. Driven 2026-10-01 by deleting a root
`"brace-expansion": "^5.0.8"` override that held two `minimatch` copies
declaring `^2.0.1` and `^2.0.2` on a hoisted 5.0.12: `npm install
--package-lock-only` on 11.17.0 and 11.19.1, and `npm install` on 11.19.1, leave
the lockfile byte-identical, and `npm ls --all` then marks both edges `invalid`.
The route that applies either direction surgically is to delete the lockfile
entries the change has to move and re-run `npm install --package-lock-only`: on
that removal, deleting the hoisted `node_modules/brace-expansion` entry restored
it at 5.0.12 and added exactly a `brace-expansion@2.1.7` and a
`balanced-match@1.0.2` entry under each of `archiver-utils` and `readdir-glob`,
changing nothing else, on both releases. A from-scratch resolve applies an
override too and is not the route: adding that same override that way on
2026-10-01 changed 246 package versions against the lockfile it started from,
added 26 entries and removed 59, a far larger review surface than the change
being landed.

**An override can hand a dependent an API-incompatible major.** An override
forces every dependent onto the overridden version whatever range it declared,
and npm does not reliably report the result. With such an override in force,
npm 11.17 marks the edge `invalid` -- `npm ls --all` exits 1 with
`ELSPROBLEMS`, and an unscoped `npm sbom` refuses with `ESBOMPROBLEMS` -- while
npm 11.19.1 marks neither (measured 2026-09-27, re-driven 2026-10-01 on 11.17.0
and 11.19.1). What the edge is underneath shows only when the dependent's code
runs. `brace-expansion@5.0.12` exports a named `expand` and no callable default:
`Object.keys(require("brace-expansion"))` is
`["EXPANSION_MAX", "EXPANSION_MAX_LENGTH", "EXPANSION_MAX_DEPTH",
"EXPANSION_MAX_REWRITES", "expand"]`, and `.default` is `undefined`. With the
override above in force, `braceExpand("a{b,c}d")` threw from `minimatch@5.1.9`
with `TypeError: expand is not a function` and from `minimatch@9.0.9` with
`TypeError: (0 , brace_expansion_1.default) is not a function`, while
`npm run build -w apps/web` exited 0, `npm audit --package-lock-only` answered
`found 0 vulnerabilities`, and npm 11.19.1 listed both edges as `deduped` with
no marking.

**What catches that.** `scripts/check-locked-dep-ranges.mjs`
(`npm run check:locked-dep-ranges`, run by `npm run check:all`) reads the
committed lockfile and fails on any edge whose locked version lies outside the
range its dependent declared, naming the dependent, the declared range and the
locked version, for every dependent the lockfile records: the root project,
each workspace, and each installed package. An edge meant to stand is recorded
with its reason in the check's `OUT_OF_RANGE_BY_DESIGN` list, whose only
entries are the three React peer edges of `@docsearch/react`, the Algolia
search package the project site's generator installs and the site does not
build, and the `vite` edge of `vitepress` the root override forces; an
override-forced edge fails until it is recorded, and a recorded edge
that comes back into range fails until its entry is deleted. It compares
declared ranges with locked versions only, and does not model npm's resolution
or which override forced an edge.

**A later range bump splits across the workspace boundary.** This is the
behavior an author who adds an override and moves on meets later. With a root
`overrides` block present, npm does not always hoist a later range bump
incrementally: the stale hoisted copy is kept and the new version is nested
under the workspace that raised its range. What an operator or reviewer
actually sees is not that mechanism but its result -- two copies of one package
split across the workspace boundary, resolved by different dependents -- and
nothing at install time reports the split.

The split depends on the command as well as the npm release. Re-driven
2026-10-01 by re-applying the `vite` bump below to the lockfile it started from
and running `npm install --package-lock-only`, with the block present and with
it removed:

- npm 11.17.0 keeps `node_modules/vite` at 8.1.4 and nests the bumped range's
  8.3.2 under `apps/web` with the block present, and hoists 8.3.2 to the root
  with it removed.
- npm 11.18.0, 11.19.0 and 11.19.1 hoist 8.3.2 to the root either way.

Re-driven 2026-10-17 on npm 11.20.0, with the block present and not toggled.
`vite` has no release after the 8.3.4 the lockfile holds, so `playwright`, which
`apps/web` declares and the root also holds, stood in for it:

- A named install into the workspace, `npm install -w apps/web playwright@1.64.1`
  over a root `playwright` 1.64.0, nests `playwright` and `playwright-core`
  1.64.1 under `apps/web`, and `scripts/check-nested-root-package.mjs` fails
  naming both.
- Deleting those two `apps/web/node_modules` lockfile entries and running
  `npm install --package-lock-only` hoists 1.64.1 to the root and the check
  passes.
- Raising only the range in `apps/web/package.json` and running
  `npm install --package-lock-only` on the same bump hoists 1.64.1 to the root
  and nests nothing.

So a lockfile update can still produce the split: a named workspace install on
npm 11.20.0, or a re-resolve on npm 11.17, run by hand or by a bump tool whose
bundled npm is such a release. A named install was driven only on npm 11.20.0,
not on 11.17 through 11.19.1, and only with the block present, so whether it
splits without the block is not measured. No bump tool was driven here.

**Measured** on the `apps/web` bump of `vite` from `^8.1.4` to `^8.1.5`: the
regenerated lockfile kept `node_modules/vite` at 8.1.4 and nested
`apps/web/node_modules/vite` at 8.1.5; vitest and the `@tanstack/*` chain resolved
the root copy while `@vitejs/plugin-react` resolved the nested one. No package
required `vite` below 8.1.5, so the retained root copy was a stale hoist and not a
constraint. Toggling only the root `overrides` key against live npm, over two base
lockfiles, is what attributes the behavior to the block's presence.

**The remedy measured to work** is to hoist the bumped copies to the root, drop
the nested lockfile entries, and re-resolve with `npm install --package-lock-only`.
Deleting the nested entries alone and re-resolving can resolve past the bumped
version: on #2466, a group bump that nested the new `vite`, `rolldown` and
`rollup` copies under `apps/web`, `apps/cli` and `packages/core`, that route moved
`rollup` to 4.65.1, past the version the bump set. Hoisting the bumped copies to
the root first and then re-resolving left the result unchanged, which held the
bumped versions. Deleting alone did clear the `playwright` split above; what
decides whether it overshoots was not measured, so the hoist is the route either
way. Two routes were measured not to work: `@dependabot rebase` and
`@dependabot recreate` each reproduce the duplicate. A from-scratch resolve does
hoist correctly and is still not the remedy, for the reason stated above of the
same route: it moves hundreds of unrelated package versions, which is a far larger
review surface than the bump being landed.

**What catches the next one.** `scripts/check-nested-root-package.mjs`
(`npm run check:nested-root-package`, a CI static check in `static_checks.yaml`)
reads the committed lockfile and fails on any package installed at the top level
of both the root `node_modules` and a workspace's, naming the package and both
entries. The split then lands as a named failure on the bump's own pull request
rather than as a downstream failure that does not name it. It covers every package rather
than the ones this has happened to, because the mechanism is the block's
presence and not any one dependency; a split that is meant to stand is recorded,
with its reason, in the check's own `NESTED_BY_DESIGN` map, which holds one:
`apps/web`'s `buffer` at major 5, the browser SSH client's library's line. What
it reports is the split the lockfile records, not one npm would resolve, and
only at that one depth: a copy nested under another package is ordinary conflict
resolution, which this tree has dozens of.

### The project site's vite override

The root `package.json` holds `"overrides": { "vitepress": { "vite": "^6.4.5" } }`.
VitePress 1.6.4, the newest non-prerelease, declares `vite` `^5.4.14`, and every
vite 5 release depends on an esbuild below 0.25, which GHSA-67mh-4wv8-2f99 covers
(a website can send requests to esbuild's development server and read the
response). Without the override, `npm audit --package-lock-only` reports
esbuild 0.21.5, vite 5.4.21 and vitepress 1.6.4 with no fix available.

The override forces vitepress's `vite` onto the vite 6 line from 6.4.5, the
first release outside every advisory against vite 6 published by 2026-11-03:
the eight covering 6.4.3 and earlier, and GHSA-8g5g-mxqh-grgj, which covers
6.4.4 alone. It is a
range, so a later 6.x fix lands by `npm update vite --package-lock-only`, which
moves the nested copy and leaves the rest of the lockfile alone, with no
`package.json` edit. vite 6 depends on esbuild `^0.25.0`, which resolves to
0.25.12.

Each of those advisories concerns a running development server, none the build
or its output. The site deploys as a static build (`npm run site:build` in
`.github/workflows/site_deploy.yaml`), so only a contributor running
`npm run site:dev` locally starts that server.

Measured 2026-11-03 on npm 11.20.0 with the override in force:

- `npm audit --package-lock-only` reports no `vite`, `esbuild`, `vitepress` or
  `@vitejs/plugin-vue` entry.
- `npm run site:build` completes, with VitePress's dead-link check running.
- The lockfile change is confined to the entries under
  `node_modules/vitepress/node_modules`, applied by the route
  [above](#what-a-root-overrides-block-changes-about-later-installs): delete those
  `vite`, `esbuild` and `@esbuild/*` entries, then `npm install --package-lock-only`.
- `esbuild@0.25.12` declares an install script, and the `allowScripts` map denies
  it as it denied 0.21.5; the site build above runs with that script blocked.
- `npm run site:dev` serves the site on the overridden copy, on loopback only.

The edge is recorded in `OUT_OF_RANGE_BY_DESIGN`, and the nested form is one the
`allowScripts` check reads. Remove the override when a non-prerelease VitePress
declares a `vite` range outside the advisories.

### The development tree's brace-expansion copy

The tree holds one `brace-expansion` copy, 5.0.12, hoisted at the root for
`minimatch@10.2.5` under `eslint` and development-only. On npm 11.19.1 against
the committed lockfile: `npm ls brace-expansion --all`
names that copy alone, `npm ls brace-expansion --omit=dev` prints `(empty)`,
npm's no-match answer, and `npm audit --package-lock-only` and
`npm audit --omit=dev --package-lock-only -w packages/core -w apps/cli -w apps/web`
each answer `found 0 vulnerabilities`. An advisory against it is a
development-tree finding, triaged as [CONTRIBUTING.md](../../CONTRIBUTING.md#dependency-policy)
states, and an override answering one carries the costs recorded in
[What a root `overrides` block changes about later installs](#what-a-root-overrides-block-changes-about-later-installs).

## Upgrading the SFTP Stack (ssh2 / ssh2-sftp-client)

The internal assumptions the CLI's SFTP adapter makes about `ssh2` and `ssh2-sftp-client`, and the checklist to re-verify them on a bump, are in [SFTP_STACK.md](SFTP_STACK.md).

## Upgrading the PeerJS Stack (peerjs / peerjs-js-binarypack)

The internal assumptions the web transport makes about `peerjs` and `peerjs-js-binarypack`, and the checklist to re-verify them on a bump, are in [WEBRTC_STACK.md](WEBRTC_STACK.md#upgrading-the-peerjs-stack-peerjs--peerjs-js-binarypack).

## Upgrading the CLI WebRTC peer (werift)

The internal assumptions the CLI's WebRTC transport makes about `werift`, and the checklist to re-verify them on a bump, are in [WEBRTC_STACK.md](WEBRTC_STACK.md#upgrading-the-cli-webrtc-peer-werift).

## Upgrading the browser SSH client (@microsoft/dev-tunnels-ssh)

The web app's SSH client (`apps/web/src/psi/transport/browserSsh/`) runs its session on `@microsoft/dev-tunnels-ssh`, through the SFTP relay ([SFTP_RELAY.md](SFTP_RELAY.md)). No shipped page loads it yet. The library is a cryptographic dependency, and the client reaches it past its main entry, so this checklist covers the internals it rests on. Why the library was chosen is in [browser-sftp-proxy.md](../notes/browser-sftp-proxy.md#the-chosen-client-dependency-check-and-sizing).

### The exact pin

`apps/web/package.json` declares the exact version, `3.12.42`, not a range. This is the one exception to the ranges in [How these packages are versioned](#how-these-packages-are-versioned). An `npm update` or `npm audit fix` cannot move it: only a manifest edit does. Dependabot opens that edit in the `cryptographic` group (`.github/dependabot.yml`), and the pull request is checked against this section before it merges.

### The internal assumptions

- **Deep imports.** The main entry requires Node's `stream` when it loads (`sshStream.js`, `secureStream.js`), and no browser bundle here provides one. So the client imports the modules it uses by path, all through `browserSsh/sshLibrary.ts`. The package has no `exports` map; a release that adds one hiding those paths fails the build. That file enters `algorithms/sshAlgorithms` first: `algorithms/publicKeyAlgorithm`, `io/sshData` and `algorithms/sshAlgorithms` require one another in a cycle, which completes only in that order.
- **The `diffie-hellman` load and call split.** `algorithms/web/webKeyExchange.js` requires `diffie-hellman` when it loads, and calls it only for a negotiated finite-field key exchange. The client offers ECDH alone (`ecdh-sha2-nistp256`, `-384`, `-521`), so every browser config aliases the package to a stub that throws `BrowserSshUnsupportedKeyExchangeError` (`browserSshDependencyAliases`, `apps/web/vite.config.ts`). The client build guard, which the hosted and console builds install, fails a browser bundle holding `diffie-hellman` (`apps/web/hosted/moduleGraphGuard.ts`). It does not name the packages `diffie-hellman` brings, since other dependencies bring them too.
- **`node-rsa`.** `algorithms/node/nodeRsa.js` requires `node-rsa` inside a function, and the package does not declare it. A bundler still resolves it, so it is aliased to a stub as well.
- **The `self` switch.** `algorithms/sshAlgorithms.js` picks its WebCrypto classes when `self` is an object and `crypto.subtle` exists, and otherwise requires its `algorithms/node/` classes. A production build bundles those Node modules but never loads them in a page.
- **The negotiation message.** A failed negotiation rejects `connect()` with a plain `Error` reading `Failed <category> negotiation: Server (<list>) Client (<list>)` (`services/keyExchangeService.js`). `browserSshErrors.ts` reads it into `BrowserSshNoCommonAlgorithmError`. A reworded message reaches the caller as the library's own error, unnamed.
- **`vscode-jsonrpc`.** The library uses only its `Emitter`, `Event`, `Disposable`, `CancellationToken` and `CancellationTokenSource`. The package's main entry reads a `Buffer` global when it loads, and requires `net`, `os` and `crypto`. So the browser configs alias the bare specifier to a module re-exporting the package's own `lib/events` and `lib/cancellation` (`browserSsh/stubs/vscodeJsonrpc.ts`). Whether to replace the package is open ([browser-sftp-proxy.md](../notes/browser-sftp-proxy.md#what-it-adds-to-the-browser-bundle)).
- **A bare `Buffer` global.** Several modules read `Buffer` without importing it, among them `algorithms/web/jsonWebKeyFormatter.js`, `sshChannel.js`, `sshClientSession.js` and `services/authenticationService.js`. The client installs the app's `buffer` on `globalThis` when the page has none (`provideBufferGlobal`). `apps/web` declares `buffer` at the library's major version, 5, and the browser configs set `resolve.dedupe: ["buffer"]`, so a bundle holds one copy.
- **The host-key blob.** The library hands a host key's bytes to `setPublicKeyBytes` as a view of a packet buffer it reuses. The owned Ed25519 key copies them.
- **Abort and the library's pending steps.** Disposing a session does not cancel the library's own pending steps. An abort just after the version line leaves its version read rejected with nothing handling it. An abort once `authenticateClient` has started its un-awaited step can still sign with the client key; the send that would carry the signature throws on the disposed session, so nothing reaches the server, and that rejection also goes unhandled.

### Re-verification on a bump

- Run `npx vitest run --project unit test/unit/psi/browserSsh test/unit/hostedModuleGraphGuard.test.ts` from `apps/web`. It covers:
  - the stubs and the shim;
  - the offered algorithm lists, read off the client's KEXINIT;
  - the named negotiation error against a scripted server;
  - the Ed25519 verifier and the non-extractable key;
  - the bundle without the `diffie-hellman` alias failing the guard;
  - the client bundled with the browser aliases, holding one `buffer`, and loading in a context with `self` and no `process`.
- The guard test also checks that the library is the only package in `package-lock.json` requiring `diffie-hellman`, since the alias hands every importer the stub.
- Run `npx vitest run --project browser test/browser/browserSshClient.test.ts` from `apps/web`, with OpenSSH's `sshd` installed. It drives a session through the relay to a real sshd:
  - the host key exposed before any signature, ed25519 and ECDSA;
  - authentication with a non-extractable P-256 key, and the `sftp` subsystem;
  - the named error against a server offering only finite-field Diffie-Hellman, or only `aes128-ctr`;
  - a test-only finite-field offer reaching the `diffie-hellman` stub in the pre-bundled library.
- Confirm the install stays clean: the package declares no install script, and ships no license file. `scripts/lib/bundleNotices.mjs` refuses a shipped bundle that inlines a package with no license file unless that file's `NO_LICENSE_FILE` lists it, so the first pull request that ships the client adds the entry.

## The shipped images hold no package manager

Both `Dockerfile` and `Dockerfile.fips` delete the base image's npm CLI and
corepack shim in their runtime stage -- `lib/node_modules/npm`,
`lib/node_modules/corepack`, and the `bin/npm`, `bin/npx` and `bin/corepack`
links -- under `/usr/local` on the default image and under `/opt/node` on the
variant, where the runtime comes from the official tarball rather than from a
package, and the default image's runtime stage also takes out the base's
bundled Yarn classic install -- the `bin/yarn` and `bin/yarnpkg` links and the
`/opt/yarn-v*` directory -- which the tarball-installed variant never ships.
The builder stages keep theirs, `npm ci` being what resolves the tree
the runtime stage copies in, so this is a property of the shipped image and not
of the build.

What it is for: the image vulnerability scan reads every language package in
the image, and an npm CLI in one brings a bundled dependency tree that no pin in
this repository moves. Without a package manager that scan has exactly two
remedies, and the package path in the report says which. A system package moves
with the base pin, by the procedure in the two sections below. A package under
`/app` moves with `package-lock.json`. A finding in a tree neither reaches is
one this repository cannot clear at all, which leaves exempting it or switching
the gate off as the only ways past it.

What holds it: `scripts/dockerfile-freeze.test.mjs` freezes each image's removal
command and refuses any other runtime-stage command naming npm or npx, and
`image_smoke.yaml` asserts that none of `npm`, `npx`, `corepack`, `yarn` and
`yarnpkg` resolves in either built image -- the half that catches a base image
putting one back on a path the removal does not name. Nothing in either role
needs one: both entrypoints exec `node` directly, and the console server spawns
the CLI entry the same way (`apps/web/src/jobs/cliDriver.ts`).

## Bumping the FIPS base image

`Dockerfile.fips` pins its Amazon Linux 2023 rootfs by multi-arch index digest,
so the base moves only when someone edits that digest. Four committed values
name one release between them, and a bump that moves fewer than all four builds
an image whose userland and package layer came from different snapshots. What
each of those pins is, and how the current values were resolved, is in
[CONTAINER_IMAGES.md](CONTAINER_IMAGES.md#the-fips-variant-images-pins); what
follows is the procedure that keeps them together.

**The cadence.** This base is bumped through this procedure at two points:

- **At each release.** The release checklist bumps it while the release is
  prepared ([RELEASES.md](../RELEASES.md#4-review-and-audit-dependencies)).
  The images publish only on release tags, so a bump between releases reaches
  no user sooner.
- **When the weekly scan flags a fixable base CVE.** `image_smoke.yaml`'s
  scheduled run scans the built variant (below); a finding in the base with a
  fix available is bumped then rather than at the next release.

**Why Dependabot does not offer it.** The `docker` block at `/` in
`.github/dependabot.yml` ignores this base under its three names:
`amazonlinux`, Docker Hub's name for the image, which no `FROM` here spells;
`public.ecr.aws/amazonlinux/amazonlinux`, the ECR Public name `Dockerfile.fips`
spells; and `amazonlinux/amazonlinux`, the name Dependabot files the bump under
(PRs #2539 and #2608). Dependabot's commit for this base moved the `FROM` digest
alone (PR #2608), so the `nodebase` stage's release assertion, the freeze test
and the attribution check failed until the rest of this procedure landed on its
branch.

The default image's base arrives on the same block with no procedure beyond
its literals ([Bumping the default base image](#bumping-the-default-base-image)).
Why this one takes more is in
[fips-variant-image.md](../notes/fips-variant-image.md#why-a-dependabot-bump-of-the-base-is-not-merged-as-filed).

**Which branch the configuration is read from.** Dependabot resolves
`.github/dependabot.yml` from the repository's default branch (`main`) rather
than from the branch an update targets, so a change to that file takes effect
only once a release promotion moves it to `main`. Observed 2026-08-31, with an
`ignore` entry for this base on `staging` and `main`'s copy of the file with
none: a docker-ecosystem run triggered by hand showed `"ignore-conditions": []`
in its update-job definition and filed a bump of this base's digest against
`staging` (PR #1166). While `main`'s copy carries an `ignore` entry naming the
base, a run's update-job definition lists that name under
`ignore-conditions` and no pull request is filed for it. The same
default-branch evaluation governs Dependabot's security alerts, which
[RELEASES.md](../RELEASES.md#4-review-and-audit-dependencies) records for
triage and whose pull requests against `main` it handles in
[A security update opened against
main](../RELEASES.md#a-security-update-opened-against-main).

**What else shows a base worth moving to**, between releases:

- The Trivy scan the release workflow runs over the built variant,
  which gates every publish, so a snapshot with fixable high or critical
  findings blocks a release rather than shipping. `image_smoke.yaml`'s Trivy
  scan of the variant asks the same question on every trigger, pull requests
  included, and gates on it the same way (below).
- An advisory, or a certificate-lifecycle event, read by hand against the pins
  in [CONTAINER_IMAGES.md](CONTAINER_IMAGES.md#the-fips-variant-images-pins).

**The same-diff quintet.** A base move lands with all five of these or not at
all; the first four are verified against one release:

1. The digest in `Dockerfile.fips`'s `FROM`, resolved as the multi-arch index
   digest -- `docker buildx imagetools inspect public.ecr.aws/amazonlinux/amazonlinux:2023`
   -- because a platform-specific manifest digest names one architecture and
   fails on the other. The digest is ECR Public's: Docker Hub's
   `amazonlinux:2023` publishes the same releases under different digests, so
   the digest is resolved on the registry the `FROM` names. Why the base comes
   from ECR Public is in
   [fips-variant-image.md](../notes/fips-variant-image.md#why-the-base-comes-from-ecr-public).
2. The `FIPS_BASE` literal in `scripts/dockerfile-freeze.test.mjs`.
   `npm run test:scripts` stays red until it matches, so the reconciliation is
   forced rather than remembered.
3. `ARG AL2023_RELEASEVER` in `Dockerfile.fips`, the snapshot every `dnf`
   transaction resolves against. The `nodebase` stage compares it against the
   `system-release` version the rootfs reports and fails the build when the two
   differ, so a digest that moves without it reddens the image build.
4. The certified provider's pins -- `FIPS_PROVIDER_PACKAGE`,
   `FIPS_PROVIDER_VERSION` and `FIPS_MODULE_VERSION` -- confirmed against what
   the new snapshot serves rather than copied over. Moving the releasever moves
   what the package layer resolves: a snapshot no longer serving that NVR fails
   the `dnf swap` itself, and one serving a different module under the same
   package name fails the `rpm -qf` and `openssl list` assertions that follow.
   A snapshot still serving the pinned NVR leaves all three values unchanged --
   a result those assertions establish, not one the diff may assume.
5. The `# base pin:` header line in `NOTICE-os-packages-fips.tsv`, the
   OS-layer attribution list described in
   [CONTAINER_IMAGES.md](CONTAINER_IMAGES.md#the-os-layer-attribution-lists).
   `scripts/generate-os-package-attribution.mjs --check` compares that line
   against the digest `Dockerfile.fips` names, so `image_smoke.yaml`'s drift
   leg fails the pull request until the list is regenerated from an image built
   on the new base; `npm run test:scripts` reddens on the same mismatch without
   a Docker daemon. The regeneration takes new rows, not an edited header line,
   and it states no comparison between architectures unless the run is given
   `--architectures-compared <YYYY-MM-DD>` -- a day both architectures were
   built without a layer cache, queried, and found to agree. The architecture
   split below is why that comparison is hand work rather than something the
   pull request's own run re-takes.

Read the release out of the new rootfs to learn what to write in (3):
`rpm -q --qf '%{VERSION}' system-release` inside it, or `docker create` plus
`docker cp` of `/etc/os-release` to read the other architecture's rootfs without
emulating or executing it.

**The Node runtime moves in the same diff.** Move `ARG NODE_VERSION` in
`Dockerfile.fips` to the current Node 26 release, together
with both per-architecture tarball hashes and the matching literals in
`scripts/dockerfile-freeze.test.mjs` and
[CONTAINER_IMAGES.md](CONTAINER_IMAGES.md#the-fips-variant-images-pins).
Take each hash from that release's `SHASUMS256.txt` and confirm it by running
`sha256sum` over the downloaded tarball. No Dependabot entry tracks the tarball,
so a Node security release between base bumps is caught only by a dependency
survey.

**Security review or the mechanical checks.** Diff the regenerated
`NOTICE-os-packages-fips.tsv` (5 above) against the list it replaces. A move
whose diff adds, drops or changes the version of any of these gets a security
review under [CONTRIBUTING.md](../../CONTRIBUTING.md#dependency-policy) before
it merges:

- OpenSSL: `openssl` and `openssl-libs`.
- The FIPS provider: `openssl-fips-provider-certified` and
  `openssl-fips-provider-certified-so`, or whichever package (4) above names.
- The other packages the closure carries for cryptography or trust:
  `crypto-policies`, `gnutls`, `libgcrypt`, `libgpg-error`, `nettle`,
  `libxcrypt`, `libtasn1`, `krb5-libs`, `keyutils-libs`, `cyrus-sasl-lib`,
  `cryptsetup-libs`, `gpgme`, `python3-gpg`, `gpg-pubkey`, `p11-kit`,
  `p11-kit-trust` and `ca-certificates`, and any other package of that kind,
  whether a new snapshot adds it or the list already carries it.

Any other move is reviewed by the mechanical checks: the build's assertions,
the freeze test, the attribution check, and the `image_smoke.yaml` legs and
Trivy gate below. The reviewer reads the trigger off the list diff; no check
computes it.

**Re-check the open Dependabot alerts that have no fix.** On each base move,
read the repository's open Dependabot alerts in the Security tab, which are
evaluated against `main`
([RELEASES.md](../RELEASES.md#4-review-and-audit-dependencies)). For each alert
with no patched version, check whether a fixed release has since been
published. One that has is taken as its own bump, not folded into the base
move. One that still has none stays open rather than dismissed, so the next
base move reads it again.

**The re-measurement obligation.** The variant's published FIPS claims rest on
measurements of one base rootfs and one provider build. Those taken by hand are
archived outside this repository, and the notes that state them
([fips-variant-image.md](../notes/fips-variant-image.md),
[fips-provider-surface.md](../notes/fips-provider-surface.md)) cite those
archives rather than any path in this tree -- so nothing here re-derives them
and no check reddens when a base move leaves one stale. The engagement legs are
the automatic half, re-taken by the pull request's own run (below); these are
the hand work a move obliges beyond it:

- **The OS package closure figures** -- package count, image size, and the
  GPL-3.0/LGPL-3.0 breadth recorded in
  [CONTAINER_IMAGES.md](CONTAINER_IMAGES.md#the-fips-reference-builds-inventory).
  These are properties of the snapshot rather than of the module, and a package
  gained or dropped moves them. The setuid/setgid half of the closure is the one
  part a check already re-takes.
- **The certificate comparison behind the provider choice**, whenever (4) above
  lands on a different provider NVR: the choice between the certificates
  available under that package name rests on a side-by-side vulnerability scan
  of two images, which is a measurement of the package layers being compared.
- **The architecture split.** The hand measurements were taken on `aarch64` and
  CI builds `amd64`, so a move inherits that split rather than closing it; a
  figure re-taken on one architecture is labelled with it.

**What re-proves the result.** `image_smoke.yaml` builds `Dockerfile.fips` on
every pull request touching it, which is where all of those build-time assertions
run. It follows the build with the variant's entrypoint report, the engagement
probe, an end-to-end two-party exchange between two containers of the built
image, and the setuid/setgid inventory recorded in
[CONTAINER_IMAGES.md](CONTAINER_IMAGES.md#the-fips-variants-setuid-and-setgid-files).
A new base whose package closure gains or loses one of those bits reddens that
step, and the inventory is re-recorded in the same diff.

That workflow's Trivy scan gates on the variant leg on every trigger, the
pull-request path included, so a bump taken in order to clear a scan finding is
confirmed by the pull request's own run rather than by a dispatch beside it.
That posture holds only while the pinned base and snapshot name a rootfs whose
closure scans clean, and a check red on every product PR for weeks teaches
reviewers to ignore it. A base carrying a fixable finding no published rootfs
can reach -- the fix served by a newer package snapshot than any rootfs the
registry has been rebuilt onto, which the build's release assertion refuses to
mix -- is answered by an entry in `.github/trivyignore.yaml` scoped by `purls`
to the packages assessed, stating why the finding is accepted (the vulnerable
path must be one no Alcove role reaches), naming the base bump that clears
it, and carrying an `expired_at` that forces the re-read. The release
workflow's gate reads that same file, so the entry is a publish decision as
much as a merge one; that is why it is scoped and dated and never an id-only
entry, which would also suppress the finding on the other image. Taking the
leg back off the pull-request path is not the alternative: it hides the scan
from the runs that would show the finding cleared. The entry comes out in the
same diff as the bump. Either way the findings arrive as
code-scanning alerts under `container-image-fips`, and scanning the built
variant by hand (OS and language packages, `vuln` scanner, high and above,
fixable only, against `.github/trivyignore.yaml`) answers the same question
off CI.

One limit sits between a green run there and a bump being proved:

- **The build is single-arch.** That workflow builds native `amd64` with no
  QEMU, so on a pull request the release assertion speaks for the `amd64`
  rootfs at the new digest and not for the `arm64` one. The release workflow's
  `workflow_dispatch` dry run builds both Dockerfiles for `amd64` and `arm64`
  without publishing, so dispatching it on the bump's branch runs the
  release assertion and the build's other assertions on `arm64` before a tag.
  The dry run is started by hand, so reading the other
  architecture's release by hand, as above, stays the fallback; without
  either, the assertion runs for `arm64` first in the tag's multi-arch push.

## Bumping the default base image

This is the second Dockerfile base-image pin with its own bump section
outside the machine-read `Upgrading ...` heading form, per the
convention [recorded in this document's lead](#pinned-dependency-internals) alongside
[the FIPS base image's section](#bumping-the-fips-base-image). A heading in
that form is read only as a parenthesised list of npm package names, so
`npm run check:dependabot-pin-coverage` has no way to hold either docker pin's
bump procedure to a Dependabot config entry. It is ecosystem-blind by
construction, not merely unextended to this pin yet. Extending it to a heading
form tagged by ecosystem is a separate call from this section, which exists to
make the procedure below readable rather than to close that gap.

`Dockerfile` pins `node:26-alpine`'s multi-arch index digest, in both stages,
so the base moves only when someone edits that digest -- what the freeze
covers and why the base is pinned by digest rather than by tag is in
[The Docker image's dependency freeze](CONTAINER_IMAGES.md#the-docker-images-dependency-freeze).

**The arrival signal.** Dependabot's docker ecosystem
(`.github/dependabot.yml`, weekly on Monday, targeting `staging`) tracks the
digest in the `FROM` and opens a pull request of its own when the
`node:26-alpine` tag is rebuilt onto a newer image. That block declares no
groups, so the bump is never batched. The same block files
[the FIPS variant's](#bumping-the-fips-base-image) base, which is taken through
its own procedure. The block's weekly cadence is the accepted
latency here -- nothing polls the registry more often, and a rebuild is what
this waits for rather than something this repository can provoke.
Dependabot's own commit edits only the `Dockerfile` `FROM` lines; nothing
updates the mirrored literal below, so the pull request arrives with
`npm run test:scripts` red by construction -- the freeze test's whole point,
not a defect in the pull request.

**The same-diff trio.** A digest bump lands with all three of these or not at
all:

1. The digest in both of `Dockerfile`'s `FROM node:26-alpine@sha256:...`
   lines. This is what the Dependabot pull request edits, and the only one of
   the three it moves on its own.
2. The `DEFAULT_BASE` literal in `scripts/dockerfile-freeze.test.mjs`.
   `npm run test:scripts` stays red until it matches, so push the
   reconciling edit onto the same pull request as a second commit on the
   Dependabot branch -- how the one prior default-base bump landed (the
   node:26-alpine bump merged as PR #865) -- rather than merging a red
   check. How Dependabot's own next push treats a manually edited branch
   has not been driven here; if the branch is recreated, re-push the
   reconciling commit with it.
3. The `# base pin:` header line in `NOTICE-os-packages-default.tsv`, the
   OS-layer attribution list described in
   [CONTAINER_IMAGES.md](CONTAINER_IMAGES.md#the-os-layer-attribution-lists).
   `scripts/generate-os-package-attribution.mjs --check` compares that line
   against the digest `Dockerfile` names, so `image_smoke.yaml`'s drift leg
   fails the pull request until the list is regenerated from an image built on
   the new base; `npm run test:scripts` reddens on the same mismatch without a
   Docker daemon. The regeneration takes new rows, not an edited header line:
   a new base is a new package layer. It states no comparison between
   architectures unless the run is given `--architectures-compared
   <YYYY-MM-DD>`, which names a day both architectures were built without a
   layer cache, queried, and found to agree -- a comparison the new base
   requires again, and one the generator states for no other run.

**What re-proves the result.** `image_smoke.yaml`'s pull-request path filter
lists `Dockerfile`, so the pull request runs the full matrix: both the
default and the FIPS legs rebuild, even though only the default base moved.
The default leg's Trivy scan (`vuln`, OS and language packages,
high/CRITICAL, fixable findings only, against `.github/trivyignore.yaml`) runs
on this pull request as it does on every other -- a new snapshot
with a fixable finding fails the pull request rather than shipping. The same
job also drives the assertions the freeze test cannot
reach, because they read a running container rather than the Dockerfile text.
Those are the account the image runs as and its writable set and symlink
containment, the headless CLI invocation, a real file-drop exchange between
two containers of the built image, and
`scripts/assert-image-capabilities.mjs`'s walk of what the shipped setup
scripts ask of the image. The FIPS section's
single-arch limit applies here: the smoke build is amd64-only with
no QEMU across the whole job matrix, and the release path's Trivy scan reads
an amd64-only build before the separate multi-arch push. The release
workflow's `workflow_dispatch` dry run builds both Dockerfiles for `amd64`
and `arm64`, running the build-time assertions on the arm64 image a bumped
digest also includes before a tag. It is started by hand and runs no scan, so
no automatic run reaches that image before the tag's push, and no scan
reaches it at all.

**A package the mirror fixed, without a digest bump.** The runtime stage's
`apk add --no-cache samba-client` floats against the Alpine mirror (why, and
what that costs: [CONTAINER_IMAGES.md](CONTAINER_IMAGES.md#the-docker-images-dependency-freeze)),
but a build replays that layer from `image_smoke.yaml`'s layer cache for as long
as nothing above it changes. The cache scope carries the ISO week, so the
scheduled Monday run on the default branch rebuilds the layer from the mirror
and a fix the mirror already carries reaches the scanned image within a week
with nothing in this repository changed. A scan that goes red on a package
whose fixed version the mirror already holds is reading a layer cached earlier
that week, not a reason to bump the digest. A re-run does not clear it, since it
reads the same week's scope; wait for the next Monday run, or delete that
week's cache entries (`gh cache list`, `gh cache delete`) to have the next run
build from the mirror.

The release workflow differs by job:

- The publish job builds with no GitHub Actions layer cache, so a tag's
  images, and a re-run of that tag's publish job, take `samba-client` from
  the mirror at build time.
- The `workflow_dispatch` dry run reads and writes one, under the scopes
  `dry-run` and `dry-run-fips`, neither of which names a week. A dry run can
  therefore replay a `samba-client` layer an earlier dry run cached, for as
  long as nothing above it changes. It publishes nothing and scans nothing; deleting
  those scopes' entries (`gh cache list`, `gh cache delete`) has the next dry
  run build that layer from the mirror.
- Which refs' cache entries a dry run dispatched on one branch restores is
  unmeasured: no Actions run here has been driven across branches or tags to
  show it.

**What beyond the digest deserves a look.** `node:26-alpine` is a floating tag
underneath its digest, so a rebuild the tag picked up can have a different
Node minor or patch release, and a different bundled npm, than the digest it
replaces -- and nothing in `image_smoke.yaml` prints or asserts either
version. Read them before merging, the same way the smoke job reads a
container's shell:
`docker run --rm --entrypoint sh node:26-alpine@sha256:<new-digest> -c 'node --version && npm --version'`.
The npm version is the one to read closely. [The npm floor](NPM_INSTALL_POLICY.md#the-install-script-policy-allowscripts)
the `allowScripts` install-script policy needs is a property of exactly this
digest, which is why that section states a measured bundled-npm value for the
digest pinned at the time it was written rather than deriving it from
anything checked automatically. Nothing re-measures it when the digest
moves, so a bump that changes it leaves that section's stated value stale
until someone updates it in the same diff. A digest that moves the bundled
npm below 11.16.0 would leave the policy silently off, and below 11.17.0
falls under the floor that section states as the builder's intent; either is
worth a line in the pull request, and updating the stated value either way
keeps that section accurate, even though nothing here turns red over either.
