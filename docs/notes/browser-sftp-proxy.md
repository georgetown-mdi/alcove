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

No candidate is recommended until a spike drives one against the SFTP test server through a raw relay from the browser suite.
Whichever is chosen is a new security-relevant dependency under [CONTRIBUTING.md](../../CONTRIBUTING.md#dependency-policy), shipped to every browser that loads the app.

The CLI adapter's [transport memory and liveness bounds](../spec/CHANNEL_SECURITY.md#transport-memory-and-liveness-bounds) live in `apps/cli`, not core, so a browser client needs its own counterpart of each.

### Host-key verification

[Host-key verification](../spec/CHANNEL_SECURITY.md#sftp-host-key-verification) is scoped to the CLI `sftp` channel, so a browser path needs a client that exposes the raw host-key blob before authentication.
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
  The `sftp` channel requests the wrap whatever the client, so any browser SFTP path, not only a terminating one, needs the web side to apply it on `sftp` while keeping the `webrtc` refusal.
  Core's wrap runs on WebCrypto (`packages/core/src/connection/encryptedMessageConnection.ts`), but no browser exchange runs it yet, so that it works there is unverified.
- **Quick exchanges.**
  A quick exchange relies on SSH alone, which a raw relay leaves intact; a terminating proxy could read it, so a quick exchange would be refused there, as under a DTLS-terminating relay ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security)).

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
   None until a spike ([The SSH client in the browser](#the-ssh-client-in-the-browser)).
8. **SFTP credentials for recurring browser exchanges**: stored in browser storage, or entered each run.
   No recommendation ([Credentials](#credentials)).
