---
title: "The Browser SFTP Path and its WebSocket-to-TCP Proxy"
---

# The browser SFTP path, and the WebSocket-to-TCP proxy it needs

_Status: design only; nothing here is decided or built.
The note frames what a browser SFTP path would need, recommends where it can, and lists the choices left open for the maintainer.
Nothing here is normative: the channel-security rules are in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it),
the host-key rules in
[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#sftp-host-key-verification),
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
The last one, an optional `proxy` object on the `sftp` connection with `host`, `port`, `path`, and an HTTP `auth` block, was read by no client and was removed in commit `adf3854d1`;
its shape is in that commit's diff of `packages/core/src/config/connection.ts`.
This note is the design that would decide whether a field returns, and in what form.

## Two product questions come first

Whether a browser SFTP path exists, and for which application, is a product decision.
It is framed under [Forks](#forks) as the first fork, and the rest of the note applies under either answer.
Two facts bear on it:

- **The console does not need a proxy to run SFTP.**
  Its server already opens the socket through the CLI subprocess, and the planned in-process path would also run in the server process, not the tab
  ([DESIGN.md](../DESIGN.md#web-console)).
  A proxy in the console would let the tab be the SSH client instead, and no console workflow needs that today.
- **The public web application is the one that lacks a route to an SFTP server.**
  A browser SFTP path there would let a hosted-app party exchange with a partner who uses SFTP, and would let a recurring managed exchange run over SFTP on the app's schedule.
  It also changes the public app's stated scope, which `CLAUDE.md` (Applications) gives as WebRTC only.

## What the proxy speaks

### Framing

Three shapes are possible.

- **Raw byte relay.**
  Each WebSocket binary message is a chunk of the TCP byte stream, in either direction, with no meaning in the message boundaries.
  The proxy opens one TCP connection per WebSocket and closes each when the other closes.
  SSH runs end to end between the browser and the SFTP server; the proxy forwards SSH traffic it cannot decrypt.
  This is the shape `websockify` is commonly described as implementing (unverified here: run `websockify` in front of the SFTP test server from [TESTING.md](../TESTING.md#integration-tests) and drive an SSH client through it).
- **Framed protocol.**
  A small header message ahead of the relay -- a target selection, an authentication token, or both -- and raw relay after it.
  It is needed only if the target is chosen per connection or the token cannot travel in the upgrade request.
  It rules out an off-the-shelf raw relay.
- **Terminating proxy.**
  The proxy is itself the SSH and SFTP client, and the browser speaks a file API (list, get, put, delete) to it.
  This removes the need for an SSH client in the browser, at the cost below under [Channel security](#channel-security): the proxy is given the SFTP credential and sees everything SSH alone protects.

The recommendation is the raw byte relay, with the target fixed by the proxy's own configuration (below), so that the proxy is a TCP forwarder and a standard one can be deployed.
Two behaviors a raw relay must get right, both unverified for any specific proxy:

- **Backpressure.** The proxy pauses reading from TCP while its WebSocket send buffer is full, and the reverse.
  Without it a slow browser makes the proxy buffer without bound.
- **Close mapping.** A TCP close or reset closes the WebSocket, and a WebSocket close ends the TCP connection, so a stalled side is detected by the browser client's own liveness bounds rather than hanging.

### Authentication of the browser to the proxy

The SFTP server's own SSH authentication applies through any raw relay, so the proxy's authentication decides who may reach the SFTP server's SSH port, not who may read the exchange.
Options:

- **No credential, origin-checked.**
  The proxy refuses an upgrade whose `Origin` header is not the web application's origin, and otherwise forwards to its one fixed target.
  This exposes the SSH port about as widely as publishing port 22 does, and blocks other web pages from using the proxy from a visitor's browser.
  The `Origin` header is sent by browsers on every WebSocket upgrade and cannot be set by page script (RFC 6455 section 10.2 and the WHATWG Fetch standard; unverified here: probe it from the browser suite against a test proxy).
  A non-browser client can send any `Origin`, so this check bounds browser-delivered pages only.
- **A static token.**
  The browser WebSocket API sets no custom request headers (WHATWG WebSockets standard; unverified here), so a token travels in the URL query, in the `Sec-WebSocket-Protocol` value, in a cookie, or in a first message under the framed protocol.
  A URL token reaches access logs; a subprotocol value is limited to the HTTP token character set (RFC 6455 section 4.1; unverified here).
- **A per-exchange credential.**
  Derived from the exchange's shared secret and registered with the proxy, the way a relay credential is derived and registered for a TURN relay
  ([PROTOCOL.md](../spec/PROTOCOL.md#relay-credential-derivation)).
  It scopes access to the parties of one exchange, and is unavailable to a quick exchange, which has no shared secret.

The note recommends the origin check as mandatory on every proxy shape, and leaves whether to add a token open (fork 5).

### How the target is chosen and restricted

- **Fixed target.**
  One proxy endpoint forwards to exactly one `host:port`, set in the proxy's own configuration by whoever runs it.
  The WebSocket request names no target, so nothing a browser sends can change where the proxy connects.
  A party that needs two SFTP servers runs two endpoints (two paths or two ports).
- **Target in the request, checked against an allowlist.**
  The request names a `host:port` and the proxy refuses any pair not on its list.
  The check runs on the name the proxy resolves itself, and also refuses a name that resolves to a loopback, link-local, or private address unless that address is itself listed, so a DNS change cannot point an allowed name at an internal service.

The recommendation is the fixed target: it needs no framing, no allowlist parser, and no resolution rule.

## How the proxy bounds what browser-delivered content can reach

`CLAUDE.md` (Applications) makes a control that constrains only remote or browser-delivered content the operator cannot inspect a hard refusal, not a warning.
Two kinds of content reach a proxy, and both are in that class:

- **The WebSocket upgrade itself.**
  Any page open in any browser that can reach the proxy can attempt an upgrade, and a cross-origin WebSocket is not blocked by the same-origin policy (unverified here; the browser-suite probe above verifies it).
  Without a bound, a proxy inside an agency network lets any visited web page reach hosts and ports behind that network's firewall.
- **The invitation's SFTP endpoint.**
  An `sftp` invitation names a `host` and an optional `port` chosen by the inviting partner (`SFTPEndpoint` in `packages/core/src/config/invitation.ts`).
  An accepting browser party that dialed whatever the invitation named would let the partner choose where the proxy connects.

The bound, applied as a refusal in each case:

1. The proxy connects only to its configured target (or allowlist), and refuses an upgrade that names any other target or comes from another origin.
   No request content widens it.
2. The browser client refuses to run when the SFTP endpoint it was given, from the invitation or from the operator's own connection, is not the target of the proxy it is configured to use.
   The refusal names both values and tells the operator to fix the proxy setting or the connection.
3. An invitation never names a proxy.
   The invitation endpoint schemas are strict and refuse an unknown key (`packages/core/src/config/invitation.ts`), and a re-added proxy field stays off them, so a partner cannot choose who relays a party's SSH traffic.

What the operator chooses for themselves -- which proxy to use, a proxy run by another organization, a token kept in browser storage -- is warn-and-guide under the same `CLAUDE.md` rule:
the app warns, for instance, that a proxy run by another organization learns which SFTP server this party uses and when, and proceeds.

## Where the proxy runs

Three places, each against the application scopes in `CLAUDE.md` (Applications):

- **Inside the console container.**
  The console's server answers a WebSocket upgrade and relays to the one SFTP connection the operator authored.
  - The target is fixed by construction: the server composes it from the authored connection, as it composes every CLI input
    ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#single-party-console-trust-boundary)).
  - The upgrade needs the same browser-CSRF gate the job routes have -- the cross-origin refusal and the loopback `Host` check ([SERVER_JOB_API.md](../spec/SERVER_JOB_API.md#browser-csrf-gate)) -- applied to the upgrade request, since a page the operator visits could otherwise open a WebSocket to the loopback port.
    The console server bounds the pre-upgrade handshake already (`apps/web/server/upgradeHardening.ts`) but serves no WebSocket route (`apps/web/server/console/app.ts`).
  - It adds no new egress: the container's one outbound endpoint is the same SFTP server
    ([DEPLOYMENT.md](../DEPLOYMENT.md#restricting-the-containers-outbound-network-access)).
  - It serves only the console, which already runs SFTP natively, so on its own it enables nothing new.
- **A hosted service the project runs.**
  - It is the only shape that lets a hosted-app party use SFTP with nothing to deploy.
  - It puts the project in the path of every browser SFTP exchange: client addresses, which SFTP server each party uses, timing and volume.
    The project runs no supporting service but peer coordination as a default ([COMMUNICATION.md](../COMMUNICATION.md#supporting-services)), and a TURN relay used only when a party names it ([SHARED_RESPONSIBILITY.md](../SHARED_RESPONSIBILITY.md#third-party-supporting-services)).
  - A fixed target is impossible for a service shared by every party, so it needs the per-request target and allowlist shape, and an open target list makes it a TCP relay for anyone.
- **Operator-run.**
  The party that runs the SFTP server, or the browser party's own organization, runs a proxy with the SFTP server as its fixed target, at its network edge.
  - It matches how the other optional supporting services are run: by a party, who answers for it ([SHARED_RESPONSIBILITY.md](../SHARED_RESPONSIBILITY.md#third-party-supporting-services)).
  - It needs a reference configuration, which the roadmap already lists for the proxy in version 1.1 ([ROADMAP.md](../ROADMAP.md#version-11); [DEPLOYMENT.md](../DEPLOYMENT.md#websocket-to-tcp-proxy)).
  - The browser party may not be the party that runs the SFTP server, so a browser acceptor of a partner's server depends on the partner having deployed a proxy, or on its own organization running one with the partner's server as its target.

The recommendation, if the public application gets the path, is operator-run, with a reference configuration and a console-container proxy built only if a console workflow comes to need an in-tab SFTP client.

## Which client reads the proxy setting

Only a browser SFTP client needs a proxy; the CLI and the console's CLI subprocess connect natively.
The proxy is a property of where a party's client runs, not of the exchange, so the two parties' settings differ even for one shared server
([COMMUNICATION.md](../COMMUNICATION.md#websocket-to-tcp-proxy)).
Two places for the setting:

- **A re-added `connection.proxy` in the exchange file**, read by the web application's SFTP driver.
  - The CLI then has a field it does not use.
    Ignoring it is what made the removed field inert, so the CLI would refuse a configuration that names one, saying that the CLI connects directly and the field applies to a browser party only.
  - The console's configuration load refuses a setting its composition writes no key for inside a block it writes ([SERVER_JOB_API.md](../spec/SERVER_JOB_API.md#what-it-refuses)), so it would refuse the field too unless the console grows an in-tab SFTP path.
- **A browser-local party setting**, outside the exchange file: a build-time value as the coordination server is ([DEPLOYMENT.md](../DEPLOYMENT.md#coordination-server)), an entry in the browser's own settings as the TURN relay is, or both.
  - No exchange file or invitation names it, so no other client ever sees it, and the CLI needs no refusal.
  - A saved, recurring exchange in the web application would store which proxy it uses beside its other browser-held settings.

The recommendation is the browser-local setting: it puts the value where the only reader is, and keeps the shared configuration format free of a field one application uses.

## The browser SFTP exchange, end to end

### The SSH client in the browser

The client must speak SSH and SFTP over a WebSocket-backed byte stream and implement core's file transport interface (`FileTransportClient` in `packages/core/src/connection/fileSyncConnection.ts`), so the rest of the file-sync stack -- rendezvous, framing, the message loop, the abort marker -- runs unchanged above it.
Candidates, none verified in the browser:

- **`ssh2` bundled for the browser**, given a WebSocket-backed duplex through its `sock` option (the option is named in `packages/core/src/connection/sftpConnect.ts`).
  Whether it runs in a browser bundle at all, given its use of Node APIs, is unverified: build it into a browser bundle and drive it against the SFTP test server through a raw relay from the browser suite.
- **A C SSH library compiled to WebAssembly.**
  Unverified: which libraries build, their SFTP coverage, and how they would receive a WebSocket stream.
- **Another JavaScript SSH client.**
  Unverified: whether one exists with SFTP support, a host-key callback before authentication, and maintenance the dependency policy would accept.

Whichever is chosen is a new security-relevant dependency under [CONTRIBUTING.md](../../CONTRIBUTING.md#dependency-policy), shipped to every browser that loads the app.

The CLI's adapter has defenses that sit in the CLI, not in core, and a browser client needs its own:
per-operation deadlines and the slow-operation warning (`apps/cli/src/connection/sftpLivenessGuard.ts`),
the directory-listing caps (`apps/cli/src/connection/listingGuard.ts`),
the inbound frame-size cap (`apps/cli/src/connection/frameSizeGuard.ts`),
the session heartbeat (`apps/cli/src/connection/sftpHeartbeat.ts`),
and the key-exchange capability check (`apps/cli/src/connection/sftpKexCapability.ts`).
The specification of each is in [CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#transport-memory-and-liveness-bounds).

### Host-key verification

The pin and its fail-closed default apply to the CLI `sftp` channel only
([CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#sftp-host-key-verification)).
A browser path must enforce the same rule before any credential is sent, which requires a client that exposes the raw host-key blob before authentication.
Core's fingerprint computation and match use WebCrypto (`computeHostKeyFingerprint` and `matchHostKeyFingerprint` in `packages/core/src/utils/sshHostKey.ts`, over `packages/core/src/utils/crypto.ts`), so the comparison itself can run in the tab.
The first-use flow, which the CLI runs as an interactive prompt, becomes a confirm step in the browser.
With a raw relay the browser observes the real server's key, so cross-party host-key reconciliation works as on the CLI.
With a terminating proxy the browser observes none and reconciles to no divergence (`packages/core/src/hostKeyReconciliation.ts`), which removes the check that catches a one-sided interception.

### Credentials

The `sftp` connection authenticates with a password or a private key (`SFTPServer` in `packages/core/src/config/connection.ts`).
In the browser:

- A one-off exchange keeps the credential in the tab's memory for the run.
- A recurring managed exchange that runs on a schedule needs the credential at rest in browser storage, which adds a long-lived server credential to what the hosted at-rest threat model covers
  ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges)).
- Reading an OpenSSH private key, and whether its signature algorithms are available through WebCrypto or need the client's own code, depends on the client and is unverified.

### Egress and disclosure documents

The planned `connect-src` allowlist would need the proxy origin ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#egress-hardening-and-its-limits)), and the privacy statement's list of supporting services would need a proxy row ([PRIVACY.md](../../PRIVACY.md#what-supporting-services-can-observe)).

## Channel security

[CHANNEL_SECURITY.md](../spec/CHANNEL_SECURITY.md#which-channels-request-it) names a WebSocket-to-TCP proxy as the one case that would put a third party inside a confidential channel, says the request bit is how the party behind it would ask for the application-layer wrap, and says the web side's refusal of a true request is what would be revisited.
How that reads for each proxy shape:

- **Where SSH's encryption ends.**
  With a raw relay, SSH runs from the SFTP client in the tab to the SFTP server, and the proxy forwards it without terminating it, as a TURN relay forwards DTLS.
  TLS on the `wss` leg ends at the proxy, but it is an extra layer under SSH, not the one that protects the exchange.
  With a terminating proxy, SSH ends at the proxy, and the proxy is inside the channel.
- **What the proxy can see.**
  A raw relay sees each party's network address, the target, timing and volume, and the parts of SSH sent before encryption starts: the version strings and the algorithm negotiation (RFC 4253 sections 4.2 and 7.1; advisory, not checked here).
  A terminating proxy is also given the SFTP credential, and reads every file the exchange writes: the rendezvous files, the key-exchange handshake frames and the abort marker that sit outside the wrap, and on a quick exchange the whole exchange in cleartext.
- **Whether the wrap request bit applies.**
  The `sftp` channel requests the wrap whatever the client, because the server's administrator can read the files (the table in that section).
  So a browser party on `sftp` requests it under either proxy shape, and the web application, which refuses a peer's true request today (`apps/web/src/psi/authenticateExchange.ts`), would have to apply the wrap on `sftp` while keeping the `webrtc` refusal.
  Core's wrap imports its keys and encrypts through WebCrypto (`crypto.subtle` in `packages/core/src/connection/encryptedMessageConnection.ts`), so it is not tied to Node; no browser exchange runs it yet, so that it works there is unverified.
  The revisit that paragraph names is therefore needed for any browser SFTP path, not only for a proxy that terminates.
- **Quick exchanges.**
  A quick exchange has no session key and relies on SSH alone.
  Through a raw relay that protection is unchanged.
  Through a terminating proxy the exchange would be readable by the proxy, so a quick exchange would be refused there, as one is refused under a DTLS-terminating WebSocket relay ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security)).

This is the main reason the note recommends against a terminating proxy: it adds a party that sees the credential and the out-of-wrap files, removes the host-key reconciliation check, and makes quick exchanges impossible on that path.

The spec text the implementation would change -- the web-side refusal in the wrap table and the CLI-only scope of host-key verification -- is changed with the implementation, not by this note.

## Forks

Each choice below is left open for the maintainer.

### 1. Product scope: which application gets a browser SFTP path

- **Neither.**
  SFTP stays with the CLI and the console's CLI subprocess, and the hosted app keeps writing an exchange file.
  Nothing to build; a hosted-app party whose partner uses SFTP keeps running the CLI.
- **Console only.**
  A proxy in the console container and an in-tab SFTP client there.
  The console already runs SFTP natively, so this buys nothing a workflow needs today, and still costs the browser SSH client, the wrap on the web side, and a WebSocket route on the console server.
- **Public web application too.**
  A hosted-app party can exchange over SFTP and run a recurring managed SFTP exchange on the app's schedule.
  It changes the public app's WebRTC-only scope in `CLAUDE.md` (Applications), ships an SSH client to every browser, adds an SFTP credential to browser storage for recurring use, and needs a proxy the party can reach (fork 2).

No recommendation: this is a product decision.

### 2. Where the proxy runs

- **Console container**: fixed target by construction, loopback only, no new egress; serves only the console.
- **Project-hosted**: no deployment for parties; puts the project in every browser SFTP exchange's path and needs a per-request target allowlist.
- **Operator-run**: fixed target, run by a party that answers for it; each party, or its partner, must deploy one.

Recommendation: operator-run, with a reference configuration, if the public app gets the path.

### 3. What the proxy speaks

- **Raw byte relay**: off-the-shelf proxies apply; SSH stays end to end.
- **Framed protocol**: allows a per-request target or in-band token; needs a proxy of the project's own.
- **Terminating proxy**: no browser SSH client; the proxy sees the credential and out-of-wrap files, removes host-key reconciliation, and rules out quick exchanges.

Recommendation: raw byte relay.

### 4. How the target is chosen

- **Fixed per endpoint**: nothing in a request can change the target.
- **Per-request target against an allowlist**: one endpoint serves several servers; needs the allowlist, resolution checks, and a framed or query-string target.

Recommendation: fixed per endpoint.

### 5. How the browser authenticates to the proxy

- **Origin check only**: no secret to manage; bounds browser pages, not other clients, and exposes the SSH port about as publishing it would.
- **Static token**: limits use to holders of the token; the token sits in browser storage and travels in a query string, subprotocol value, cookie, or first message.
- **Per-exchange derived credential**: scopes use to one exchange's parties; needs a registration step like the relay registrar's, and no quick exchange can use it.

Recommendation: the origin check on every shape; whether to add a token is open.

### 6. Where the proxy setting lives

- **A re-added `connection.proxy` in the exchange file**: one place for every connection setting; the CLI and the console's job API must refuse it.
- **A browser-local party setting**: only the reader sees it; no exchange-file or invitation change.

Recommendation: browser-local. An invitation never names a proxy under either option.

### 7. The browser SSH client

- **`ssh2` bundled for the browser**, **a WebAssembly build of a C library**, or **another JavaScript client**.
  Every candidate's browser behavior is unverified.

No recommendation until a spike drives a candidate against the SFTP test server through a raw relay.

### 8. SFTP credentials for recurring browser exchanges

- **Stored in browser storage** for scheduled runs, under the hosted at-rest threat model.
- **Entered for each run**, which keeps no credential at rest and means a scheduled run cannot complete unattended.

No recommendation; applies only if the public app gets the path.

## Implementation items the design implies

Listed for the maintainer, not filed.
Which apply depends on forks 1 to 3.

- **Spike the browser SSH client** -- bundle the chosen candidate, drive it through a raw relay against the SFTP test server from the browser suite, and record the host-key callback, key formats, and SFTP coverage.
- **Spike the raw relay** -- run an off-the-shelf WebSocket-to-TCP proxy in front of the SFTP test server and verify backpressure, close mapping, and the `Origin` refusal.
- **Browser file transport client** -- implement `FileTransportClient` over the chosen SSH client, with browser counterparts of the CLI adapter's liveness, listing, frame-size, and heartbeat defenses.
- **Wrap on the web side for `sftp`** -- apply the application-layer wrap on a browser `sftp` exchange and keep the `webrtc` refusal in `apps/web/src/psi/authenticateExchange.ts`.
- **Browser host-key pin and first use** -- enforce the pin before authentication, with a confirm step for first use, and advertise the observed key for reconciliation.
- **Proxy setting and its refusals** -- add the setting where fork 6 puts it, and the client-side refusal when the SFTP endpoint is not the proxy's target.
- **Exchange driver for browser SFTP** -- a new driver kind in `apps/web/src/psi/exchangeDriverSelection.ts` and the transport chooser's copy for it.
- **Console WebSocket route** -- only under the console-container option: an upgrade route on the console server, behind the browser-CSRF gate, relaying to the authored connection.
- **Reference proxy configuration** -- a deployable fixed-target proxy with the origin check, in the `DEPLOYMENT.md` section that names the proxy.
- **Credential at rest for managed SFTP exchanges** -- only under fork 8's storage option, with the at-rest threat model extended to cover it.
- **Documentation and spec** -- the wrap table and host-key scope in `CHANNEL_SECURITY.md`, the channel-security and console sections of `SECURITY_DESIGN.md`, the proxy sections of `COMMUNICATION.md` and `DEPLOYMENT.md`, the supporting-services rows in `PRIVACY.md` and `SHARED_RESPONSIBILITY.md`, the `connect-src` allowlist, and the Applications section of `CLAUDE.md` if the public app's scope changes.
- **Tests** -- a live browser SFTP exchange through the proxy in the browser suite, and a browser party against a CLI party on one SFTP server in the interop suite.
