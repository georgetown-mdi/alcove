---
title: "Changelog"
---

# Changelog

This changelog is a reader's summary of what Alcove does and how that changes per release: the major capabilities, breaking changes to them, and the headline security posture. It is not a log of every commit or every refinement (that is the git history). Each entry states the capability in a line or two and points to `docs/` for the full behavior and `docs/spec/` for wire-level detail. The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); Alcove uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- The CLI runs recurring, authenticated SFTP exchanges between two parties from a saved config, and one-off exchanges with no config via a `zero-setup` URL. See `docs/CLI.md`.
- The `filedrop` channel exchanges through a shared local directory where neither SFTP nor WebRTC is available. See `docs/COMMUNICATION.md`.
- The CLI runs exchanges over the `webrtc` channel: a peer-to-peer data channel reached through a peer-coordination server, with no file server or shared directory in between. Either party may be a browser, so a CLI party and a web-app party can exchange with each other. See `docs/CLI.md`.
- The web app runs backend-free, invitation-based browser-to-browser exchanges over WebRTC: one side mints a single-use invitation link, the partner opens it to review the terms and consent, and the two browsers rendezvous directly. See `docs/WEB_APP.md` and `docs/SECURITY_DESIGN.md`.
- The web app runs recurring exchanges: either party saves a completed exchange as recurring, runs it again with the same partner without a new invitation, and can export it as a credential file for backup or for another device. See `docs/MANAGED_EXCHANGE.md`.
- A recurring (managed) exchange in the web app exports to the command line: the detail surface hands the operator the `alcove.yaml` and `.alcove.key` files `alcove exchange` reads, the ready-to-run invocation, and cron / Task Scheduler lines, and spends the browser's copy on the operator's confirmation so exactly one party holds the secret. See `docs/MANAGED_EXCHANGE.md`.
- The web application installs as an offline-capable app: a dependency-free service worker caches the app shell and every screen's code at launch, so an installed app opens offline, states plainly what works without a connection, and applies a new version only on an operator-confirmed reload. See `docs/MANAGED_EXCHANGE.md`.
- The web app can run as a single-party console, driving the party's own `alcove` exchange (filedrop, SFTP, or, as the inviting party, WebRTC) as a server-side subprocess so an operator runs and downloads a result without the command line. See `docs/CONSOLE.md` and `docs/spec/SERVER_JOB_API.md`.
- The console runs a Direct exchange: a no-invitation, lowest-ceremony path where both parties run against a server they agreed on out of band, with linkage terms inferred from each party's file (previewed for confirmation) and no shared secret, so protection is transport-only -- the console analog of the CLI's zero-setup. See `docs/CONSOLE.md` and `docs/spec/SERVER_JOB_API.md`.
- The console can open the `alcove.yaml` already sitting in its mounted working directory and pre-fill every authoring step from it, then hand back a configuration byte-compatible with what the command line writes: the console does the settings and the command line does the work. See `docs/CONSOLE.md` and `docs/spec/EXCHANGE_FILE.md`.
- The console sends the partner an accept kit: a printable, plaintext instruction sheet, downloaded alongside the invitation, that takes a partner who has only Docker -- Desktop or Engine -- to the point of accepting an SFTP or shared-directory exchange. It carries no secret and no invitation token. See `docs/CONSOLE.md`.
- The console's WebRTC exchanges can use a TURN relay: the operator names the relay urls (and optionally a relay registrar) beside the coordination server, the invitation names the same relay for the partner, and an exchange completes when either side's network blocks direct connections. See `docs/CONSOLE.md` and `docs/COMMUNICATION.md`.
- The hosted web app offers the project's TURN relay, so two browsers connect on a network that blocks direct paths; on an exchange that uses it, the project, as the relay's operator, learns both parties' addresses. See `PRIVACY.md` and `docs/COMMUNICATION.md`.
- A WebRTC exchange, CLI or browser, falls back to a WebSocket relay when no WebRTC path opens, so two parties on a network whose inspection stops WebRTC and TURN still connect over one `wss://` connection each; the relay forwards the exchange's encrypted messages unread. See `docs/CLI.md` and `docs/spec/WEBRTC_TRANSPORT.md`.
- Each party writes a local, self-attested exchange record of what it disclosed, suitable for a HIPAA or FERPA accounting of disclosures. `alcove verify-receipt` (CLI) and the web "Verify a receipt" page re-check a stored record for internal consistency, read-only. See `docs/spec/EXCHANGE_RECORD.md`.
- Authenticated CLI exchanges configured with a signing identity also produce a dual-signed exchange receipt, both parties signing the same terms and data-flow facts, for a third-party-verifiable record of the data flow that `alcove verify-receipt` and the web "Verify a receipt" page check. See `docs/spec/PROTOCOL.md` and `docs/spec/EXCHANGE_RECORD.md`.
- The `single-pass` linkage strategy batches every agreed linkage key into one PSI exchange, keeping the round-trip count constant in the key count for a high-latency channel, as a consented disclosure tradeoff against the default per-key `cascade`. See `docs/EXCHANGE_REFERENCE.md` and `docs/spec/PROTOCOL.md`.
- A linkage key can match on several values per record: each candidate a `split_on` transform produces (a hyphenated surname and its parts) enters that key's round, and a record matching on any of them is paired at most once. See `docs/EXCHANGE_REFERENCE.md` and `docs/spec/PROTOCOL.md`.
- A linkage key element can match approximate variants of its value: `generate_fuzzy_comparisons` expands it into transpositions, deletions, adjacent years, or a date with day and month exchanged, and a key declaring `swap` matches its two elements in either order. See `docs/EXCHANGE_REFERENCE.md` and `docs/spec/PROTOCOL.md`.
- The built-in matching rules come in two choices, highest precision and broader matching, with rules that match on a name and date of birth alone marked less certain. A quick exchange, `alcove init`, and the web app start with broader matching. See `docs/EXCHANGE_REFERENCE.md`.
- Linkage values are standardized before matching: each semantic type has a default pipeline, used when an exchange authors no `standardization` block, and every transform regular expression is evaluated under one RE2 dialect on both parties. Release 0.1.0 had neither, so no default pipeline or pattern meaning changed from it. See `docs/spec/DEFAULT_STANDARDIZATION.md` and `docs/spec/PROTOCOL.md`.
- Count-only (`psi-c`) exchanges, intended only for research, run end to end: both parties are shown only the number of records in common across every agreed key, and the consent surfaces state what that count does and does not bound. See `docs/EXCHANGE_REFERENCE.md` and `docs/spec/PROTOCOL.md`.
- A party can deduplicate its own inputs against the partner's data: `deduplicate: true` lets several of that party's records link to the same partner record, and the result file, the exchange record, and both consent surfaces show the multiplicity. See `docs/EXCHANGE_REFERENCE.md` and `docs/spec/PROTOCOL.md`.
- The PSI engine selects a native N-API backend when a prebuilt addon is present for the running platform, falling back to WASM; the browser always uses WASM. It is a performance accelerator with byte-identical wire output. See `docs/spec/PROTOCOL.md`.
- A FIPS variant of the container image is published beside the default one, at `ghcr.io/georgetown-mdi/alcove:X.Y.Z-fips`, embedding the CMVP-validated OpenSSL FIPS provider AWS publishes for Amazon Linux 2023. See `docs/RELEASES.md` and `docs/COMPLIANCE.md`.
- Both container images, the default and the FIPS variant, are published on Docker Hub at `docker.io/gumdi/alcove` beside `ghcr.io/georgetown-mdi/alcove`: the same manifest under one digest, signed with Cosign on each registry under the release workflow's identity, its build provenance attested on GitHub. See `docs/RELEASES.md`.
- Each release attaches a manifest of the hosted web app it builds, signed and with its build provenance attested, listing every file with its SHA-256 so the served site can be compared against the release build; each production deploy from `main` publishes one for its own build. See `docs/RELEASES.md`.
- Host-side console launchers, published stamped as release assets: `Start-Alcove.ps1` (Windows) and `start-alcove.sh` (macOS and Linux) check the exchange folders, start the web console against the release image pinned by digest, and open the browser. Plaintext, no network of their own, no persistence, no auto-update. See `docs/RELEASES.md` and the setup page in `support/windows-network-filedrop/README.md`.
- Two builds negotiate the highest protocol and channel-envelope version both support, and refuse with the cause named before any data moves when they share none; from 1.0.0, a version is retired only at a major release. See `docs/RELEASES.md` and `docs/spec/PROTOCOL.md`.

### Changed

- BREAKING: the product is renamed Alcove, from psilink, and its file names, environment variables, container image, record and receipt formats, and the web app's stored data change with it; nothing written by a pre-rename build is read. See `docs/notes/rename-to-alcove.md`.
- BREAKING: the published container image runs unprivileged as uid 1000 (`USER node`) instead of root, for both the CLI and console roles. A bind-mounted working directory -- including one an earlier root image wrote into -- must be writable by uid 1000: run the container as your own account with `--user`, or `chown -R 1000:1000` the directory. See `docs/DEPLOYMENT.md`.
- BREAKING: exchange receipts are signed with ECDSA over P-256 through the platform's Web Crypto, so every certificate fingerprint changes: regenerate the identity with `alcove fingerprint --force` and re-share the new fingerprint with each partner out of band. See `docs/spec/PROTOCOL.md` and `docs/spec/EXCHANGE_RECORD.md`.
- BREAKING: the self-attested exchange record format changes, adding the run's outcome, a certificate-mismatch marker, and both parties' `deduplicate` values, and its agreed-terms hash covers the resolved terms; a record in an earlier format is refused. See `docs/spec/EXCHANGE_RECORD.md`.
- BREAKING: the redesigned web app's home route opens on the browser's recurring (managed) exchanges once one exists and on the quick path otherwise, and the legacy web interface is removed. See `docs/DESIGN.md`, `docs/MANAGED_EXCHANGE.md`, and `docs/COMMUNICATION.md`.
- `alcove accept` on an invitation naming a WebRTC coordination server, given an input file, accepts and runs the exchange in one invocation; the same command previously wrote the configuration and stopped. A scripted `accept --consent-to-terms` written before this change now also connects and transmits -- the consent surface and the flag's help text state the widened authorization. See `docs/CLI.md`.
- BREAKING: `alcove invite` and `alcove accept` require `--identity`, the label a partner reads as this party's name, so a scripted invite or accept without it exits 64. See `docs/CLI.md`.
- BREAKING: the CLI resolves the signing identity like a credential, from `signing.identity_file` or `--identity-file` only, with no default path; to keep using an identity minted at `~/.psilink/signing-identity.json`, set `signing.identity_file` to it. See `docs/CLI.md` and `docs/DEPLOYMENT.md`.
- BREAKING: `alcove accept` and `alcove exchange` exit 64 when the input cannot satisfy every agreed linkage key or a key's cleaning can never produce a value, and the web app and the console refuse to launch on the same rule. See `docs/CLI.md` and `docs/COMMUNICATION.md`.
- BREAKING: `alcove verify-receipt` exits 65 (`EX_DATAERR`) on a definite verification failure instead of 1, so a script can tell a bad receipt from an uncaught fault, which still exits 1. See `docs/CLI.md`.
- BREAKING: when an `alcove exchange` run stops after one party saved the rotated shared secret and before the other did, the next run completes without a new invitation, and the exit codes of those save failures change. See `docs/CLI.md`.
- BREAKING: the dual-signed receipt format holds the partner's linkage terms, so verifying a receipt needs no partner terms document beside it; a receipt in an earlier format is refused. See `docs/spec/EXCHANGE_RECORD.md`.
- The default `email_address` cleaning removes dots and a plus tag from a gmail.com or googlemail.com address and writes the domain as gmail.com, so the spellings of one Gmail mailbox match; both parties need a release with this default for those addresses to match each other. See `docs/spec/DEFAULT_STANDARDIZATION.md`.
- BREAKING: the web app and the CLI apply application-layer encryption on every WebRTC exchange, so a web app build from before this change cannot complete a WebRTC exchange with a current CLI or web app. See `docs/spec/CHANNEL_SECURITY.md`.

### Fixed

- A CLI WebRTC exchange relayed through a TURN server stays connected past the relay's nonce lifetime, about 1,000 seconds on the project's relay, where it lost its connection. See `docs/spec/DEPENDENCY_PINS.md`.

### Security

- Recurring CLI exchanges are encrypted end-to-end on the wire with an application-layer AEAD, authenticated with a P-256 key exchange, and SFTP connections verify the server host key fail-closed. See `docs/SECURITY_DESIGN.md`, `docs/spec/CHANNEL_SECURITY.md` and `docs/spec/SFTP_CONNECTION.md`.
- The web app and the console send a Content-Security-Policy that runs only the app's own scripts, so an injected inline script or a script from another site does not run. See `docs/SECURITY_DESIGN.md`.

## [0.1.0] - 2026-05-08

Initial proof-of-concept release.

### Added

- Web application: browser-based PSI over WebRTC using ephemeral invitation links.
- Built-in PeerJS peer-coordination server in the web application, served under `/api/`.
- SFTP transport for recurring exchanges between two parties via the CLI.
- `exchange` CLI command: run an exchange over an SFTP connection and predefined linkage rules.
- PSI protocol implementation wrapping the OpenMined PSI WebAssembly module (`@openmined/psi.js`).
