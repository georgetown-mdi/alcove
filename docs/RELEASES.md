---
title: "Release Process"
---

# Release Process

This document describes how Alcove releases are prepared, tagged, and published.

## Versioning

Alcove uses [semantic versioning](https://semver.org/) (MAJOR.MINOR.PATCH):

- **PATCH**: backwards-compatible bug fixes, documentation updates, dependency patches.
- **MINOR**: backwards-compatible new features or new configuration fields. Exchange specification files written for an earlier MINOR version of the same MAJOR must continue to work.
- **MAJOR**: breaking changes to the exchange protocol, configuration schema, or CLI interface. A MAJOR bump means existing key files or exchange specs may need to be updated.

Alcove has one product version, held in `apps/cli/package.json`, the canonical release version:

- **The images:** the Docker image tags and the GitHub Release tag name it, the CLI reports it, and the console baked into each image (`apps/web`, run via `serve`) shows it.
- **The hosted web application:** its production deployment is built from the release tag and shows that tag's version in the page footer. Any hosted build not made from a release tag, such as a `staging` preview, shows the short commit hash it was built from instead.
- **Everything else:** the workspace packages under `packages/` are internal. Each is private, none is published, and none has a release version of its own. The root and `apps/web` `package.json` versions are workspace markers and are not independently meaningful.

Compatibility between the CLI and its core dependency is recorded by the lockfile and embedded in the Docker image; no separate compatibility matrix is maintained.

Nothing has been published yet: the canonical release version is still the pre-publication `0.1.0`, and every in-repo version literal holds at its pre-publication footing -- the footing itself, and what ends it, is specified in `docs/spec/PROTOCOL.md` (Wire-format deltas) and enforced by the release checks below.

## Release Artifacts

Each release produces:

| Artifact       | Published to                   | Tag / name                                                               |
| -------------- | ------------------------------ | ------------------------------------------------------------------------ |
| Docker image   | GitHub Container Registry (`ghcr.io/georgetown-mdi/alcove`) and Docker Hub (`docker.io/gumdi/alcove`) | `ghcr.io/georgetown-mdi/alcove:X.Y.Z`, `ghcr.io/georgetown-mdi/alcove:X.Y`, `ghcr.io/georgetown-mdi/alcove:latest`, and the same three tags at `docker.io/gumdi/alcove` |
| FIPS variant image | GitHub Container Registry (`ghcr.io/georgetown-mdi/alcove`) and Docker Hub (`docker.io/gumdi/alcove`) | `ghcr.io/georgetown-mdi/alcove:X.Y.Z-fips`, `ghcr.io/georgetown-mdi/alcove:X.Y-fips`, `ghcr.io/georgetown-mdi/alcove:latest-fips`, and the same three tags at `docker.io/gumdi/alcove` |
| GitHub Release | GitHub Releases                | Tag `vX.Y.Z`                                                             |
| Launchers      | GitHub Release assets          | `start-alcove.sh`, `Start-Alcove.ps1`, `Setup-AlcoveFileDrop.ps1`     |
| Build provenance | GitHub attestation store     | Subject `ghcr.io/georgetown-mdi/alcove`, one attestation per released manifest digest |
| Hosted web application | Cloudflare Pages, with the demo site | The production deployment of tag `vX.Y.Z`, its footer showing `Version X.Y.Z` |

Each image is the same manifest on both registries, under one digest: the release copies the manifest ghcr.io received to Docker Hub rather than building it again. ghcr.io is the registry the launchers, the Windows file-drop setup scripts, and the web app's accept kit name; the Docker Hub copy is for a network that refuses ghcr.io's download host.

Each image contains both the CLI and the console; which role it runs is decided by its first argument (see [DEPLOYMENT.md](DEPLOYMENT.md#docker-deployment)). Both images run unprivileged ([The user the image runs as](DEPLOYMENT.md#the-user-the-image-runs-as)), take the same arguments, and speak the same protocol, so a partner on one can exchange with a partner on the other.

The hosted web deployment (`apps/web`) is not this image. The release workflow deploys it from the same tag, after both images are published ([step 8](#8-build-and-publish-the-container-image-ci)).

## Which image has which posture

The two tags differ in what serves the cryptography underneath `crypto.subtle`.

- **`ghcr.io/georgetown-mdi/alcove:X.Y.Z`** -- the default artifact, built on `node:26-alpine`. It embeds no validated cryptographic module and the project claims none for it. It is smaller, its SFTP support is unrestricted, and it is the image the launchers and the Windows file-drop setup scripts pull. Use it unless a FIPS obligation applies.
- **`ghcr.io/georgetown-mdi/alcove:X.Y.Z-fips`** -- built on Amazon Linux 2023 and containing the CMVP-validated OpenSSL FIPS provider AWS publishes for that distribution, so Alcove's `crypto.subtle` calls dispatch into that module. It is roughly 1.8x the size, and by default it cannot reach an SFTP server that offers only `curve25519` key exchange, only the `chacha20-poly1305@openssh.com` cipher, or only an Ed25519 host key.

What the FIPS variant does and does not support a claim of is stated in [COMPLIANCE.md](COMPLIANCE.md#fips-140). Two image facts bound it:

- The image does not put the host in FIPS mode and cannot. Supplying a host in FIPS mode is the operator's responsibility.
- The PSI masking itself runs in BoringSSL, inside a vendored WebAssembly module or the native addon the CLI loads where a prebuild ships for the platform, neither of which an OpenSSL provider reaches.

At every container start the variant reports on stderr whether its own crypto is being served by that module and what the host kernel's FIPS mode is, and warns rather than refusing when either answer is not what a claim needs.

**Pulling and verifying it.** The variant is signed by the same release workflow, under the same Sigstore identity, and is verified the same way as the default image, by the `-fips` reference: see [Verifying a Release](#verifying-a-release).

**Confirming the module inside it.** A signature says which build this is, not what is running in it. Run the image and read its first two stderr lines:

```sh
docker run --rm ghcr.io/georgetown-mdi/alcove:X.Y.Z-fips --help
```

A run whose crypto is being served by the module reports `FIPS provider active`, naming the baked-in module version when `FIPS_MODULE_VERSION` is intact in the container's environment, and saying that it cannot name one when that variable was cleared or overridden at start. Anything else is a warning naming what the startup probe found instead. The host kernel's FIPS-mode line is separate and is reported the same way. The probe is a Node process making Alcove's own call shapes under the image's configuration, and its exit status is the whole verdict; neither line is parsed from `openssl list`.

The measured list of what does not work in the variant is in [fips-variant-image.md](notes/fips-variant-image.md); its pins and the checks that hold them are in [CONTAINER_IMAGES.md](spec/CONTAINER_IMAGES.md).

The three launcher files open the console from the host: `start-alcove.sh` for macOS and Linux, `Start-Alcove.ps1` for Windows, and `Setup-AlcoveFileDrop.ps1`, which the Windows one dot-sources for its path resolution, credential prompts, and network-share volume, and which must sit beside it. See [Stamped launchers](#stamped-launchers) for what a release does to them.

No package is published to the npm registry: `@alcove/core` and the other workspace packages are private.

## The broker core build

The `broker-core-build` prerelease on the repository's Releases page is not a release of Alcove, and nothing above or in the [Release Checklist](#release-checklist) touches it.

- **What it holds.** The part of `@alcove/core` the broker's host runs -- the standalone signaling broker's entry, `untrusted-text.esm.js`, and the WebSocket relay's, `websocket-relay.esm.js`, with the chunks either imports and a `SHA256SUMS` manifest listing every one of those files -- built from the latest commit on `main`, as `alcove-broker-core-<commit>.tar.gz` beside its Sigstore bundle, `alcove-broker-core-<commit>.tar.gz.sigstore.json`.
- **Who writes it.** `.github/workflows/broker_core_build.yaml`, on every push to `main`: it signs the archive keylessly under its own identity at `refs/heads/main`, uploads the new commit's assets and then deletes the earlier commit's. Its tag marks the commit of the first publish and is not moved; the asset names state the commit built.
- **How it differs from a release.** It is never marked latest, and its tag does not have the `vX.Y.Z` form that starts the release workflow. The broker's host cannot build core and installs this build instead; how that host verifies and unpacks it is in [infra/broker/README.md, Install](../infra/broker/README.md#install).

## Stamped launchers

A launcher names the image by digest rather than by a floating tag, so a release copy runs exactly the manifest this release signed. The repository copy of each launcher holds a placeholder line, and the release workflow fills it in.

**What gets stamped.** One line per launcher, replaced whole:

| File | Line the release rewrites |
| ---- | ------------------------- |
| `start-alcove.sh` | `ALCOVE_IMAGE_DIGEST='@@ALCOVE_IMAGE_DIGEST@@'` |
| `Start-Alcove.ps1` | `$AlcoveImageDigest = '@@ALCOVE_IMAGE_DIGEST@@'` |

The value substituted is `steps.build.outputs.digest` from the image build -- the manifest-list digest, the same value [step 8](#8-build-and-publish-the-container-image-ci) signs with Cosign. Each launcher also names the repository in full, `ghcr.io/georgetown-mdi/alcove`, because podman requires the registry prefix and docker accepts it.

**What keeps the launcher and the workflow in step.** The workflow refuses the release if the publish job's digest output is empty or is not `sha256:` followed by 64 lowercase hex characters, if a launcher does not contain its placeholder line exactly once, or if a placeholder survives the substitution. `npm run test:scripts` pins the same two lines in both the launchers and the workflow. A copy that reaches an operator unstamped refuses to run and says where a release copy comes from.

**What a release publishes.** The `launchers` job attaches the two stamped files plus `Setup-AlcoveFileDrop.ps1` -- unstamped, and the one `Start-Alcove.ps1` dot-sources -- as assets on the release for this tag, creating it as a draft if the tag has none yet. That job is the only one in the workflow holding `contents: write`.

**How an organisation verifies a copy.** Read the digest out of the launcher and verify the signature over that exact reference:

```sh
grep ALCOVE_IMAGE_DIGEST start-alcove.sh
cosign verify \
  --certificate-identity-regexp '^https://github\.com/georgetown-mdi/alcove/\.github/workflows/release\.yaml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/georgetown-mdi/alcove@sha256:...
```

A digest that verifies is the image the official release workflow published. Both `--certificate-` arguments are required; [Verifying a Release](#verifying-a-release) explains what they pin. Verify by digest when the reference comes from a launcher, as here; verify by tag when it comes from the release notes.

## Image vulnerability scan

Every release image is scanned for vulnerable packages before it is published. The release workflow builds each image single-arch, scans it, and only then authenticates to the registry and pushes, so an image the workflow published is an image that passed the scan. Both scans run ahead of the login, so a finding against either image stops the whole release. The hand-built push in [step 8](#8-build-and-publish-the-container-image-ci) is the one path around that.

**What the gate is.** Trivy, over the image's OS packages and the language packages inside it, failing the release on a vulnerability that is HIGH or CRITICAL _and_ has a fix available. An unfixable finding does not block a release. Those language packages are the production npm tree the build installs and nothing else: both runtime images take the base image's npm CLI and corepack shim out, and the default image's bundled Yarn classic install with them, so a shipped Alcove image holds no package manager (see [DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md#the-shipped-images-hold-no-package-manager)). Dependabot, the [dependency review workflow](../.github/workflows/dependency_review.yaml), and [step 4](#4-review-and-audit-dependencies) below read the dependencies this repository declares; this gate reads the image as built. The Node binary itself is not a component Trivy catalogs, so a CVE in the Node runtime is outside this gate and moves only when the pinned base image's Node version does.

**Where the threshold lives.** On the scan step itself, as literal inputs: `.github/workflows/release.yaml` for this gate and `.github/workflows/image_smoke.yaml` for the pre-merge one. Accepted exceptions are in `.github/trivyignore.yaml`, each vulnerability id with the reason it was accepted and an `expired_at` date. Trivy stops applying an entry on that date and the finding returns to the gate.

**What a finding means.** The report names the package and where it sits. A system package calls for a bump of the base pin, which is a digest (see [DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md)) and so is not something a dependency update resolves: edit the digest in `Dockerfile` or `Dockerfile.fips` -- on the variant, its Amazon Linux release snapshot moves with the digest -- let the pre-merge scan confirm the new base on that pull request, then tag. A package under `/app` is in this repository's own production tree, and the lockfile is what moves it.

**When it runs.** On every pull request that can change either image, on a weekly schedule against a refreshed vulnerability database, and again in the release workflow ahead of the push. The pull-request run reads both images, each leg failing the run on a finding of its own ([DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md#bumping-the-fips-base-image) records what would take the variant's leg off that path). The weekly schedule reads three subjects: both images built from the default branch, and the published `ghcr.io/georgetown-mdi/alcove:latest` tag. A weekly finding the default branch has already fixed but no release has shipped is remedied by cutting a release. Pull-request and branch-build findings appear as code-scanning alerts in the repository Security tab, one category per image; the published-tag scan and the release gate report on the run's summary page.

**What it does not cover.** It reads the amd64 build, while a release publishes amd64 and arm64 for both images. Each comes from the same digest-pinned base and the same committed lockfile, but a vulnerability in an architecture-specific binary alone is outside the scan.

## A security update opened against main

Every ecosystem block in `.github/dependabot.yml` sets `target-branch: staging`, and `main`'s copy of that file says the same, yet a Dependabot _security_ update can still open a pull request against `main`. This has been observed once, for the js-yaml advisory; treat it as observed behavior rather than a settled rule, and expect a repeat. Merging such a pull request puts a commit on `main` that `staging` does not have, so the next release promotion is no longer a fast-forward from `staging`.

**The default: close it, and let the promotion carry the fix.**

1. Read `staging` for the package the alert names -- `package-lock.json`, or the `FROM` line for a base image pin. `staging` routinely holds the fix already, because the alert is evaluated against `main` (see [step 4](#4-review-and-audit-dependencies)).
2. If `staging` has it, close the `main` pull request unmerged. The next promotion moves the fix to `main` and clears the alert.
3. If `staging` does not have it, take the bump on `staging` first -- a branch of your own off `staging` with the same lockfile change, reviewed and merged the ordinary way -- and then close the `main` pull request. Do not retarget the Dependabot branch at `staging`: what Dependabot does with a retargeted branch on its next push is untested.

**When to merge it to `main` instead.** Only when the fix has to sit on `main` ahead of the next promotion, because something built or assessed from the default branch needs it now. Then merge it and reconverge the branches immediately: run [step 11](#11-merge-back-to-staging)'s merge-back outside a release, so `staging` contains `main`'s tip again and the next promotion is a fast-forward.

## Release Checklist

Work through these steps for every release. Steps marked with `[CI]` are automated; the remainder require a maintainer.

### 1. Prepare the release branch

```sh
git checkout staging
git pull
git checkout -b release/vX.Y.Z
```

### 2. Update versions

Set the release version, following the policy in [Versioning](#versioning):

- `apps/cli/package.json` -- to `X.Y.Z`; it is the product version, which the images, the console, and the hosted web application all report.
- Every other `package.json` -- leave unchanged. The root and `apps/web` manifests are workspace markers, and the private packages under `packages/` have no release version.

The canonical release version is also what arms the wire-format pin. `npm run check:protocol-version-bump` is inert while it names `0.1.0` or below; the first release above that publishes deployed peers, so the check asks for the pin covering what the linkage rounds put on the wire and prints the block to record in `scripts/protocol-version-pins.json`. From that release onward, a change to that wire format takes a `PROTOCOL_VERSION` bump with its own pin recorded beside the earlier ones -- see [PROTOCOL.md](spec/PROTOCOL.md#wire-format-deltas-existing-frames-only-and-no-version-bump).

#### Reset the exchange-record format at first publication

Four internal literals are development counters, cycled freely because no published artifact contains any of their values: `EXCHANGE_RECORD_VERSION` (`packages/core/src/records/exchangeRecord.ts`), `SIGNED_RECEIPT_VERSION` and `RECEIPT_CONTENT_DOMAIN` (`packages/core/src/records/signedReceipt.ts`), and `SIGNING_CERTIFICATE_VERSION` and `SIGNING_IDENTITY_VERSION` (`packages/core/src/records/signingIdentity.ts`). The first release above `0.1.0` ships every one of them reset to its own `v1` form -- `alcove-exchange-record/v1`, `alcove-signed-receipt/v1`, `alcove-signed-receipt-content/v1`, `alcove-signing-cert/v1`, and `alcove-signing-identity/v1` -- and `npm run check:exchange-record-version`, armed by the same marker, fails from that release until `EXCHANGE_RECORD_VERSION`'s own reset is taken; the other three literals carry no armed check of their own, so this checklist is what holds them to the reset. Take all four as one piece:

1. Set each literal to its `v1` form: `EXCHANGE_RECORD_VERSION` in `packages/core/src/records/exchangeRecord.ts`; `SIGNED_RECEIPT_VERSION` and `RECEIPT_CONTENT_DOMAIN` in `packages/core/src/records/signedReceipt.ts`; `SIGNING_CERTIFICATE_VERSION` and `SIGNING_IDENTITY_VERSION` in `packages/core/src/records/signingIdentity.ts`.
2. Regenerate every vectors file the moved literals pin, each through its own generator under `packages/core/test/vectors/`: `generate-exchange-record-vectors.mjs` for the exchange record; `generate-signed-receipt-vectors.mjs`, whose own `RECORD_VERSION`, `CONTENT_DOMAIN`, and `CERTIFICATE_VERSION` constants restate the receipt and certificate literals by design rather than importing them, and so must move with them by hand; `generate-signing-cert-vectors.mjs`, whose `CERTIFICATE_VERSION` and `IDENTITY_VERSION` constants restate the same certificate and identity literals; and `generate-terms-envelope-vectors.mjs`, which captures a real exchange off the built certificate rather than restating it, so it carries the moved literals with no constant of its own to edit. `npm run check:vectors` holds every vectors file to its generator, so a generator constant left behind fails there.
3. Discharge the recovery obligations `scripts/check-exchange-record-version.mjs` names for `EXCHANGE_RECORD_VERSION` -- they fail on their own once that literal moves -- and re-record its `RECORD_VERSION_PIN`. The other three literals name no equivalent obligation.
4. Move the two version-discriminant unit tests that use the reset's own target value as the stale format they check is refused, so the reset does not quietly turn them into no-ops: `packages/core/test/records/exchangeRecord.test.ts`'s "parseExchangeRecord refuses a record written before the run binder" relabels an otherwise-current record `alcove-exchange-record/v1` and asserts the refusal a `v1`-labeled current record no longer gives; `packages/core/test/records/signingIdentity.test.ts`'s "a current-format body holding the previous version is still rejected" does the same with `alcove-signing-cert/v1`. Move each fixture to a version string the reset does not also claim.
5. Clear the development artifacts below, then record the reset: set `RESET_TAKEN_AT_RELEASE` to `X.Y.Z` in `scripts/check-exchange-record-version.mjs`. That retires the rule, so an ordinary forward bump after this release is not held to `v1`.

**Clearing `EXCHANGE_RECORD_VERSION`'s development artifacts.** This literal's reset moves it downward, and a leftover artifact the counter numbered on its way up is misread rather than refused. Two classes can hold one, and no released artifact is among them: `packages/core/src/records/exchangeRecord.ts` does not exist at `v0.1.0`, so nothing published contains an `alcove-exchange-record/vN` literal at all.

- **Browser-stored managed accountings** -- the `disclosures` store of the `alcove-managed-exchanges` IndexedDB database, on any browser that ran a development build of the web app. An entry naming a higher ordinal than the build is treated as a stale page, whose remedy is a reload that cannot help and which withholds the export-then-reset recovery by design (see [MANAGED_EXCHANGE_RECORD.md](spec/MANAGED_EXCHANGE_RECORD.md#what-an-exchange-record-version-bump-does-to-a-stored-accounting)). Clear the site data for the app's origin on those devices.
- **CLI record files on disk** -- `alcove-record-<timestamp>.json` and the `.keys.json` beside it, wherever a development build wrote one. One numbered above the reset value is refused on the version with the file still in the operator's hands; one written back when the counter itself read `v1` is not, and parses as current before failing on its field set. Delete or archive pre-release record files.

### 3. Update CHANGELOG.md

Rename the `[Unreleased]` section to `[X.Y.Z] - YYYY-MM-DD`. Open a new empty `[Unreleased]` section above it. Security fixes must be called out in a `### Security` subsection. The `[Unreleased]` entries should already be reader-facing one-liners (see [CONTRIBUTING.md](../CONTRIBUTING.md), Changelog); tighten or drop any that drifted before cutting the release.

### 4. Review and audit dependencies

```sh
npm audit --omit=dev -w packages/core -w apps/cli -w apps/web
```

Resolve any high-severity findings before proceeding. For any dependency added since the last release, verify license compatibility (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

This covers the npm tree this repository declares. The image as built -- its OS packages, and that same tree as installed inside it -- is gated separately, in CI, by the [image vulnerability scan](#image-vulnerability-scan). The unscoped `npm audit` also reports development-tree findings, which are triaged separately rather than at release time ([DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md#npm-resolution-residuals)).

A Dependabot alert in the repository's Security tab is evaluated against `main`, which lags `staging`, so an alert can still be open against `main` after `staging` already has the fix. Check `staging`'s lockfile before triaging a default-branch alert; a package `staging` has not yet patched still gets a full triage. When the same evaluation opens a security update as a pull request against `main`, handle it by [A security update opened against main](#a-security-update-opened-against-main) rather than merging it there.

The same default-branch evaluation decides which `.github/dependabot.yml` Dependabot reads, so an `ignore` entry merged to `staging` suppresses no pull request until a promotion brings it to `main` ([DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md#bumping-the-fips-base-image)).

### 5. Run the full test suite

Run what CI gates, rather than a copy of it that drifts: `.github/workflows/static_checks.yaml` is the source of truth for the static checks (typecheck, format, lint, the link and claim checks, and the script suite), `.github/workflows/web_build_and_test.yaml` for the browser integration suite, and `.github/workflows/cli_build_and_test.yaml` -- the CLI's pull-request gate -- for the CLI's unit and SFTP integration suites, whose integration half also runs in `release.yaml` as the ship gate before publish. Everything they run must pass on the release branch before it merges.

### 6. Open and merge the release PR

Open a pull request from `release/vX.Y.Z` to `main`. The PR title should be `Release vX.Y.Z`. Include a summary of changes (copy from CHANGELOG). Require at least one review before merging.

### 7. Tag the release

After the PR merges to `main`:

```sh
git checkout main
git pull
git tag -s vX.Y.Z -m "Alcove vX.Y.Z"
git push origin vX.Y.Z
```

### 8. Build and publish the container image `[CI]`

The `vX.Y.Z` tag push in step 7 triggers `.github/workflows/release.yaml`, which builds both multi-platform images and pushes them to the GitHub Container Registry, signs each with Cosign, attests each one's build provenance (see [Build provenance](#build-provenance)), and then stamps and attaches the launchers (see [Stamped launchers](#stamped-launchers)) and copies both images to Docker Hub (see [The Docker Hub copy](#the-docker-hub-copy) below). The FIPS variant's three tags are the default image's three with `-fips` appended, derived from the pushed tag in the workflow itself. The ghcr.io push authenticates with the workflow's own `GITHUB_TOKEN` under `packages: write`, so no ghcr.io secret is configured; the package's settings on ghcr.io must grant this repository the Write role under "Manage Actions access", which the maintainer sets once. The Dockerfile's `org.opencontainers.image.source` label does not grant that access: for an organization package it is metadata only.

The default image's base and the builder and QEMU images come from Docker Hub, which limits anonymous pulls per source IP. The release jobs, like every CI job that pulls from the Hub, log in first with a read-only Docker Hub access token held in the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets (in both the Actions and the Dependabot secret stores). Without the secrets the jobs pull anonymously and can fail with `429 Too Many Requests`. The token has an expiry: once it lapses, the "Log in to Docker Hub" step fails in every job that has it, a release included, until a new token replaces the `DOCKERHUB_TOKEN` value in both stores.

**What has to pass before anything is pushed.** Each gate below runs before the workflow authenticates to the registry it publishes to, so a release that fails one publishes nothing at all:

- **The version check**, comparing the pushed tag against the version step 2 set in `apps/cli/package.json` and failing the release when the two disagree: the image build bakes that version into the console's partner accept kit.
- **The vulnerability scans.** Each image is built single-arch, loaded, and scanned; neither is pushed if either scan fails (see [Image vulnerability scan](#image-vulnerability-scan)).
- **The FIPS engagement probe.** The loaded variant candidate runs the engagement probe it ships -- the same one its entrypoint runs at every container start, described under [Which image has which posture](#which-image-has-which-posture) -- against the candidate this release publishes. It reads the amd64 candidate; both published architectures resolve the same base pin, the same certified provider package, and the same committed lockfile.

The publish sequence signs each image immediately after its own push, verifies that signature with the same command and the same two `--certificate-` arguments this document publishes under [Verifying a Release](#verifying-a-release), and attests its build provenance, all before the next image is built. A signature the published command cannot verify stops the release there. A failure between the two pushes leaves the default tags moved while the `-fips` tags sit at the previous release, or are absent on the first; everything published is scanned, signed, and attested, but the floating tag pair diverges until the run is repaired. The variant's multi-arch build runs only at release time and in a dry run. Recover by re-running the failed publish job once the cause is fixed; it rebuilds both images from the same commit and re-pushes the same tags.

**The hosted web application's production deployment.** The same workflow builds the hosted web application and the demo site from the tag and runs the web suites a `staging` deploy runs. Once the publish job has finished, it uploads both as the production deployment of their Pages projects ([DEPLOYMENT.md](DEPLOYMENT.md#deploying-to-cloudflare-pages)). A tag the publish job refuses deploys nothing, and a push to `main` does not deploy the hosted application.

**Dry run.** Dispatching the workflow from a branch (`gh workflow run release.yaml --ref <branch>`, or "Run workflow" on the Actions page) runs the test job and a separate dry-run job, and skips the publish, launchers, and hosted application jobs. The dry-run job holds read access to the repository and nothing else: it verifies the vendored tarball, then builds both images for both platforms under fixed local tags without pushing them. Apart from the Docker Hub pull login above, it runs no scan, FIPS probe, launcher stamp, login, signature, or release step. Use it to prove a runner-image or action change to the build before a tag depends on it; `scripts/release-dry-run.test.mjs` checks that the publish and launchers jobs run on a tag push only and that the dry-run job holds no write permission or publishing step.

If you must build and push by hand -- for a workflow outage or a local test -- follow the multi-platform buildx instructions in `apps/cli/README.md` (creating `multiarch-builder` and running `docker buildx build --push` from the repository root; the variant adds `-f Dockerfile.fips` and the `-fips` tags). A hand-built push bypasses the [image vulnerability scan](#image-vulnerability-scan) and Cosign: scan the image yourself before pushing it, at the threshold the workflow sets, and expect a hand-pushed tag to fail the verification commands below.

#### The Docker Hub copy

Once the publish job has finished, the `dockerhub` job copies both images to `docker.io/gumdi/alcove` with `docker buildx imagetools create`. The source is the digest the publish job pushed to ghcr.io, signed, and attested, and the Docker Hub tags are the same three each image has on ghcr.io. The job then reads back each image's version tag on ghcr.io and all three of its tags on Docker Hub, and fails the release if any of them names a digest other than the signed one. The run's summary page lists each reference with the digest read back.

The job logs in to Docker Hub with secrets of its own, `DOCKERHUB_PUBLISH_USERNAME` and `DOCKERHUB_PUBLISH_TOKEN`, in the repository's Actions secrets:

- The token is a Docker Hub personal access token with Read & Write access, created on the `vdorie` account, because the free `gumdi` organization offers no organization tokens.
- It expires on 2027-10-30. Replace the `DOCKERHUB_PUBLISH_TOKEN` value before then, or the "Log in to Docker Hub to publish" step fails every release.
- The read-only `DOCKERHUB_TOKEN` pull token above is not used for the copy, and is not given write access.

The copy runs in its own job, so a failure there leaves both images published, signed, and attested on ghcr.io and the launchers attached. Once the cause is fixed, re-run the failed job (`gh run rerun <run-id> --failed`): it copies the same digests again without rebuilding. If the job reports a Docker Hub tag naming a different digest, that tag is not the signed image: do not publish the release in step 10 until a copy by digest from ghcr.io reads back the signed digest on every Docker Hub tag. If it reports the ghcr.io version tag naming a different digest, something pushed to that tag after the publish job signed it, and re-running the copy does not change that: find what pushed it, and do not publish the release until the tag names the signed digest again.

### 9. Generate and attach the SBOM

From the workspace root:

```sh
npm sbom --sbom-format cyclonedx --package-lock-only --omit=dev -w packages/core -w apps/cli -w apps/web > alcove-X.Y.Z.cdx.json
```

`--omit=dev` stays: `apps/web`'s build tools are `devDependencies` and are not shipped. See [SBOM](#software-bill-of-materials-sbom) for the scoping.

If the command refuses on a peer conflict, do not use `@cyclonedx/cyclonedx-npm --ignore-npm-errors` instead: run over this workspace it was measured silently omitting `@openmined/psi.js`, the vendored crypto addon, along with the rest of the workspace packages' trees.

### 10. Publish the GitHub Release

Step 8 leaves a draft release for tag `vX.Y.Z` with the stamped launchers. Open it, copy the CHANGELOG section for this version as the release body, attach `alcove-X.Y.Z.cdx.json`, record both Docker image digests from step 8 in the release notes -- the default image's and the FIPS variant's, each beside its tag -- and publish. Publish only once the `dockerhub` job has passed. Each digest is the same on ghcr.io and on Docker Hub, as that job's summary shows, so each is recorded once and names the image at both `ghcr.io/georgetown-mdi/alcove` and `docker.io/gumdi/alcove`. Leave the launcher assets in place: they are the copy an operator downloads.

### 11. Merge back to staging

```sh
git checkout staging
git merge main
git push origin staging
```

## Hotfix Releases

For security fixes or critical bugs in an already-released version:

1. Branch from the affected release tag: `git checkout -b hotfix/vX.Y.Z+1 vX.Y.Z`.
2. Apply the fix with a minimal, focused commit.
3. Follow steps 3 through 11 above, incrementing only the PATCH component.
4. If the vulnerability affects the previous major version as well (see [SECURITY.md](../SECURITY.md)), apply the fix there too before proceeding.

For a hotfix answering a privately reported vulnerability, this section is the mechanics only. The sequencing around it -- keeping the fix out of public view until the release and the advisory land together, and what publishes alongside them -- is in [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md#4-fix-privately-then-release).

## Verifying a Release

### Container image

Both container image digests for each release are recorded in the GitHub Release notes. Verify with:

```sh
docker pull ghcr.io/georgetown-mdi/alcove:X.Y.Z
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/georgetown-mdi/alcove:X.Y.Z
```

Compare the digest against the value in the release notes. The FIPS variant is verified the same way, at `ghcr.io/georgetown-mdi/alcove:X.Y.Z-fips`; every command in this section takes either reference.

**An image pulled from Docker Hub.** `docker.io/gumdi/alcove` has the same images under the same tags and the same digests. The Cosign signature and the build provenance attestation are recorded against `ghcr.io/georgetown-mdi/alcove` only, so a Docker Hub pull is verified by its digest:

1. Read the digest with the two commands above, naming `docker.io/gumdi/alcove:X.Y.Z` (or `X.Y.Z-fips`).
2. Compare it against the value in the release notes.
3. Run the `cosign verify` and `gh attestation verify` commands below against `ghcr.io/georgetown-mdi/alcove@sha256:...`, with that digest. Cosign reads the signature from ghcr.io, so where ghcr.io cannot be reached, run both from any machine that can: the signature and the attestation are recorded against the digest, which is the same on both registries.

Each release image is also signed with Cosign, keylessly through Sigstore. The signature includes a short-lived certificate Fulcio issued against the release workflow's OIDC identity, and it is recorded in Rekor's public transparency log. There is no project-held signing key and no public key to fetch: what a verifier pins is the workflow that produced the signature ([cosign-keyless-signing.md](notes/cosign-keyless-signing.md)).

This verifies by tag, the form to use when the reference comes from the release notes; a reference read out of a stamped launcher is verified by digest instead (see [Stamped launchers](#stamped-launchers)). To verify:

```sh
cosign verify \
  --certificate-identity-regexp '^https://github\.com/georgetown-mdi/alcove/\.github/workflows/release\.yaml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/georgetown-mdi/alcove:X.Y.Z
```

Both `--certificate-` arguments are required:

- `--certificate-identity-regexp` pins the signer. The certificate's identity is the workflow file's path in this repository plus the ref it ran from, so an anchored pattern refuses a signature produced by a different workflow here, by a branch run of this one, or by a fork.
- `--certificate-oidc-issuer` pins who vouched for that identity to GitHub Actions: verification compares the certificate's issuer for equality and refuses any mismatch.

Omitting either, or loosening the pattern to something unanchored, accepts signatures a release did not produce.

**The release runs this command on itself.** Each published image is verified with these exact arguments, against the digest just signed, before the next image is built, so a release that completes is one whose signatures verified under the command above. `npm run check:release-signing` holds the pattern published here, the copy the workflow runs, and the workflow's own path and tag trigger to each other on every pull request.

Install Cosign before running this command (see the Cosign documentation for your platform). Behind a signature that verifies there is also a public Rekor transparency-log entry, which anyone can inspect independently of this project.

### Build provenance

The Cosign signature and the SLSA build provenance attestation are complementary; verify both. The signature establishes that the release workflow published this exact manifest, and travels with the image in the registry. The attestation establishes what the build consumed -- which source repository and commit it ran from, and which workflow produced it -- and is held by GitHub rather than by the registry.

The release workflow attests each manifest-list digest, the same digests Cosign signs and, for the default image, the one the launchers name, and stores both attestations against this repository. Verify by digest:

```sh
docker pull ghcr.io/georgetown-mdi/alcove:X.Y.Z
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/georgetown-mdi/alcove:X.Y.Z
gh attestation verify oci://ghcr.io/georgetown-mdi/alcove@sha256:... \
  --repo georgetown-mdi/alcove \
  --signer-workflow georgetown-mdi/alcove/.github/workflows/release.yaml
```

Both subjects are recorded as `ghcr.io/georgetown-mdi/alcove`, the same reference the Cosign step signs under; the two attestations are told apart by their digests, not by their subject names. Neither the attest step nor this verify command has yet run against a published release. If verification reports no matching attestation for an image that is attested, check the reference spelling first: `ghcr.io` is the registry's canonical host, and the subject recorded and the reference verified should match byte for byte.

Notes on the command:

- It needs the [GitHub CLI](https://cli.github.com/) (`gh`), not Cosign. `cosign verify-attestation` reads attestations Cosign attached to the image in the registry; this one is held by GitHub, and `gh` fetches it from there.
- `--signer-workflow` is what makes the check specific: `--repo` alone is satisfied by any attestation this repository produced, from any workflow in it. Its value is the release workflow's own path; `npm run check:release-signing` holds the path published here to that workflow on every pull request.
- The attested subject is the multi-platform manifest list, which is what the release publishes and what the digest above resolves to. A per-architecture digest read out of that index is not itself an attested subject.

What the attestation is and is not evidence of, for an agency assessment, is in [COMPLIANCE.md#release-integrity](COMPLIANCE.md#release-integrity).

### Source integrity

Release tags are signed with the maintainer's SSH key. The public key fingerprint is:

```
SHA256:gILsiGXszofEYqaCjXtCFuUzIw+cZDK0WrlCGd6fohM (RSA, vdorie@gmail.com)
```

To verify, point git at the `allowed_signers` file in the repository root, then verify the tag:

```sh
git config gpg.ssh.allowedSignersFile allowed_signers
git verify-tag vX.Y.Z
```

## Software Bill of Materials (SBOM)

An SBOM in CycloneDX format is generated as part of the release checklist (step 9) and attached to each GitHub Release. It covers the npm dependency tree and no other layer. Each image's OS packages are covered by the attribution lists beside `NOTICE`, per [CONTAINER_IMAGES.md](spec/CONTAINER_IMAGES.md#the-os-layer-attribution-lists), and by the [image vulnerability scan](#image-vulnerability-scan) for advisories against them.

- One BOM covers both published images: they resolve the same committed lockfile through the same production install, so their npm trees are identical and only their OS packages differ.
- The `--omit=dev -w packages/core -w apps/cli -w apps/web` scoping covers the npm tree of everything a shipped image runs: the CLI role's production tree (`packages/core` and `apps/cli`, which the Dockerfile installs as `npm ci --omit=dev --omit=optional -w packages/core -w apps/cli`, so this scoping is a superset of it by the optional edges) plus the web console's runtime dependencies, which ship bundled into the console server and client builds the image copies (`apps/web/dist/console-server` and `apps/web/dist/console`). `--omit=dev` excludes devDependencies, which the image does not ship. Because those builds are tree-shaken, the `apps/web` entry is a superset of what actually ships.
- Because the SBOM and the image resolve from the same committed lockfile, every dependency it lists appears at the exact resolved version the image runs.
- The one known residual: `npm sbom` omits a small number of packages that are hoisted to a single `node_modules` entry shared with a dev-only consumer elsewhere in the workspace (for example `yaml` and `tslib`, both installed in the shipped tree and absent from the step 9 command's component list; a copy of the same name nested under another package can still be listed, so check the version as well as the name; the measured versions are in [DEPENDENCY_PINS.md](spec/DEPENDENCY_PINS.md#the-release-sboms-hoisting-residual)). Confirm against `npm ls <pkg> --omit=dev -w packages/core -w apps/cli -w apps/web` if a specific package's presence in the image needs checking and it is missing from the SBOM.
- The superset also runs the other way: a devDependency of a source-only workspace that hoists to the root `node_modules` and satisfies another package's optional peer flips to `devOptional` and enters this graph without shipping. None does against the committed lockfile: measured 2026-10-06, `tsx`, hoisted by `packages/peerjs-broker`, is flagged `dev` and absent from the step 9 BOM.
- The Node.js runtime is outside both this BOM and the OS attribution lists: the default image takes it from its `node:26-alpine` base and the FIPS variant from the `nodejs.org` tarball its Dockerfile names, so it arrives as neither an npm nor an OS package. What each image pins it to is in [CONTAINER_IMAGES.md](spec/CONTAINER_IMAGES.md).

See `docs/spec/DEPENDENCY_PINS.md`.
