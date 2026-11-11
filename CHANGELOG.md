---
title: "Changelog"
---

# Changelog

This changelog is a reader's summary of what Alcove does and how that changes per release: the major capabilities, breaking changes to them, and the headline security posture. It is not a log of every commit or every refinement (that is the git history). Each entry states the capability in a line or two and points to `docs/` for the full behavior and `docs/spec/` for wire-level detail. The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); Alcove uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [0.9.0-beta.1] - 2026-11-11

### Added

- The CLI exchanges over SFTP, a shared folder (`filedrop`), or WebRTC: recurring exchanges from a saved configuration, or a one-off with no configuration from a `zero-setup` URL. Over WebRTC either party may be a browser. See `docs/CLI.md` and `docs/COMMUNICATION.md`.
- The web app runs invitation-based exchanges between two browsers: one side creates a single-use invitation link, and the partner opens it to review the terms and consent. See `docs/WEB_APP.md`.
- The web app saves a completed exchange as recurring and runs it again with the same partner without a new invitation, on a schedule when installed as an app. A recurring exchange exports to a credential file for backup or another device, or to the command line with the cron or Task Scheduler lines to run it there. See `docs/MANAGED_EXCHANGE.md`.
- The console, a browser interface to the CLI in the container image, lets an operator author and run one exchange without writing a configuration. It has no authentication, so publish it only on the host's loopback address, where only the operator's own machine reaches it. Launchers for Windows, macOS, and Linux, attached to each release, start it. See `docs/CONSOLE.md`.
- WebRTC exchanges connect on networks that block direct paths: the hosted web app offers the project's TURN relay, whose operator, the project, then learns both parties' addresses, and a CLI or browser exchange falls back to a WebSocket relay that forwards its encrypted messages unread. See `PRIVACY.md` and `docs/COMMUNICATION.md`.
- Each party writes a local exchange record of what it disclosed, for a HIPAA or FERPA accounting of disclosures, and a CLI exchange with a signing identity also writes a receipt both parties sign with ECDSA over P-256. `alcove verify-receipt` and the web app's "Verify a receipt" page check either. See `docs/spec/EXCHANGE_RECORD.md`.
- Matching options: the built-in rules come in highest precision and broader matching, which a quick exchange, `alcove init`, and the web app start with; a key can match on several values per record (`split_on`) or on approximate variants (`generate_fuzzy_comparisons`, `swap`); and `deduplicate: true` lets several of a party's records link to one partner record. See `docs/EXCHANGE_REFERENCE.md`.
- The `single-pass` linkage strategy runs every agreed key in one PSI exchange for a high-latency channel, a consented disclosure tradeoff against the default per-key `cascade`. See `docs/EXCHANGE_REFERENCE.md`.
- Count-only (`psi-c`) exchanges, intended only for research, show both parties only the number of records in common. See `docs/EXCHANGE_REFERENCE.md`.
- Linkage values are standardized before matching: each semantic type has a default pipeline, used when an exchange authors no `standardization` block, and every transform regular expression is evaluated under one RE2 dialect on both parties. Release 0.1.0 had neither, so no default pipeline or pattern meaning changed from it. See `docs/spec/DEFAULT_STANDARDIZATION.md` and `docs/spec/PROTOCOL.md`.
- The container image is published in a default and a FIPS variant (`X.Y.Z-fips`, with the CMVP-validated OpenSSL FIPS provider for Amazon Linux 2023), at `docker.io/gumdi/alcove` and `ghcr.io/georgetown-mdi/alcove`, signed with Cosign and with build provenance attested. Each release also attaches a signed manifest of the hosted web app's files. See `docs/RELEASES.md` and `docs/COMPLIANCE.md`.
- Two builds use the highest protocol version both support, and refuse with the cause named before any data moves when they share none; from 1.0.0, a version is retired only at a major release. See `docs/RELEASES.md`.

### Changed

- BREAKING: the product is renamed Alcove, from psilink: the command is `alcove`, not `psi-link`, and the container image moves from `docker.io/vdorie/psi-link`, which takes no new release, to `ghcr.io/georgetown-mdi/alcove` and `docker.io/gumdi/alcove`. See `docs/notes/rename-to-alcove.md`.
- BREAKING: the container image runs unprivileged as uid 1000 instead of root. A bind-mounted working directory must be writable by uid 1000: run the container as your own account with `--user`, or `chown -R 1000:1000` the directory. See `docs/DEPLOYMENT.md`.
- BREAKING: the exchange record format starts at version 1 in this release, so the web app does not read a record an earlier hosted build wrote. A recurring exchange whose accounting of disclosures an earlier build stored says so on its page: download the stored records, then start a fresh accounting so its runs file their records again. See `docs/spec/MANAGED_EXCHANGE_RECORD.md`.
- BREAKING: the web app opens on the browser's recurring exchanges once one exists and on the quick path otherwise, and the legacy web interface is removed. See `docs/WEB_APP.md`.

### Security

- Recurring CLI exchanges are encrypted end-to-end with an application-layer AEAD and authenticated with a P-256 key exchange, and SFTP connections verify the server host key fail-closed. The web app and the CLI apply the same encryption on every WebRTC exchange. See `docs/SECURITY_DESIGN.md` and `docs/spec/CHANNEL_SECURITY.md`.
- The web app and the console send a Content-Security-Policy that runs only the app's own scripts, so an injected inline script or a script from another site does not run. See `docs/SECURITY_DESIGN.md`.

## [0.1.0] - 2026-05-08

Initial proof-of-concept release.

### Added

- Web application: browser-based PSI over WebRTC using ephemeral invitation links.
- Built-in PeerJS peer-coordination server in the web application, served under `/api/`.
- SFTP transport for recurring exchanges between two parties via the CLI.
- `exchange` CLI command: run an exchange over an SFTP connection and predefined linkage rules.
- PSI protocol implementation wrapping the OpenMined PSI WebAssembly module (`@openmined/psi.js`).
