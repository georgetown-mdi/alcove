---
title: "Keeping the vendored PeerJS broker rather than rewriting it"
---

# Keeping the vendored PeerJS broker rather than rewriting it

_Status: built.
The signaling broker in `packages/peerjs-broker` is kept, not replaced by a first-party two-peer rendezvous broker.
What is retired is the vendoring discipline, not the code: the tree is treated as this project's own.
The three follow-ons at the end are built; the optional renaming of `contrib/` is not taken.
See [docs/notes/README.md](README.md)._

Every figure below was measured at staging commit `013507bc4` on 2026-11-10.
The broker's bounds are specified in [SIGNALING_SERVER_BOUNDS.md](../spec/SIGNALING_SERVER_BOUNDS.md) and its wire in [WEBRTC_TRANSPORT.md, Broker socket](../spec/WEBRTC_TRANSPORT.md#broker-socket); this note restates neither.

## The question

`packages/peerjs-broker/src/contrib/` was vendored from [peerjs-server](https://github.com/peers/peerjs-server) in August 2025.
The choice is between keeping that tree and continuing to harden it, or writing a broker here for the one job Alcove gives it: getting two parties to an open WebRTC data channel.

One constraint applies to either answer.
The browser party runs the stock PeerJS client unchanged, and the project's broker keeps the wire of every supported release ([WEBRTC_TRANSPORT.md, Compatibility of the broker socket](../spec/WEBRTC_TRANSPORT.md#compatibility-of-the-broker-socket)).

## What Alcove uses of the vendored server

### The wire exercised

Two clients speak to the broker: the web app's PeerJS client (`peerjs` 1.5.5, `apps/web/src/psi/transport/rendezvous.ts`) and the CLI's own client (`apps/cli/src/connection/webrtc/brokerClient.ts`).
Between them they use every message type the broker knows (`MessageType` in `contrib/enums.ts`):

- one WebSocket at `<mount>/peerjs`, with `id`, `token` and `key` in the query, answered `OPEN` on registration;
- `ID-TAKEN` for an id held under another token, which the CLI maps to a role misconfiguration, and `ERROR` for a wrong key;
- `HEARTBEAT` every 5 seconds, against the broker's two reap windows;
- `OFFER`, `ANSWER`, `CANDIDATE` and `LEAVE` relayed with `src` stamped by the broker;
- the hold for a destination that has not registered yet, and the `EXPIRE` sent when nobody collects it: an acceptor routinely dials before the inviter has registered, and both clients redial on that answer (`weriftPeer.ts` in the CLI, the dial retry in `rendezvous.ts`).

Nothing of upstream's HTTP API is used.
The id and peers routes went with the move out of the web app, the standalone runner answers `404` to everything but an upgrade and `<mount>/health`, and both clients register an id they derive from the invitation.
A browser inviter completed an exchange through the standalone broker on 2026-10-03, with no id route anywhere ([webrtc-relay-deployment.md](webrtc-relay-deployment.md#does-the-coordination-server-leave-the-web-apps-deployment)).

The deployed broker (`infra/broker/alcove-broker.service`) runs the standalone entry point with `--path /api`, on `127.0.0.1:9411` behind the nginx front, and every other setting at its default, including the realm key `peerjs`.

### Code nothing reads

A `git grep -w` over every workspace finds no reader of:

- the `IConfig` fields `host`, `port`, `allow_discovery`, `proxied`, `ssl`, `generateClientId` and `corsOptions` (`contrib/config/index.ts`), and the `@types/cors` dev dependency kept only for the last;
- `Realm.generateClientId`;
- in `contrib/instance.ts`, the commented-out express builder and events interface, the empty `close` listener, and the `onClose` callback that does nothing.

`defaultConfig` is also merged twice, once in `contrib/index.ts` and again in `instance.ts`.
Together this is about 120 lines.

### Its size, and who wrote it

- **At import**, 2025-08-06: 1,031 lines of TypeScript in 17 files.
- **Now**: 1,739 lines in the same 17 files, 1,064 of them neither blank nor comment.
- **Drift**, ignoring whitespace (the import was reformatted by Prettier): +851 / -143 lines across 11 of the 17 files.
  The largest are `services/webSocketServer/index.ts` (+401), `models/messageQueue.ts` (+205) and `models/realm.ts` (+126).
  About half of the tree's lines are this project's.
- **Unchanged since import** apart from whitespace: the message routing under `messageHandler/` and `models/message.ts`, the two paths `eslint.config.mjs` excludes from linting.
- **Outside `contrib/`**, the package's first-party code is 1,107 lines: the standalone runner, its options and readiness endpoint, the deployment-status headers, the upgrade bounds and the diagnostics sink.
  Neither answer touches it.
- **Tests**: nine web unit test files and a harness, 4,074 lines, import `contrib/` modules by path (`Realm`, the `WebSocketServer` class, `MessageQueue`, `CheckBrokenConnections` and others).
  The CLI's WebRTC integration suite instead spawns the standalone runner and drives it over the wire (`apps/cli/test/integration/webrtc/broker.test.ts`, `brokerStandaloneSurface.test.ts` and others), so it does not depend on how the broker is built inside.

### Maintenance and security record

Upstream, queried on 2026-11-10 through the GitHub API and the npm registry:

- The last stable release of the npm package `peer` is 1.0.2, of 2023-12-05; the last prerelease is 1.1.0-rc.2, of 2024-05-04.
- Of the 491 commits on its default branch since 2023-06-01, the last that changed server behavior is of 2023-12-05; every later one is a dependency or lockfile update, or a build change.
  The repository is not archived.
- No GitHub advisory names `peer`.

The one runtime library besides core's `untrusted-text` subpath is `ws`.
It had two advisories in 2026, GHSA-58qx-3vcg-4xpx (fixed in 8.20.1) and GHSA-96hv-2xvq-fx4p (fixed in 8.21.0); the lockfile installs 8.22.0.
Node has no WebSocket server of its own, so `ws` stays under either answer.

This project has taken nothing from upstream since the import, and has sent nothing upstream.
Seventeen commits between 2026-06-18 and 2026-11-08 added its own hardening, each specified in SIGNALING_SERVER_BOUNDS.md:

- the inbound frame cap and the bounded JSON parse;
- the handshake parameter length cap;
- the hold queues' count, byte and per-sender destination caps, and the bound on bytes buffered toward one socket;
- the short reap window for a registration that never speaks;
- the bounded release of a refused or unanswered socket, and the upgrade listener that runs first;
- the rate-limited diagnostics sink the caller supplies.

## What a first-party broker would be

### What it must do

The stock client and the compatibility rule fix the wire, so a first-party broker implements the same protocol, part for part:

- the upgrade at `<mount>/peerjs`, the three query parameters with their length bounds, and the key check;
- registration answered `OPEN`, a new socket with the same id and token taking over the registration, and `ID-TAKEN` otherwise;
- `src` stamping, the five relayed message types, and liveness from any inbound frame against the two reap windows;
- the hold for an absent destination and its `EXPIRE` within the roughly 5 seconds both clients' redial logic is tuned to;
- every bound in SIGNALING_SERVER_BOUNDS.md, the bounded socket release, and the diagnostics sink.

That is the component list of the tree as it is.

### What it would drop

- The 120 unread lines above, every one of them deletable in place.
- Upstream's indirection: the handler registry and the closures wrapping it, interfaces with a single implementation, and two timer services where one sweep would do.
  An estimate, not measured: another 100 to 150 lines.
- Upstream's file layout, and the lint exclusion that preserves it.

It would drop nothing on the wire, since nothing on the wire may change.
Nor can a broker of this protocol learn which two parties belong together: PeerJS has no notion of an exchange, and the broker treats each id as an opaque string.
"Two-peer" therefore comes down to a tighter value for a bound that exists already, the eight destinations one sender may hold frames for, not a new structure.

### The migration for deployed clients

A wire-compatible rewrite needs none.
The URL, the mount and the messages stay as they are, and the standing host takes the new code through [the host pull](../../infra/host-pull/README.md).
Invitations and kept exchanges name the URL, which does not change.

A replacement that changed the wire, for instance one built around exchange pairing rather than PeerJS ids, would break every browser party until the web app stopped using the stock PeerJS client, which it relies on for the data channel and its framing as well as for signaling ([DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md#upgrading-the-peerjs-stack-peerjs--peerjs-js-binarypack)).
It would also break every CLI image already released, against [the compatibility policy](../RELEASES.md#compatibility-policy).
That is outside what this decision could take on.

### What the security review gains or loses

A rewrite would give the reviewer:

- one structure written for this job, with the realm, queue and reaper invariants stated once rather than fitted into upstream's shape;
- no unread configuration to rule out.

It would cost the reviewer:

- a review of the whole broker at once, where each hardening change was reviewed as a diff against running code, with the hardest parts rewritten rather than kept: the release window that reads Node's internal `_httpMessage`, the token rule on reconnect, and the queue byte accounting;
- the field time of code that has served the standing deployment since 2026-10-05;
- the 4,074 lines of unit tests, rewritten with it; only the CLI's wire-level integration tests would remain unchanged, as a conformance check.

Deleting the unread code and linting the whole tree gives the reviewer most of the first gain, one reviewable diff at a time against tested code.

## The verdict

**Keep the broker; retire the vendoring.**

A rewrite would reimplement the same protocol out of the same components, because the stock PeerJS client and the compatibility policy fix the wire, and about half the tree, including every security bound, is already this project's code.
What a rewrite would remove -- 120 unread lines, upstream's indirection, the vendoring rules -- can be removed in place for far less review.

The vendoring itself has no remaining purpose.
Upstream has changed no server behavior since December 2023 and nothing has ever been taken from it, so keeping its file layout traceable and excluding its files from lint protects a merge that will not happen.

### When to reopen

- **The web app stops using the stock PeerJS client.** The wire is then this project's to change, and a broker built around exchange pairing becomes possible.
- **A managed, function-backed endpoint is wanted.** The case against one rests on the broker's in-process state: the realm, the hold queues and the liveness clocks, which require both parties to reach one instance.
  Moving that state into an external store changes the broker's structure, not only its size, and is the point at which a rewrite would be the cheaper path.
  The standing deployment ([webrtc-relay-deployment.md, The recommendation](webrtc-relay-deployment.md#the-recommendation)) does not need it.
- **Upstream ships a server change Alcove needs.**

## Proposed follow-on

All three are built.
The broker's unit tests run in `packages/peerjs-broker/test/`, apart from the two that read the web client's heartbeat cadence, which stay in `apps/web/test/unit/psi/signalingReaping.test.ts`.

1. **Delete the unread upstream code**: the seven `IConfig` fields, `Realm.generateClientId`, the commented-out builder and events interface, the empty `close` listener and `onClose`, the second `defaultConfig` merge, and `@types/cors`.
   About -120 lines, checked by a typecheck across every workspace.
   Sequenced after any open work on `models/realm.ts`.
2. **Retire the vendoring rules**: lint `messageHandler/` and `models/message.ts` like the rest, and correct the package README's provenance paragraph, which states about a third of the tree is this project's.
   The MIT license beside the tree and the package's `Apache-2.0 AND MIT` stay, since the code is still derived from upstream.
   Renaming or flattening `contrib/` is optional, and costs churn in the nine test files and the spec paragraphs that cite its paths.
3. **Give the package its own unit test project**, moving the broker's unit tests out of `apps/web`.
