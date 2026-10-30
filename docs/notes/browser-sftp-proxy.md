---
title: "The Browser SFTP Path and its WebSocket-to-TCP Proxy"
---

# The browser SFTP path, and the WebSocket-to-TCP proxy it needs

_Status: design only; nothing here is built.
The browser SSH client is chosen on two conditions, measured on 2026-10-30: the licence check passes, the maintenance check does not, and the client is sized ([The chosen client](#the-chosen-client-dependency-check-and-sizing)).
The note frames what a browser SFTP path would need, recommends where it can, and lists the choices left open for the maintainer.
Nothing here is normative: the channel-security rules are in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it),
the host-key rules in
[SFTP_CONNECTION.md](../spec/SFTP_CONNECTION.md#sftp-host-key-verification),
and the console's trust boundary in
[SECURITY_DESIGN.md](../SECURITY_DESIGN.md#single-party-console-trust-boundary).
See [docs/notes/README.md](README.md)._

## The problem

A browser cannot open a raw TCP connection, so a browser party that wants to reach an SFTP server needs a WebSocket-to-TCP proxy between them
([COMMUNICATION.md](../COMMUNICATION.md#websocket-to-tcp-proxy)).
No such proxy, and no browser SFTP client, is built:

- The public web application runs WebRTC exchanges only.
  For the SFTP and shared-folder channels it writes an exchange file the command line application runs
  (`selectExchangeDriver` in `apps/web/src/psi/exchangeDriverSelection.ts` returns `save-file` for `sftp` on a hosted build).
- The console runs an SFTP exchange as a server job: its server spawns the CLI, which opens the socket itself
  (the same function returns `server-job` for `sftp` on a console build; [web-server-runtime-role.md](web-server-runtime-role.md#the-console-profile-where-the-server-does-run-an-exchange)).
- The only SSH client in the repository is the CLI's, built on `ssh2` and `ssh2-sftp-client`
  (`apps/cli/package.json`; `apps/cli/src/connection/ssh2SftpAdapter.ts`).

The connection schema has no proxy setting.
The open question is whether a browser party needs one, where it lives, and which client reads it.

## Two product questions come first

Whether a browser SFTP path exists, and for which application, is a product decision ([fork 1](#forks)); the rest of the note applies under either answer.
Two facts bear on it:

- **The console does not need a proxy to run SFTP.**
  Its server already opens the socket through the CLI subprocess, and the planned in-process path would also run in the server process, not the tab
  ([DESIGN.md](../DESIGN.md#web-console)).
  A proxy there would let the tab be the SSH client instead, which no console workflow needs today, at the cost of the browser SSH client, the wrap on the web side, and a WebSocket route on the console server.
- **The public web application is the one that lacks a route to an SFTP server.**
  A browser SFTP path there would let a hosted-app party exchange with a partner who uses SFTP, and run a recurring managed exchange over SFTP on the app's schedule.
  It changes the public app's WebRTC-only scope in `CLAUDE.md` (Applications), ships an SSH client to every browser, and needs a proxy the party can reach.

## What the proxy speaks

### Framing

- **Raw byte relay.**
  Each WebSocket binary message is a chunk of the TCP byte stream, with no meaning in the message boundaries, and the proxy opens one TCP connection per WebSocket.
  SSH runs end to end between the browser and the SFTP server; the proxy forwards traffic it cannot decrypt.
  This is the shape `websockify` is commonly described as implementing (unverified here).
- **Framed protocol.**
  A header message ahead of the relay carries a target selection, an authentication token, or both.
  It is needed only if the target is chosen per connection or the token cannot travel in the upgrade request, and it rules out an off-the-shelf raw relay.
- **Terminating proxy.**
  The proxy is itself the SSH and SFTP client, and the browser speaks a file API to it.
  It removes the browser SSH client at the cost under [Channel security](#channel-security).

The recommendation is the raw byte relay with a fixed target, so that the proxy is a TCP forwarder and a standard one can be deployed.
Whether any standard proxy qualifies is unverified, and turns on two behaviors:

- **Backpressure.** The proxy pauses reading from TCP while its WebSocket send buffer is full, and the reverse; without it a slow browser makes the proxy buffer without bound.
- **Close mapping.** A close or reset on either side ends the other, so a stalled side is caught by the browser client's liveness bounds rather than hanging.

What would verify it: run a candidate proxy in front of the SFTP test server from [TESTING.md](../TESTING.md#integration-tests), drive an SSH client through it, and check both behaviors and the `Origin` refusal below.

### Authentication of the browser to the proxy

The SFTP server's own SSH authentication applies through any raw relay, so the proxy's authentication decides who may reach the SSH port, not who may read the exchange.

- **No credential, origin-checked.**
  The proxy refuses an upgrade whose `Origin` is not the web application's, and otherwise forwards to its fixed target.
  This exposes the SSH port about as widely as publishing it does, and stops other web pages from using the proxy from a visitor's browser.
  Browsers send `Origin` on every WebSocket upgrade and page script cannot set it (RFC 6455 section 10.2; unverified here), while a non-browser client can send any value, so the check bounds browser-delivered pages only.
- **A static token.**
  The browser WebSocket API sets no custom headers (unverified here), so a token travels in the URL query (which reaches access logs), the `Sec-WebSocket-Protocol` value, a cookie, or a first message under the framed protocol.
  The token sits in browser storage.
- **A per-exchange credential.**
  Derived from the exchange's shared secret and registered with the proxy, as a TURN relay credential is
  ([PROTOCOL.md](../spec/PROTOCOL.md#relay-credential-derivation)).
  It scopes access to one exchange's parties, and a quick exchange, which has no shared secret, cannot use it.

The recommendation is the origin check on every proxy shape; whether to add a token is open.

### How the target is chosen and restricted

- **Fixed target.**
  One proxy endpoint forwards to exactly one `host:port` from the proxy's own configuration, so nothing a browser sends can change where it connects.
  A party with two SFTP servers runs two endpoints.
- **Target in the request, checked against an allowlist.**
  The proxy refuses any `host:port` not on its list, checks the name it resolves itself, and refuses a loopback, link-local, or private address unless that address is listed, so a DNS change cannot point an allowed name at an internal service.

The recommendation is the fixed target: it needs no framing, no allowlist parser, and no resolution rule.

## How the proxy bounds what browser-delivered content can reach

`CLAUDE.md` (Applications) makes a control that constrains only remote or browser-delivered content a hard refusal.
Two kinds of content reach a proxy, and both are in that class:

- **The WebSocket upgrade.**
  Any page in any browser that can reach the proxy can attempt one, and the same-origin policy does not block a cross-origin WebSocket (unverified here).
  Unbounded, a proxy inside an agency network lets any visited page reach hosts behind that network's firewall.
- **The invitation's SFTP endpoint.**
  An `sftp` invitation names a `host` and optional `port` chosen by the inviting partner (`SFTPEndpoint` in `packages/core/src/config/invitation.ts`), so a browser party that dialed it unchecked would let the partner choose where the proxy connects.

The bound, applied as a refusal in each case:

1. The proxy connects only to its configured target (or allowlist), and refuses an upgrade that names any other target or comes from another origin.
2. The browser client refuses to run when its SFTP endpoint, from the invitation or the operator's own connection, is not the target of its configured proxy, naming both values and telling the operator which setting to fix.
3. An invitation never names a proxy: the invitation endpoint schemas are strict (`packages/core/src/config/invitation.ts`), and a proxy field stays off them.

What the operator chooses for themselves -- which proxy, one run by another organization, a token in browser storage -- is warn-and-guide under the same rule: the app warns, for instance, that another organization's proxy learns which SFTP server this party uses and when, and proceeds.

## Where the proxy runs

- **Inside the console container.**
  The console's server answers a WebSocket upgrade and relays to the one SFTP connection the operator authored.
  - The target is fixed by construction, composed from the authored connection as every CLI input is
    ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#single-party-console-trust-boundary)).
  - The upgrade route would sit behind the [browser-CSRF gate](../spec/SERVER_JOB_API.md#browser-csrf-gate) the job routes have, so a page the operator visits cannot open a WebSocket to the loopback port.
    The server bounds the pre-upgrade handshake (`apps/web/server/upgradeHardening.ts`) but serves no WebSocket route.
  - It adds no egress beyond the same SFTP server
    ([DEPLOYMENT.md](../DEPLOYMENT.md#restricting-the-containers-outbound-network-access)), and serves only the console, which already runs SFTP natively.
- **A hosted service the project runs.**
  - It is the only shape that lets a hosted-app party use SFTP with nothing to deploy.
  - It puts the project in the path of every browser SFTP exchange: client addresses, which SFTP server each party uses, timing and volume.
    The project's only default supporting service is peer coordination ([COMMUNICATION.md](../COMMUNICATION.md#supporting-services)).
  - Shared by every party, it cannot have a fixed target, so it needs the allowlist shape, and an open list makes it a TCP relay for anyone.
- **Operator-run.**
  The party that runs the SFTP server, or the browser party's own organization, runs a fixed-target proxy at its network edge.
  - It matches how the other optional supporting services are run: by a party, who answers for it ([SHARED_RESPONSIBILITY.md](../SHARED_RESPONSIBILITY.md#third-party-supporting-services)).
  - It needs a reference configuration, which the roadmap lists for version 1.1 ([ROADMAP.md](../ROADMAP.md#version-11); [DEPLOYMENT.md](../DEPLOYMENT.md#websocket-to-tcp-proxy)).
  - A browser party accepting a partner's server depends on the partner having deployed a proxy, or on its own organization running one with that target.

The recommendation, if the public application gets the path, is operator-run with a reference configuration; a console-container proxy only if a console workflow comes to need an in-tab SFTP client.

## Which client reads the proxy setting

Only a browser SFTP client needs a proxy; the CLI and the console's CLI subprocess connect natively.
The proxy is a property of where a party's client runs, not of the exchange, so two parties' settings differ even for one shared server
([COMMUNICATION.md](../COMMUNICATION.md#websocket-to-tcp-proxy)).

- **A `connection.proxy` field in the exchange file**, read by the web application's SFTP driver.
  - A CLI that silently ignored it would leave a field that appears to work and does nothing, so the CLI would need to refuse a configuration naming one, saying the field applies to a browser party only.
  - The console's configuration load would refuse it by its existing rule ([SERVER_JOB_API.md](../spec/SERVER_JOB_API.md#what-it-refuses)) unless the console grows an in-tab SFTP path.
- **A browser-local party setting**, outside the exchange file: a build-time value as the coordination server is ([DEPLOYMENT.md](../DEPLOYMENT.md#coordination-server)), an entry in the browser's settings as the TURN relay is, or both.
  - No exchange file or invitation names it, so no other client sees it and the CLI needs no refusal.
  - A saved recurring exchange stores its proxy beside its other browser-held settings.

The recommendation is the browser-local setting: the value sits where its only reader is, and the shared configuration format gains no field one application uses.

## The browser SFTP exchange, end to end

### The SSH client in the browser

The client must speak SSH and SFTP over a WebSocket-backed byte stream and implement core's `FileTransportClient` (`packages/core/src/connection/fileSyncConnection.ts`), so the file-sync stack above it runs unchanged.
Candidates, none verified in the browser:

- **`ssh2` bundled for the browser**, given a WebSocket-backed duplex through its `sock` option (named in `packages/core/src/connection/sftpConnect.ts`); whether it runs in a browser bundle given its Node API use is unverified.
- **A C SSH library compiled to WebAssembly**; which libraries build, their SFTP coverage, and how they take a WebSocket stream are unverified.
- **Another JavaScript SSH client**; whether one exists with SFTP support, a host-key callback before authentication, and acceptable maintenance is unverified.

Spike S8 drove three clients from the browser ([web-websocket-transport.md](web-websocket-transport.md#the-spikes)), and the maintainer chose `@microsoft/dev-tunnels-ssh` on 2026-10-29, on the conditions [below](#the-chosen-client-dependency-check-and-sizing).
It is a new security-relevant dependency under [CONTRIBUTING.md](../../CONTRIBUTING.md#dependency-policy), shipped to every browser that loads the app.

The CLI adapter's transport [memory](../spec/TRANSPORT_BOUNDS.md) and [liveness](../spec/TRANSPORT_LIVENESS.md) bounds live in `apps/cli`, not core, so a browser client needs its own counterpart of each.

### Host-key verification

[Host-key verification](../spec/SFTP_CONNECTION.md#sftp-host-key-verification) is scoped to the CLI `sftp` channel, so a browser path needs a client that exposes the raw host-key blob before authentication.
Core's fingerprint computation and match run on WebCrypto (`packages/core/src/utils/sshHostKey.ts`), so the comparison can run in the tab, and the CLI's first-use prompt becomes a confirm step.
With a raw relay the browser observes the real server's key, so cross-party host-key reconciliation works as on the CLI.
With a terminating proxy the browser observes none and reconciles to no divergence (`packages/core/src/hostKeyReconciliation.ts`), losing the check that catches a one-sided interception.

### Credentials

The `sftp` connection authenticates with a password or a private key (`SFTPServer` in `packages/core/src/config/connection.ts`).

- A one-off exchange keeps the credential in the tab's memory for the run.
- A recurring managed exchange either stores the credential in browser storage, adding a long-lived server credential to the [hosted at-rest threat model](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges), or takes it at each run, which keeps nothing at rest and means a scheduled run cannot complete unattended.
  No recommendation; this applies only if the public app gets the path.
- Whether a client can read an OpenSSH private key, and sign through WebCrypto or its own code, is unverified.

### Egress and disclosure documents

The planned `connect-src` allowlist would need the proxy origin ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#egress-hardening-and-its-limits)), and the privacy statement's supporting-services list a proxy row ([PRIVACY.md](../../PRIVACY.md#what-supporting-services-can-observe)).

## The chosen client: dependency check and sizing

The maintainer chose `@microsoft/dev-tunnels-ssh` on 2026-10-29, with S8's three additions (an Ed25519 host-key verifier, the non-extractable key set on an undeclared field, a 120-line SFTP client) rewritten as owned code, on two conditions:
it passes the [dependency policy](../../CONTRIBUTING.md#dependency-policy)'s licence and maintenance check, and the whole client is sized.
Both were measured on 2026-10-30.

**Result: the licence check passes, the maintenance check does not.**
The library passes both; nine of the ten packages it adds to the browser bundle have no release in the last two years, four of them a key-agreement chain.
Whether to accept them, remove some, or wait is the maintainer's decision, and the client items stay parked until it is made.

### What it adds to the browser bundle

`@microsoft/dev-tunnels-ssh` 3.12.42 was installed outside the repository (`npm install --omit=dev`, 13 packages), and an entry importing `SshClientSession`, `SshSessionConfiguration`, `SshAlgorithms`, `SshChannel` and `BaseStream` was bundled with the repository's esbuild (`--platform=browser --minify`, its metafile read per package).

- **Bundled:** 11 packages, 328.4 KiB minified and 78.3 KiB gzipped.
  `debug` and `ms` are declared dependencies, but the library's code requires neither, and the bundle has no part of them.
- **Not resolved for the browser:** `stream`, which `sshStream.js` and `secureStream.js` extend (`stream.Duplex`) when they load.
  esbuild refused it, and the web application provides none, so the client item adds a stream implementation, a package not checked here.
  One candidate, `readable-stream` 4.8.0, is MIT, was last modified on 2026-10-08, and brings `buffer` 6, `events`, `process`, `string_decoder` and `abort-controller`.
- **Marked external to complete the bundle:** `crypto` (the library's `algorithms/node/` and `brorand`), `net`, `path` and `os` (`vscode-jsonrpc`'s pipe and socket support), and `node-rsa`, a dynamic `require` in `algorithms/node/nodeRsa.js` that the library does not declare.
  The library picks its WebCrypto classes when `self` and `crypto.subtle` exist (`algorithms/sshAlgorithms.js`); that a browser run reaches none of these modules was not driven.
- **With `diffie-hellman` stubbed** by a module that throws: `diffie-hellman`, `bn.js`, `miller-rabin`, `brorand`, `randombytes` and `safe-buffer` leave the bundle, which falls to 271.2 KiB minified and 62.8 KiB gzipped.
  The stub can work only if the session offers the ECDH key exchanges alone; that a session negotiates and completes with it was not driven.
- **`vscode-jsonrpc`:** the library's code uses only `CancellationToken`, `CancellationTokenSource` and `Emitter` from it (counted with `grep`), so an owned replacement aliased in at build time is possible; it was not tried.

### Licence and maintenance, per package

Sources: `npm view` (licence, release dates) and `gh api` (repository state), both on 2026-10-30.
"Maintained" means a release of the bundled major line in the last 24 months.
"Policy" means a `SECURITY.md` in the repository or the owner's default `.github` repository.

| Package | Bundled | Licence | Released | Latest | Last push | Policy | Maintained |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `@microsoft/dev-tunnels-ssh` | 3.12.42 | MIT | 2026-08-24 | same | 2026-10-28 | yes | yes |
| `vscode-jsonrpc` | 4.0.0 | MIT | 2018-09-11 | 10.0.0, 2026-10-22 | 2026-10-30 | yes | no: the library's range is `^4.0.0` |
| `buffer` | 5.7.1 | MIT | 2020-11-04 | 6.0.3, 2020-11-23 | 2025-10-28 | no | no |
| `base64-js` | 1.5.1 | MIT | 2020-11-11 | same | 2024-07-25 | no | no |
| `ieee754` | 1.2.1 | BSD-3-Clause | 2020-10-27 | same | 2021-08-12 | no | no |
| `safe-buffer` | 5.2.1 | MIT | 2020-05-10 | same | 2023-06-03 | no | no |
| `diffie-hellman` | 5.0.3 | MIT | 2018-04-11 | same | 2024-12-21 | yes (org) | no |
| `miller-rabin` | 4.0.1 | MIT | 2017-09-27 | same | 2021-02-02 | no | no |
| `brorand` | 1.1.0 | MIT | 2017-02-22 | same | 2018-06-09 | no | no |
| `randombytes` | 2.1.0 | MIT | 2019-02-19 | same | 2024-12-21 | yes (org) | no |
| `bn.js` | 4.12.5 | MIT | 2026-07-09 | 5.2.5, 2026-07-09 | 2026-07-09 | no | yes |

- **Licence:** every package is MIT or BSD-3-Clause, both compatible with Apache 2.0, and none ships a `NOTICE` file to fold in.
  The `@microsoft/dev-tunnels-ssh`, `brorand` and `miller-rabin` tarballs ship no licence file, and GitHub detects no licence in the `brorand` and `miller-rabin` repositories, so for those two the MIT terms are stated only in `package.json`.
- **Audit:** `npm audit --omit=dev` over the 13 packages reported no vulnerabilities.
- **The library's repository:** not archived; 43 commits since 2026-01-01, the latest on 2026-10-28; five npm releases in 2026; 9 open issues and pull requests.
  Pull request 124, which adds `ssh-ed25519` public-key support, has been open since 2026-03-06 with no later update, so the Ed25519 verifier stays owned code.
- **Cryptographic dependencies:** `diffie-hellman` is a key-agreement library, and `miller-rabin`, `brorand` and `randombytes` serve it, so the policy's [cryptographic-dependency](../../CONTRIBUTING.md#dependency-policy) review applies to them as well as to the library.
- **Exact pin:** the library pins exactly (`"3.12.42"`).
  Its manifest gives each dependency as a caret range, so their versions are fixed only by the lockfile, or by an `overrides` entry.

### What the client needs on the wire

Each `FileTransportClient` member (`packages/core/src/connection/fileSyncConnection.ts`), the SFTP version 3 requests it sends, and the CLI adapter's bound it takes over (`apps/cli/src/connection/`; the figures are in [TRANSPORT_BOUNDS.md](../spec/TRANSPORT_BOUNDS.md) and [TRANSPORT_LIVENESS.md](../spec/TRANSPORT_LIVENESS.md)):

| Member | Requests (replies) | Bound |
| --- | --- | --- |
| `connect` | SSH session, the `sftp` subsystem on a session channel, INIT (VERSION) | Connect probe: one window per attempt; the host key checked before authentication |
| `end` | CLOSE of open handles, then the channel and session | Returns within seconds |
| `list` | OPENDIR (HANDLE), READDIR until EOF (NAME, STATUS), CLOSE | Listing: 8,192 entries and 255-byte names; liveness: 16,384 READDIRs and 60 s for the whole listing; the handle closed on failure |
| `get` | OPEN for read (HANDLE), READ at rising offsets until EOF (DATA, STATUS), CLOSE | Frame size: `maxBytes` refused before it is allocated, and a DATA reply longer than requested refused; liveness: 60 s idle between chunks |
| `put` | OPEN to write, create and truncate (HANDLE), WRITE per 64 KiB chunk (STATUS), CLOSE | Liveness: 60 s without upload progress; a retry only on `SSH_FX_FAILURE` |
| `delete`, `safeDelete` | REMOVE (STATUS); `safeDelete` never rejects | Liveness: 60 s per operation |
| `rename` | RENAME (STATUS) | Liveness: 60 s per operation |
| `createExclusive` | OPEN to write, create and fail if present (HANDLE or STATUS), CLOSE; on `SSH_FX_FAILURE`, STAT to tell a present file from an I/O error | Liveness: 60 s per operation; a present file reported as `EEXIST` |
| `exists` | STAT (ATTRS, or STATUS no-such-file for `false`) | Liveness: 60 s per operation |
| `releaseForIdle`, `ensureConnected`, `beginTeardown` | Optional; left out, the session lasts the whole run | None |
| Heartbeat (adapter, not interface) | REALPATH of `.` after 60 s idle | None |

In total: 11 request types (INIT, OPEN, CLOSE, READ, WRITE, OPENDIR, READDIR, REMOVE, RENAME, STAT, REALPATH) and 6 replies (VERSION, STATUS, HANDLE, DATA, NAME, ATTRS).
S8's client sent five of them: INIT, OPEN, WRITE, READ and CLOSE.
The CLI adapter sets no SFTP packet-length bound of its own; the listing bound leans on the SSH transport's maximum packet size for one READDIR reply ([TRANSPORT_BOUNDS.md](../spec/TRANSPORT_BOUNDS.md#directory-listing-bound)).
The browser client reassembles SFTP packets from channel data itself, and each packet declares its own length, so without a cap of its own a server chooses the allocation.
That cap is a frame-size control, and it brings the SSH client item under security review in its own right.

Core's file-sync engine uses Node's global `Buffer` (`fileSyncConnection.ts`, `fileSyncFraming.ts`, `fileSyncMessageLoop.ts`, `abortMarker.ts`, `controlEnvelope.ts`), and the web application defines none.
`FileSyncConnection` has never run in a browser, so whether it needs more than a `Buffer` global is not known.

### Sizing

Projected changed lines count added and removed non-test lines, excluding `package-lock.json`.
Each figure is an estimate built up from its parts, with the basis given; nothing here has been built.

| Item | Part | Lines | Basis |
| --- | --- | --- | --- |
| SSH client on `dev-tunnels-ssh` | Library stream over a browser WebSocket | 80-150 | none in the repository; a byte stream, not the relay client's message connection |
| | Session: WebCrypto-only algorithm lists, connect window, host key before authentication, key authentication, named error for no common algorithm, subsystem open | 200-260 | S8 did this in spike code whose size it did not record |
| | Ed25519 verifier | 80-100 | S8: about 70 |
| | Non-extractable key in the library's ECDSA pair | 40-60 | S8: an assignment after `setPublicKeyBytes` |
| | SFTP v3 client: 11 requests, 6 replies, request ids, packets across channel data, inbound packet cap, status codes | 400-500 | S8: about 120 for five requests |
| | Exact pin, `stream` implementation, Node-only module stubs, optional `diffie-hellman` stub | 20-40 | the bundle above |
| | **Total** | **820-1,110** | |
| File transport client | The 11 members over the SFTP client | 450-550 | the CLI adapter's members, recovery wiring included: 779 lines |
| | Bound errors and constants, copied into the web app | 150-200 | `listingGuard.ts`, `sftpLivenessGuard.ts`, `frameSizeGuard.ts`, `causeLink.ts` |
| | Heartbeat and slow-operation warning | 110-140 | `sftpHeartbeat.ts`: 143 lines |
| | `Buffer` global, and a session drop as a stated limit in `SFTP_SESSION_RECOVERY.md` | 20-40 | |
| | **Total, a session drop ending the run** | **730-930** | |
| | Session recovery: re-dial, re-issue, the deferred-cleanup record, the transition lock, the idle release | 1,000-1,500 more | the CLI's: `sftpSessionState.ts`, `sftpDeferredCleanup.ts`, `sftpIdleBoundary.ts`, `sftpAdapterLedger.ts` (738 lines) and about 1,400 lines of the adapter's session lifecycle |
| Host-key pin in the browser | Pin storage with the exchange, first-use confirmation, mismatch refusal, rotation pins, reconciliation | 350-550, coarse | core's `sshHostKey.ts` and `hostKeyReconciliation.ts` are reused |
| Browser key pair for scheduled runs | Key generation and storage, `authorized_keys` display, deletion with the exchange | 250-400, coarse | the non-extractable key part above |

Proposed splits:

- **File transport client, with recovery: 1,730-2,430, past the ~1,200 line.**
  Split it into the client with its bounds, a dropped session ending the run as a stated limit in [SFTP_SESSION_RECOVERY.md](../spec/SFTP_SESSION_RECOVERY.md) (730-930), and the session recovery as an item of its own, sized again before it is built.
  If that item still projects past the line, re-dial and re-issue split from the deferred-cleanup record and the idle release.
- **Moving the bound errors to core** instead of copying them counts each moved line twice and adds the CLI's import edits, about 450-650 changed lines.
  That would be its own refactor ahead of the client, with the CLI's behavior unchanged.
- **SSH client: 820-1,110, under the line.**
  If it runs over, the SFTP v3 client is the part to split off: it is protocol code that unit tests can cover without a browser.

## Channel security

[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it) names a WebSocket-to-TCP proxy as the case that would revisit the web side's refusal of the wrap.
How that reads for each proxy shape:

- **Where SSH's encryption ends.**
  A raw relay forwards SSH without terminating it, as a TURN relay forwards DTLS; TLS on the `wss` leg is an extra layer under SSH.
  A terminating proxy ends SSH and sits inside the channel.
- **What the proxy can see.**
  A raw relay sees addresses, the target, timing and volume, and the SSH version strings and algorithm negotiation sent before encryption (RFC 4253 sections 4.2 and 7.1; advisory, not checked here).
  A terminating proxy also holds the SFTP credential and reads every file: the rendezvous files, the handshake frames and abort marker outside the wrap, and on a quick exchange everything.
- **The wrap.**
  The `sftp` channel requests the wrap whatever the client, so any browser SFTP path, not only a terminating one, needs the web side to apply it on `sftp`, as it does on `webrtc`.
  Core's wrap runs on WebCrypto (`packages/core/src/connection/encryptedMessageConnection.ts`), and the web application runs it on every WebRTC exchange.
- **Quick exchanges.**
  A quick exchange relies on SSH alone, which a raw relay leaves intact; a terminating proxy could read it, so a quick exchange would be refused there.

This is why the note recommends against a terminating proxy: a party that holds the credential and reads the out-of-wrap files, no host-key reconciliation, and no quick exchanges.
The spec rows the implementation would change are changed with it, not by this note.

## Forks

Each is left open for the maintainer; the linked section carries the argument.

1. **Which application gets a browser SFTP path**: neither, console only, or the public web application too.
   No recommendation; a product decision ([Two product questions come first](#two-product-questions-come-first)).
2. **Where the proxy runs**: console container, project-hosted, or operator-run.
   Operator-run, if the public app gets the path ([Where the proxy runs](#where-the-proxy-runs)).
3. **What the proxy speaks**: raw byte relay, framed protocol, or terminating proxy.
   Raw byte relay; that a standard proxy serves is unverified until the backpressure and close-mapping spike ([Framing](#framing)).
4. **How the target is chosen**: fixed per endpoint, or per request against an allowlist.
   Fixed per endpoint ([How the target is chosen and restricted](#how-the-target-is-chosen-and-restricted)).
5. **How the browser authenticates to the proxy**: origin check, static token, or per-exchange credential.
   Origin check always; a token is open ([Authentication of the browser to the proxy](#authentication-of-the-browser-to-the-proxy)).
6. **Where the proxy setting lives**: the exchange file, or a browser-local setting.
   Browser-local ([Which client reads the proxy setting](#which-client-reads-the-proxy-setting)).
7. **The browser SSH client**: `ssh2` bundled, a WebAssembly C library, or another JavaScript client.
   Ruled 2026-10-29: `@microsoft/dev-tunnels-ssh`, on a dependency check and a sizing whose result is open ([The chosen client](#the-chosen-client-dependency-check-and-sizing)).
8. **SFTP credentials for recurring browser exchanges**: stored in browser storage, or entered each run.
   No recommendation ([Credentials](#credentials)).
