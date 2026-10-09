---
title: "Peer-Coordination Server Bounds"
---

# Peer-coordination server bounds

This document specifies the bounds the PeerJS-compatible signaling broker (`packages/peerjs-broker`) and the servers that embed it hold against an unauthenticated internet client, with their constant values and enforcement points.
It is the implementation-level complement to the coordination-server paragraph of the **Channel security** overview in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security) and to [Hardening the coordination server](../DEPLOYMENT.md#hardening-the-coordination-server) in DEPLOYMENT.md, which say what each guard covers and which controls are the reverse proxy's.
It does not cover the JSON-decode chokepoint the broker reuses (see [CHANNEL_SECURITY.md](CHANNEL_SECURITY.md)) or the WebRTC data channel the two parties exchange over once the broker has introduced them (see [TRANSPORT_BOUNDS.md](TRANSPORT_BOUNDS.md)), or the signaling envelopes themselves (see [WEBRTC_TRANSPORT.md](WEBRTC_TRANSPORT.md)).
Intended readers are whoever deploys or assesses the broker, security auditors, and implementors.

## Signaling-server inbound frame bound

The decode-layer bound in [Application-layer parsed-input bounds](CHANNEL_SECURITY.md#application-layer-parsed-input-bounds) lives in `@alcove/core` and covers the AEAD application channel and the file-sync transport - a self-limited adversary (the authenticated counterparty, or a hostile server admin).
The PeerJS signaling broker (`packages/peerjs-broker`) is a separate surface with a broader adversary: it runs in production as a public service to broker the WebRTC rendezvous, and its only authentication gate is the well-known default key `peerjs` (the id and token are free strings), so its inbound parse is reachable by ANY unauthenticated internet client.
Its `socket.on("message")` handler in `packages/peerjs-broker/src/contrib/services/webSocketServer/index.ts` decodes each frame as JSON, the same uncatchable-V8-abort class as the core bound - a single wide-enough object or long-enough array drives `JSON.parse` into a process-terminating internal engine limit that no `try`/`catch` can intercept.
Because the broker process is shared by every peer, that abort is an availability loss for all of them, not one self-controlled session; and even short of the crash ceiling, a single oversized frame is independently a memory pin.

The bound has two halves.
The byte half sits at the idiomatic `ws` layer, ahead of the parse: the `ws` `Server` is constructed with an explicit `maxPayload` (`MAX_SIGNALING_PAYLOAD_BYTES` = 262144, i.e. 256 KiB) rather than the 100 MiB `ws` default.
`ws` enforces it in the receiver as each frame's length header is read, refusing an over-cap frame with a 1009 close (`WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`) before the payload is buffered and before the message handler parses it - the error surfaces as a handled `error` event the server already routes, not a crash.
The cap sits far above any legitimate signaling frame: this server brokers only small control messages - the PeerJS OPEN / OFFER / ANSWER / CANDIDATE / HEARTBEAT family, SDP and ICE that are KB-scale - while the PSI payload itself flows peer-to-peer over the WebRTC data channel and never crosses this socket.
It sits far below both the 100 MiB default and the ~109 MB a single 2^23-key object needs to reach the per-object ceiling, so it closes the single-frame crash outright rather than only shrinking the window, and caps each inbound frame against the single-frame memory pin.
Like the file-sync [frame-size cap](TRANSPORT_BOUNDS.md#inbound-frame-size-bound) it is a fixed constant, not a configurable option: a configurable bound risks an operator raising it high enough to reintroduce the DoS.
It would only need revisiting if the signaling protocol began carrying a legitimately large payload through this socket - it does not, and a redesign that routed bulk data through the broker rather than the data channel would be the change to re-evaluate against.
As net-new security behavior on an internet-facing surface, this control is subject to the explicit security review required by [CONTRIBUTING](../../CONTRIBUTING.md#dependency-policy) before release.

The structural half is core's chokepoint: the handler decodes each frame through `parseBoundedJson`, so the per-object key, per-array element and nesting-depth ceilings of [Application-layer parsed-input bounds](CHANNEL_SECURITY.md#application-layer-parsed-input-bounds) bound a signaling frame as they bound a core wire message.
Only those ceilings do.
The handler passes an already-decoded string (`data.toString()`), which takes the chokepoint's string arm, so its byte-arm properties do not apply here: there is no UTF-8-fatal decode, and the structural scan runs on the decoded string rather than ahead of any decode.
A frame whose bytes are not valid UTF-8 is decoded with replacement characters and is then accepted or refused on its structure and syntax, not on its encoding.

Under the 256 KiB byte cap the two halves overlap only in part:

- `MAX_JSON_OBJECT_KEYS` = 65536 is out of reach: the smallest body exceeding it is 320 KiB (65537 members of `"":1,`).
- `MAX_JSON_ARRAY_ELEMENTS` = 2^24 is out of reach: the smallest body exceeding it is about 32 MiB (16777218 elements of `1,`, that is 2^24 + 2 - the scan counts an array's elements by its separating commas, so 2^24 + 1 elements do not reach it).
- `MAX_JSON_NESTING_DEPTH` = 4096 is exceeded in 8194 bytes (4097 nested `[` and their closers), so the depth ceiling is what the structural half adds over the byte cap today.

The structural half is where the bound belongs regardless of that arithmetic: it holds whatever the byte cap is later set to, and it puts the broker inside the same ESLint ban on a raw `JSON.parse` that `packages/core/src` and `apps/web/src` sit inside (`eslint.config.mjs`, and for the web app `apps/web/eslint.config.js`), so a parse added to this server later is bounded by default rather than by being noticed.
Two vendored paths sit outside that ban, exempted by the repo-wide lint ignores so their history against upstream stays readable: `packages/peerjs-broker/src/contrib/messageHandler/` and `packages/peerjs-broker/src/contrib/models/message.ts`.
They are pinned instead by a check that scans them for a parse call in any shape the ban refuses and fails if one appears (`scripts/eslint-broker-parse-bans.test.mjs`).
A structural refusal throws `JsonStructureBoundError`, whose message holds no input bytes, and the handler routes it to the `client-frame` diagnostic with every other parse failure.
The relay's reconnect queue reconstitutes a held payload through the same chokepoint (`packages/peerjs-broker/src/contrib/models/messageQueue.ts`), so the delivery leg is bounded as well as the receive leg.

## Web signaling surface bounds

The bounds in [TRANSPORT_BOUNDS.md](TRANSPORT_BOUNDS.md) and [TRANSPORT_LIVENESS.md](TRANSPORT_LIVENESS.md) harden the CLI's file-sync transport against a hostile server admin.
The PeerJS-compatible signaling broker (`packages/peerjs-broker`) is a separate surface with a different model: it is untrusted by design (see the **Channel security** and **Third parties** overviews in [SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security)), relaying only opaque rendezvous-setup messages between two browsers that authenticate each other directly.
So the residual exposure on its WebSocket upgrade surface is resource exhaustion, not access to any party's data.
The guards below are defense-in-depth against that nuisance, enforced in the application unconditionally; the deployment-dependent Origin and per-address controls are the reverse proxy's responsibility and are described operationally in [DEPLOYMENT.md](../DEPLOYMENT.md#hardening-the-coordination-server), not here.
All values are fixed constants, not configurable, for the same reason as the file-sync bounds: a configurable bound risks an operator raising it enough to reintroduce the denial of service.

The browser peer on the other side of that socket bounds what it accepts from this relay by its own two measures, stated in [WEBRTC_TRANSPORT.md](WEBRTC_TRANSPORT.md#budgets).

**Upgrade-handshake timeout.**
The console server bounds a pre-101 upgrade handshake with a **10-second** header timeout (`SIGNALING_HEADERS_TIMEOUT_MS`) and a **15-second** request timeout (`SIGNALING_REQUEST_TIMEOUT_MS`), applied in `apps/web/server/upgradeHardening.ts` from the broker package's constants (`packages/peerjs-broker/src/standaloneUpgradeBounds.ts`).
A client that opens a connection and dribbles -- or never finishes -- its request headers is closed server-side rather than held open.
The entry attaches its own `clientError` handler to perform the close rather than relying on Node's built-in default close-on-`clientError`, because that default is silently disabled the moment any other `clientError` listener is attached (an embedding framework, or under test a loaded `ws`, may attach one).
Node checks the header and request timeouts on a periodic sweep (default 30 seconds, unverified against the pinned Node as of 2026-09-29), so the effective close is the bound plus up to one sweep interval -- coarse, which is sufficient for a resource-exhaustion guard.
A server with the job API enabled (the console build) takes a whole-request bound sized to the job API's largest upload instead, `JOB_API_REQUEST_TIMEOUT_MS` in `apps/web/src/jobs/routeSupport.ts`: the time `MAX_JOB_BODY_BYTES` (424 MiB) takes to arrive at 1 MiB/s, 424 seconds.
Node applies the request timeout to the whole server, and a job-create or config upload over a slow link would otherwise be cut with a `408`; the console is reached only from the operator's own machine, so the longer bound is not exposure a public server takes on.

Those two timeouts only arm once HTTP request parsing has begun, so they do not cover the cheapest hold of all: a peer that completes the TCP handshake and then sends nothing, which has no request for them to bound and would otherwise sit until the OS reaps the idle socket.
A **10-second** per-socket idle timeout (`SIGNALING_PREHANDSHAKE_IDLE_MS`, applied on each new connection) closes that case, on its own precise timer rather than the periodic sweep.

The standalone broker runner (`packages/peerjs-broker/src/standalone.ts`) applies the same three bounds to the server it owns, from the same constants in `standaloneUpgradeBounds.ts`, which the console server imports so the values have one home.
It terminates no TLS, so the TLS handoff below has no counterpart there.

All three bounds cover the window in which the socket still owes the server a request.
Arrival is the whole request, not its headers: a client that completes its headers, announces a body and then sends none of it still owes the server bytes, and stays under the idle bound rather than falling through to `requestTimeout` on the periodic sweep.
What arrives decides what governs the socket next.
An upgrade request is released outright by `ws`, which resets the socket timeout to `0` the instant a socket completes the 101, handing the established WebSocket to the `ws` close timer and the liveness reaper below.
An ordinary request is weighed by the reap itself: a `request` hook the harden installs records the request the socket is delivering, and when the idle timer next fires the reap destroys the socket unless that request's `complete` flag says the whole of it is in hand -- a request wholly in hand lets that window pass, and every window after it.
Node destroys a timed-out server socket itself unless the request, the response, or the server has a `timeout` listener, so the same hook attaches a placeholder listener to the response, which is what leaves the decision with the reap for as long as a response is in flight.
That listener is scoped to the response rather than to the server: Node's own keep-alive reaping of a finished, idle connection acts once the response is done and must not be suppressed along with it (a unit check pins that it still fires).
No matching hook is installed on `upgrade`: the signaling server decides whether to release an unhandled upgrade at once by testing that it is the sole `upgrade` listener, which a second listener here would silently flip into the co-resident path below (a unit check pins that the harden adds none).
Both paths act on the socket object the HTTP layer hands them, which under TLS -- a shape `hardenUpgradeSurface` accepts, though the console server itself serves plain HTTP -- is the `TLSSocket` wrapping the accepted connection rather than that connection itself.
So a bound left on the wrapped socket would be reached by neither while Node's own timer refresh keeps it armed through the wrapper's traffic: that is a live connection reaped mid-response or mid-exchange.
The harden therefore hands the bound from the accepted socket to the `TLSSocket` on `secureConnection`, which leaves the accepted socket holding it only for the window before a handshake completes -- the one window no `TLSSocket` exists to hold.
HTTPS tests pin both halves: a slow response and an established WebSocket outlive the bound, while a connection that opens and never starts its handshake is still reaped.
Until the request is in hand the idle timer is what it says -- a peer that dribbles actual request bytes resets it with each byte and, having delivered no request, remains under it as well as under the header and request timeouts above, whose deadlines are absolute from the start of the request.
This guard would need revisiting only if a real client could legitimately take longer than the bound to send its upgrade request, which a single small WebSocket handshake never does, or if `ws` stopped resetting the socket timeout on upgrade.
A regression test pins that an established connection outlives the bound, and further tests pin that a slow response, a quiet streaming response and a response whose request body was delivered but never read outlive it too, while a client that stalls the body it announced is still reaped on the bound's own clock.

**Limits of the upgrade-handshake bounds.**
All three stop at the moment a request is in hand, and the response phase is outside them by design.
Nothing here measures whether -- or how fast -- a client takes the response it asked for, so a peer that stops reading holds the connection and the bytes queued for it until the deployment closes them.
Node's own timeouts cover what they name, receiving a request and an idle connection between requests.
Draining a response belongs to the reverse proxy in front of the application, which buffers a response away from it and applies its own send and read timeouts to a stalled reader (see [DEPLOYMENT.md](../DEPLOYMENT.md#hardening-the-coordination-server) for the operator's side of that split, including what a directly-exposed deployment does not get).
The scoping is what keeps a legitimate response safe: a handler that takes its time, a long-lived response such as the console's job event stream quiet between frames, and a client draining a large body slowly are the shapes an in-application response bound cuts first.
Unit checks pin a withheld response, a quiet event stream, and a response whose request body arrived but went unread each outliving the bound, with an HTTPS check pinning the withheld response over TLS as well.
The bound is also armed once per connection, when it is accepted and again on the TLS handoff above, and the reap never puts it back.
Once a response finishes Node replaces the socket timeout with its own `keepAliveTimeout` (measured on Node 26 as that value plus 1,000 ms of grace), and when the next request on that connection begins Node resets it to `server.timeout`, which is `0` here.
So `SIGNALING_PREHANDSHAKE_IDLE_MS` and its precise clock cover the first request on a connection, the keep-alive timeout covers the idle gap between requests, and a later request on a reused connection is covered by the header and request timeouts on the periodic sweep -- coarser than the idle bound's own clock, and the coverage that pair gives on its own.
A unit check pins that the harden leaves no bound of its own on a socket Node's keep-alive reaping has taken, and another that a connection handling request after request accumulates no per-request `timeout` listener.

**Per-message size cap.**
Each inbound frame is capped at the `ws` layer so an over-cap frame is refused (close code 1009) before the message handler parses it.
This control and its constant (`MAX_SIGNALING_PAYLOAD_BYTES`, in the vendored `services/webSocketServer/index.ts`) are specified above under [Signaling-server inbound frame bound](#signaling-server-inbound-frame-bound), alongside the file-sync frame-size bound; it is one of this surface's bounds, closing the single-oversized-frame crash and memory pin from an unauthenticated peer.

**Structural parse bound.**
Within that byte cap, each frame is decoded through `@alcove/core`'s `parseBoundedJson`, which refuses a body whose structure exceeds the per-object key, per-array element or nesting-depth ceiling before `JSON.parse` sees it.
The relay's reconnect queue reconstitutes a held payload through the same chokepoint.
Specified above under [Signaling-server inbound frame bound](#signaling-server-inbound-frame-bound), which states which of the three ceilings a within-cap frame can reach.

**Two-tier liveness reaping.**
A registered client that has not yet sent any inbound frame is reaped after **20 seconds** (`unconfirmed_timeout` in the vendored `config/index.ts`); once it sends its first frame it is marked confirmed and governed by the **90-second** `alive_timeout`, refreshed by each heartbeat.
The split ties reaping to liveness rather than a flat wall-clock: a socket that registers under the public realm key and then goes silent -- an abandoned or junk registration -- is cleared in 20 seconds instead of squatting a slot for 90, while a real peer is never cut short however slow the human-paced exchange.
The reap is keyed on the WebSocket heartbeat, which is independent of and far faster than WebRTC pairing: the PeerJS client sends its first heartbeat one cadence interval after the socket opens and then every interval, so even an inviter that waits minutes for its partner has long since graduated to the generous window.
The cadence is alcove-owned, not a transitive dependency default: the web client sets `pingInterval` explicitly to **5 seconds** (`PEER_PING_INTERVAL_MS` in `apps/web/src/psi/transport/rendezvous.ts`) rather than relying on the `peerjs` default, a default parameter inside a bundled file that an upstream version change could shift (an exact-pinned, review-gated `peerjs` bump rather than a silent caret drift -- see [DEPENDENCY_PINS.md](DEPENDENCY_PINS.md#upgrading-the-peerjs-stack-peerjs--peerjs-js-binarypack)).
The 20-second value is four times that 5-second first-heartbeat cadence, leaving margin for a slow socket open and one missed heartbeat.
The unconfirmed window must stay comfortably above the first-heartbeat delay so a real peer always graduates before it fires; that `unconfirmed_timeout >= 4x PEER_PING_INTERVAL_MS` relationship is pinned by a unit check (`apps/web/test/unit/psi/signalingReaping.test.ts`), so a change to either value -- the reap window or the cadence -- that narrows the margin fails CI rather than only the weaker `unconfirmed_timeout < alive_timeout` invariant.
Because the cadence is set explicitly, a `peerjs` minor bump cannot shift it out from under the window; tracking a future upstream default change is a deliberate edit to `PEER_PING_INTERVAL_MS`, which the same check then re-validates against the window.
The check guards the numeric margin but not the *meaning* of the cadence.
As with the SFTP-stack internal assumptions, a `peerjs` bump must still re-confirm two behavioral assumptions this control rests on: that `pingInterval` remains the sole client-originated liveness signal (the reaper keys only on observed inbound frames, and on an otherwise-idle registered peer the heartbeat is what produces them).
A field rename instead is reported as a TypeScript error on the `PeerOptions` literal.
It must also confirm that no upstream WebSocket-layer keepalive was introduced that would hold a socket open independently of that heartbeat -- either change would decouple liveness from the cadence the window is sized against, which neither the type check nor the margin check would catch.
The check runs on the existing 300 ms sweep (`checkBrokenConnections`), so the effective reap is within ~20.3 seconds.
This bounds the cheap fire-and-forget / register-and-idle flood; a flood that keeps each socket alive with heartbeats is bounded instead at the reverse proxy (per-address limiting, see [DEPLOYMENT.md](../DEPLOYMENT.md#hardening-the-coordination-server)), since the application cannot distinguish it from a live peer.
The only in-application ceiling on such a maintained flood is the global `concurrent_limit` (default 5,000 registered clients), which is shared across all clients, so on a deployment with no proxy a maintained flood degrades to global connection exhaustion rather than per-address throttling -- the reason per-address limiting is delegated to the proxy rather than attempted here.

**One socket per registered client.**
Registration is keyed on the `id` and `token` an upgrade holds, so a peer that upgrades again under credentials already in the realm attaches to the client that is already there rather than taking a second slot.
That attach detaches whatever socket the client was holding, and every in-application close path -- the liveness reaper above, and the per-socket `close` handler that deregisters the client -- acts on the socket the client currently points at, so the attach is where a detached socket's teardown belongs and is where `services/webSocketServer/index.ts` performs it.
It terminates rather than closes: a close handshake releases the socket once the peer answers the close frame or, for a peer that never answers, once `ws` gives up on its own close timer -- measured at 30 seconds of retained socket per detach on the pinned `ws`.
The detached socket is being replaced by that same peer's newer one and so has nothing to negotiate.
The invariant is that no registered client retains more than one socket, so the sockets this surface holds on behalf of registered clients are bounded by the `concurrent_limit` the realm enforces rather than by how many times a peer chooses to attach.
Two unit checks pin it (`test/unit/signalingServer.test.ts`): repeated attaches under one id and token leave the live socket set at one and the registration intact -- the registration belongs to the client rather than to any one socket, so a detached socket's close leaves it alone.
A detached socket is no longer relayed as its client, the server stamping every relayed frame with the client's id.

**No socket outlives its registration.**
Every path that removes a client's registration also ends its socket, so the realm's count, and `concurrent_limit` with it, covers every socket held for a client:

- A client that sends `LEAVE` with no destination has its socket terminated as its registration is removed.
- The liveness reaper and the relay send-buffer bound below terminate the socket of the client they remove rather than closing it.
  A peer past its liveness window, or no longer reading, will not answer a close frame, and terminating releases its socket at once rather than when the `ws` close timer expires.
- A socket's `close` removes a registration only while the realm still maps that id to the socket's own client (`removeClient`, in the vendored `models/realm.ts`).
  A close that arrives after another client has taken the id leaves that client registered.
- A frame is relayed only from the socket its client holds while the realm holds that client.
  `ws` can still deliver a frame it read off a socket before terminating it, and such a frame is dropped rather than relayed under the id.

Unit checks in `apps/web/test/unit/signalingRelayBounds.test.ts` pin a client leaving with no destination being disconnected with no socket left held, a frame sent behind that `LEAVE` not being relayed, and a reaped peer that answers nothing being released within `SOCKET_RELEASE_TIMEOUT_MS`.
One in `apps/web/test/unit/signalingServer.test.ts` pins a late close leaving a newer registration of the same id in place.

**Bounded release of a refused or unanswered socket.**
Every other exit that leaves this server holding a socket it will not go on to serve releases it within **1 second** of the point that socket becomes nobody's (`SOCKET_RELEASE_TIMEOUT_MS`, in the vendored `services/webSocketServer/index.ts`) -- a bound on the window the exit opens, not on the connection that brought the peer there.
That point is the exit itself, unless the exit leaves a response of this server's still being written on the socket -- the pipelined upgrade covered below -- where it is instead the moment that response detaches.
Two shapes reach that bound.
The first is a refusal -- a missing or over-length handshake parameter, a wrong realm key, an id claimed under another token, or a registration past `concurrent_limit`.
Each writes the peer the frame that tells it why it was refused (the `ERROR` payload naming the refusal, or `ID-TAKEN`) and then closes, so a peer that answers the close frame is released on the handshake; the bound is the deadline on that handshake, past which the socket is terminated.
A refused peer is precisely the one with nothing to negotiate and no reason to answer, and without the deadline its socket is held for the `ws` close timer -- the same 30 seconds measured for the detach above -- so an unauthenticated peer that opens refusals and answers nothing occupies each socket 30x longer than the refusal itself takes.
One second sits far above the round trip an answering peer needs, having already been written its error frame.
The second shape is an upgrade on a path that is not this server's, which it declines so that a co-resident `upgrade` listener -- Vite's HMR handler at `/` on the shared dev server -- can answer it.
Node stops auto-destroying an unhandled upgrade once any `upgrade` listener exists, so a declined socket nobody answers is leaked, and the deployment connection idle-timeout is at best a far coarser safety check.
Where this server is the sole `upgrade` listener -- the production shape, which the harden above keeps sole by adding no listener of its own -- nothing else can answer and the socket is destroyed at once.
Where a co-resident listener exists the socket is left for it and the assumption that it answers is then tested rather than assumed, against what the window itself produced.
The socket's written-byte count is snapshotted as the upgrade is declined, and a socket that has written nothing past that snapshot when the bound expires was answered by nobody, so it is destroyed and the broken assumption raised as a server `error`.
The snapshot has to precede any co-resident answer, so this server's `upgrade` listener is prepended, which places it ahead of every listener added with `on`, registered before or after it: on the dev server Vite's HMR listener is attached first and answers in the same emit, and a snapshot taken behind it would read that answer as none and cut HMR at the bound.
A listener another module prepends later would still run ahead of it; no shipped embedding does, and the checks cover the earlier `on` registration.
That counter runs for the life of the TCP connection rather than the window, and this server writes on that connection itself, so two sequences reach the window with the count already holding bytes of this server's own.
An upgrade arrives on a connection it has already answered an ordinary request on -- HTTP keep-alive, which any raw client can drive -- so the count is non-zero before the window opens.
An upgrade pipelined behind a request in a single write reaches the decline while the response ahead of it is still being written, because Node emits `upgrade` as soon as its parser sees one rather than when the response ahead of it finishes.
So the count goes on rising by this server's own bytes for as long as that response runs.
Reading either as this upgrade's answer would leave precisely that socket held past the bound with the window's error watch taken off it, which is at once the leak this release exists to close and an unwatched socket for the peer to reset the process out from under.
The answer is therefore measured as movement past the count the socket holds once no answer of this server's is being written on it.
The count is snapshotted at the decline and snapshotted again if a response of this server's detaches after it, and the bound does not start while one is in flight -- a socket this server is still writing to is its own rather than nobody's, and the decline cannot leak it.
Discounting that whole stretch costs an adopter nothing it could have used, an answer written into a response still writing being interleaved with it on the one TCP stream.
Whether a response is in flight is asked of Node's HTTP server through the outgoing message it assigns to the socket it is writing on, an internal reference rather than a documented API, so the checks below drive a real server through the whole sequence: a Node that stops setting it fails them rather than quietly restoring the misread.
The bound is far above the same-tick answer a real co-resident listener gives, so a socket one has adopted is never taken back from it -- cutting an adopted socket is the HMR teardown the `noServer` wiring exists to avoid.
That window is equally the one stretch in which the socket is nobody's -- declined by this server, not yet adopted by any listener, and so having no `error` listener of anyone's.
A raw socket that emits `error` with none attached terminates the process, which a peer causes by no more than resetting the connection: being killed, or dropped by its network.
It is therefore watched from the decline to the bound.
An error in that stretch destroys the socket, which is that socket's release, so the bound behind it has nothing left to reclaim and reports no unanswered upgrade against a peer that merely hung up.
The watch runs to the bound rather than to an adopter's answer, so an adopted socket that errors in the residual stretch between the two -- most of a second, an adopter answering in the same tick as the decline -- is destroyed and reported by this server rather than left to the listener that adopted it.
Both reports -- the unanswered upgrade, and an error the watch catches -- are raised on this server's own `error` event, each naming the path that raised it as a second event argument.
The single instance builder every entry point goes through (`CreateInstanceWSOnly`, which the standalone broker runner reaches) attaches the sink that attributes, escapes, caps and rate limits them, and writes each one to the diagnostic sink that builder was handed.
Where the lines go is the embedding's -- the runner writes them to stderr -- but whether they are written is not: the sink is a required argument of that builder rather than an option, so an embedding that names none does not typecheck, and the shipped wiring passes one with no flag in front of it.
Attaching a listener is critical before the sink is, an `error` emitted with no listener at all being thrown rather than dropped -- which would end the process over the very peer hang-up the watch exists to survive.
So the listener absorbs the event whatever the sink does with it, a sink that throws being caught there rather than allowed back out through `emit`.
The attribution is what makes the line readable rather than merely present: an unanswered upgrade, an error the release window caught, an error on a socket this server serves, a frame that did not parse, a fault raised dispatching one that did, and a fault the `ws` server itself raised all reach the sink as the same `Error` otherwise.
A raise naming none of the six is written under an unattributed arm rather than dropped -- `emit` is untyped, so what arrives as the source is whatever the raise passed, and a source of another type, or a string naming none of the six, is a diagnostic to read rather than a reason to lose one.
The source is resolved to one of this module's own tags before it is written, so no byte a raise chose reaches the line at all.
The parse and the dispatch behind it are separate attributions because only the first is the peer's.
The `try` that reports a client frame covers reading the peer's bytes and nothing further -- the `parseBoundedJson` parse, and the stamping of the sending client's id onto its result, which throws on a frame that parsed to a null or a primitive -- while a fault raised once that frame is handed to this server's own `message` listeners is this server's.
That second one is reachable rather than theoretical, the relay sizing a frame it holds for an absent destination and throwing on a non-string field, and it is absorbed exactly as the first is -- `ws` calls the message handler from inside its own receiver, where a throw is an uncaught exception and the end of an internet-facing broker.
But it is reported as its own attribution, since read as a parse failure it sends an operator looking for a peer sending garbage instead of at the fault.
The unanswered-upgrade report can arise only where a co-resident `upgrade` listener sits beside this server, which is the shared dev server and any future embedding that mounts the broker alongside another WebSocket route.
That same event holds peer-controlled text, which is why the sink escapes and rate limits rather than writing what it is handed.
The frame parser quotes the bytes it choked on, so a registered client chooses part of that line: it is escaped where the line is written (`redactAndSanitizeForDisplay`, at **256** characters), which is the one altitude that escapes.
It is placed last, so no byte of it can be read as a field ahead of it or open a line of its own.
A client can also loop that failure, so the sink writes at most **10** diagnostics per **60-second** window; the eleventh is shed under a single notice saying so, and the number shed is written with the first diagnostic of the following window, which holds the sink to 12 lines a window without letting a flood pass as quiet.
That budget is one budget across the attributions rather than a reservation per attribution, so a client looping parse failures spends the whole of it on `client-frame` and leaves an unanswered upgrade raised in the same window shed.
Both notices therefore hold the shed counts by source -- the class the budget ran out on where the shedding starts, the window's whole breakdown where it resumes -- so an alarm a flood starved is named once a later diagnostic writes the resumed notice.
A flood that stops and is followed by nothing leaves the starved classes unnamed as well as uncounted, since the resumed notice is the line that holds the breakdown.
The window is read off the clock as a diagnostic arrives rather than held open by a timer, so the sink adds no handle to a broker that sits idle between rendezvous; a clock stepped backwards holds the window open until the clock has caught back up, which sheds for longer rather than handing a flood a fresh budget.
Every handle the window installs comes off with the window, whichever way it ends: the watch and the close handler that retires it come off at the bound -- where the window concludes the socket was adopted, rather than at the earlier moment the adopter answered.
So past the bound an adopted socket holds that listener's bookkeeping and none of this server's.
The deadline itself is armed as a handle disposed of exactly once -- expiring or cancelled, never both -- so no release path retires a timer another already retired.
Unit checks pin every refusal path, both co-resident outcomes with the co-resident listener registered after this server and before it, a declined upgrade on a connection the server had already answered an ordinary request on, one pipelined behind a response the server was still writing, a peer resetting inside the window, and a peer resetting in the residual stretch, once an adopter has answered and before the bound (`test/unit/signalingServer.test.ts`).
Each drives a hand-rolled socket that answers nothing at all, so what they measure is the server's own release rather than a `ws` client's cooperation.
A further check counts the socket's listeners across a hand-off: past the bound an adopted socket holds the adopter's own and nothing the window added.
The sink behind those reports is pinned separately (`test/unit/signalingDiagnosticsSink.test.ts`): a real unanswered upgrade and a real reset inside the window arrive through `CreatePeerServerWSOnly` under their two attributions and not each other's, and a peer's frame reaches the log with its ESC and CR/LF escaped and its forged context trailing the first-party fields.
It also pins that a `message` listener that throws on a frame that parsed is reported apart from the parse while a malformed frame from the same client is still the peer's, and that a thousand-report flood raised alongside two released sockets is shed to the budget with its shed counts written per source on the following window.
It pins that a clock stepped a whole window backwards goes on shedding until it has caught back up, and that a raise having a source of another type is written under the unattributed arm on the budget slot it spent rather than dropped.
It also pins that one having a hostile string source is written with no control byte and none of that source's own bytes on the line.
It pins that a single detail of 100,000 escape-expanding code points is written truncated rather than at six times its own length, and that the listener still absorbs the event under a sink that throws.
That the diagnostics reach stderr alone, leaving the standalone runner's stdout ready-line protocol clean, is held beside the CLI's broker-process harness (`apps/cli/test/signaling/brokerProcess.ts`) rather than in the web unit suite, where vitest intercepts `console` above the streams and an assertion would be vacuous.
The harness watches the spawned runner's stdout for the child's whole life rather than up to the ready line, since a diagnostic arrives only once a peer has given the broker something to report.
Anything on that stream which is not the one `alcove-broker <port>` line -- or a leading part of it a chunk boundary split -- fails the start, and fails the suite on the harness's stop if it arrived after it.
What keeps that from passing on a broker that logged nothing at all is a check in the CLI's broker suite (`apps/cli/test/integration/webrtc/broker.test.ts`) that has a registered peer raise a real parse failure first, then reads it off stderr with stdout still holding its one line.

**Relay send-buffer bound.**
A frame relayed to a registered destination is written to that destination's socket, where it waits until the peer reads it.
The relay bounds what may wait there.
Before each send it reads the socket's `bufferedAmount`, and when that already exceeds **1 MiB** (`MAX_RELAY_BUFFERED_BYTES`, in the vendored `messageHandler/handlers/transmission/index.ts`) it does not send.
It terminates the destination's socket instead, removes that destination's registration, and answers the sender with a `LEAVE` from the destination -- the answer a destination with no socket also produces.
Terminating rather than closing releases the socket at once, since a peer that is not reading will not answer a close frame either.

The bound is on bytes waiting, not bytes relayed: a recipient is terminated only when its send buffer already holds more than the bound as a frame arrives for it, so a recipient that reads as fast as frames arrive receives a steady stream of any length.
A sender that bursts frames faster than the recipient drains them can fill that buffer and have the recipient disconnected, even one that is reading.
Because the check reads the buffer before the frame is added, a socket holds at most the bound plus one relayed frame.
A relayed frame is the server's re-serialization of what it parsed, which can be larger than the frame on the wire.
A frame is at most `MAX_SIGNALING_PAYLOAD_BYTES` (256 KiB) on the wire, within which `parseBoundedJson`'s structural bounds admit any shape.
Re-serialization grows it by at most 4.4 times: a number reprints in its shortest round-trip form, which for `1e20` is its 21 digits, so `1e20,` becomes 22 bytes; a string byte grows at most threefold (an invalid UTF-8 byte of a binary frame becomes a three-byte U+FFFD).
With the stamped `src` of at most 256 escaped code units, one relayed frame is under **1.11 MiB**, and a socket's buffer under **2.11 MiB**.
Unit checks in `apps/web/test/unit/signalingRelayBounds.test.ts` pin four cases: a destination that stops reading is dropped with its socket's buffer no more than one frame past the bound, and its socket is released; a reader receives three times the bound in total and stays connected; and a frame that decoding triples, and a maximal frame of `1e20` values that relays at more than the bound, each reach an idle recipient that stays connected.

**Relay queue bounds.**
When a client addresses a signaling message to a destination id that is not currently registered, the relay holds it briefly in a per-destination queue for a reconnect.
Left unbounded, a registered client could spray messages to arbitrarily many made-up destination ids -- each allocating a queue -- or grow one queue without limit.
The realm caps the number of distinct queued destinations at **1,000** (`MAX_OUTSTANDING_QUEUES`), the number of those any one sender holds frames for at **8** (`MAX_QUEUED_DESTINATIONS_PER_SENDER`), and the depth of any one queue at **100** messages (`MAX_MESSAGES_PER_QUEUE`), all in `models/realm.ts`.
The per-sender budget holds each sender to a small share of the shared cap; a destination stops counting against its senders when its queue is drained or expires.
A client removed from the realm -- by `LEAVE`, socket close, the liveness reaper, or the send-buffer bound -- has every frame it holds in a queue dropped and its budget cleared, so nothing is relayed under its id afterwards and a later client registering that id starts with the full budget.
All three sit far above any legitimate rendezvous, which queues at most a handful of frames for the one partner it is waiting for.

A frame past any queue bound -- these three or the byte cap below -- is not held, and the relay answers its sender at once with the `EXPIRE` the expiry sweep would otherwise have sent, so a dialer learns the destination is unavailable without waiting out the hold.
Unit checks pin the per-sender budget and each refusal against the realm (`apps/web/test/unit/psi/signalingReaping.test.ts`), and over real sockets the immediate `EXPIRE` for a frame refused by the per-sender budget and by the shared cap, with another sender's hold left in place, and a client that leaves having its held frames dropped and its budget cleared for the next client on its id (`apps/web/test/unit/signalingRelayBounds.test.ts`).

The message-count cap alone, though, leaves a queue's resident ceiling high: a frame is capped at 256 KiB on the wire (`MAX_SIGNALING_PAYLOAD_BYTES`), but V8 stores a JavaScript string as two bytes per character whenever it holds any non-Latin1 character (>= U+0100).
So one buffered frame can occupy roughly **512 KiB** of heap -- about **50 MiB** per queue (100 frames), **50 GiB** across the full 1,000 -- since a flood of max-size frames is bounded only in count, not bytes.
A third bound, **524,288 bytes** (512 KiB, `MAX_QUEUE_BYTES` in `models/realm.ts`), caps each queue's total buffered bytes directly: before a frame is queued, its resident size is added to the queue's running total, and the frame is dropped if that would exceed the cap.
The size is measured as UTF-16 code units times two, not UTF-8 -- a UTF-8 measure would undercount a non-Latin1 payload by up to 2x and let it occupy roughly twice its measured size, so counting the worst-case two-byte residency bounds the real heap regardless of payload charset.
This holds the per-queue ceiling at 512 KiB and the global ceiling at about **512 MiB** (1,000 queues x `MAX_QUEUE_BYTES`).
The cap is twice the wire frame cap, which holds a frame whose payload arrived as a string exactly up to a 33-character `src`: it is held exactly as it arrived.
So its accounted residency is at most twice its wire size only within that bound, and the largest wire-legal one between two 32-character rendezvous ids accounts to 524,286 bytes, two under the cap.
`src` is stamped after the wire cap is checked, so a longer legitimate id pushes the same frame over -- 6 bytes over with a 36-character UUID `src`, 446 over with a 256-character one -- and it is dropped, benignly costing only that sender's own reconnect hold.
A structured payload is held by its serialized form instead, whose length the wire cap does not bound, so holdability there is not exact: re-serializing what a peer sent can inflate it (an array of `1e21` literals re-serializes about 1.2x, since each is reprinted as `1e+21`, so accounted bytes can reach roughly 2.4x the wire bytes).
Even the maximal 262,144-byte wire-legal object frame between two 32-character rendezvous ids accounts to 524,290 bytes against the 524,288-byte cap and is dropped.
That is a stated limit at the size extreme rather than a bound on real traffic: real signaling payloads are KB-scale, so a queue still holds dozens, and a drop costs only that sender's own reconnect hold, never the accounting's integrity.
A queue drained by a reconnecting peer releases the read frames' bytes from the running total, so it accepts fresh frames again rather than staying wedged at the cap.
The ~5-second read-cold expiry (the `MessagesExpire` prune) still clears an unread queue regardless, so these caps bound the transient peak within a window rather than a permanent residency.

**Structured payloads.**
Every real signaling payload -- an SDP offer or answer, an ICE candidate -- reaches the relay as a parsed JSON object rather than a string, and a parsed object's heap residency runs a large multiple of the bytes that held it, so a queue holding parsed frames would be bounded by `MAX_QUEUE_BYTES` in name only.
The queue therefore holds each frame in **serialized form**: `serializeFrame` (in `models/messageQueue.ts`) stringifies the payload once, on the way in, and accounts the frame at the UTF-16 residency of the four strings it then holds -- `type`, `src`, `dst`, and the serialized `payload`.
A payload that arrives already a string is the one exception: it is held exactly as it arrived rather than JSON-quoted, because the two quote characters are residency it never held on the wire.
The largest wire-legal frame addressed between two 32-character rendezvous ids accounts to within two bytes of `MAX_QUEUE_BYTES` -- charging it for quotes it did not hold would refuse it and break the holdability property above.
Each held frame records which of the two forms its payload took, and delivery reconstitutes it accordingly.
The accounted bytes are the held bytes, so `MAX_QUEUE_BYTES` bounds the memory a queue actually retains and the per-queue and global ceilings above (512 KiB and about 512 MiB) are the real ones.
That pairing is confirmed rather than trusted: `addMessage` re-measures the frame it is handed and refuses a caller-supplied size the frame does not match, so no enqueue can charge a queue a size other than the residency it goes on to hold.
The relay path passes what `serializeFrame` measured and so agrees by construction; the refusal binds the enqueue call site alone -- `getMessages` returns the live frames array, so an out-of-tree caller that mutates it directly moves residency without charge, a stated limit of the export surface no inbound frame can reach.
Only those four protocol fields are held, so an extra property hung off a peer's frame is neither retained nor uncounted.
The parsed form exists transiently and one frame at a time: at receive, where the wire cap (`MAX_SIGNALING_PAYLOAD_BYTES`) bounds it, and at delivery, where a frame held as JSON text is parsed back before it is relayed -- so a peer draining a hold receives what a directly relayed frame would have contained.
Serializing at the queue boundary changes nothing observable: the direct relay path serializes the frame on its way out regardless, so JSON's coercions reach a held frame exactly as they reach a relayed one.
Two frames never reach the queue at all -- one whose `type`, `src`, or `dst` is not a string (those are ids, and a non-string one would key a queue or poison the running total), and one whose payload has no JSON form and so no residency to account.
Each is refused before it is queued, and the refusal is reported as a `frame-dispatch` diagnostic; the three id fields are checked before the payload is serialized, so a frame refused for one of them never pays a quarter-megabyte serialization first and the refusal names the `dst` the peer chose.
A frame that instead clears the id checks and is only later dropped for the byte cap has already paid that serialization -- measured at about 0.76 ms for a 261 KB frame, roughly +44% atop the receive path's existing parse cost, with no new amplification.
The drain is guarded the same way: reconstituting a held frame is a parse, and a frame whose held text does not parse is dropped down that same diagnostic route while the rest of the hold is still delivered, rather than throwing out of a connection handler `ws` calls with nothing between it and the socket.
Only the `dst` leg of that refusal is reachable from the wire: `dst` rides inside the peer's own frame and is whatever its JSON put there.
The others are defense-in-depth invariants of the enqueue call site rather than paths a peer can drive -- `src` is stamped by the server from the length-capped handshake id, a non-string `type` matches no entry in the handler registry and so never reaches the relay at all, and a payload parsed out of an inbound frame is JSON-serializable by construction.

**Peer-id length cap.**
The per-queue byte cap above sizes a queued frame by its string fields' resident bytes, `src` included -- and the server overwrites `src` with the connecting client's own id (the `message.src = client.getId()` stamp in `services/webSocketServer/index.ts`).
That id arrives as the `id` query parameter of the WebSocket upgrade request and, left to itself, is bounded only incidentally by Node's ~16 KiB HTTP header-size limit on the upgrade URL, not by any application bound.
So a peer that registers a multi-KiB id and then addresses a near-maximum-payload frame to an absent destination produces a single frame whose `src` alone pushes it past `MAX_QUEUE_BYTES`.
The string-payload holdability above rests on a queued frame's residency staying within twice its wire size, and an unbounded `src` breaks that for a frame of any payload kind rather than only at the size extreme.
The same unbounded id is also retained in the realm `clients` map, a standing per-client memory surface (up to the `concurrent_limit` default of 5,000 ids x the incidental ~16 KiB ~= ~80 MiB).
Each upgrade-handshake parameter -- `id`, `token`, and `key` -- is therefore length-bounded to **256 characters** (`MAX_HANDSHAKE_PARAM_LENGTH`, in the vendored `services/webSocketServer/index.ts`) where it is parsed in `_onSocketConnection`, before the id is stored in `clients` or used as `src`; an over-length parameter is refused with the same error-frame-and-close (`WS_PARAMETER_TOO_LONG`) as a missing one.
The cap sits far above any legitimate id -- Alcove's rendezvous ids are 32 hex characters (`deriveRendezvousPeerId`) and a PeerJS default id is a UUID (~36), so 256 is ~7x any real id and refuses no legitimate peer -- and well over an order of magnitude below the incidental header limit (~64x).

The `id` bound is the critical one: it holds the `src` contribution to a queued frame at most `2 x MAX_HANDSHAKE_PARAM_LENGTH` = 512 resident bytes, a negligible fraction of the 512 KiB queue cap, so a real KB-scale frame from any accepted id stays holdable.
(The byte cap's drop of an *adversarial* near-256-KiB frame is unaffected and stays benign: it loses only that peer's own reconnect-hold frame, never desyncing the accounting or amplifying memory.)
`token` and `key` are bounded at the same parse point for a uniform "no handshake parameter is unbounded" invariant: `token` is likewise retained per-client in the `clients` map (the same standing-memory surface the id presents, which the cap cuts to ~5,000 x 512 bytes ~= ~2.5 MiB), while `key` is only compared against the realm key and never stored, bounded for symmetry.
The addressed destination id (`dst`) is left unbounded here, not an overlooked sibling: unlike `src` -- which the server appends after the wire-frame cap is checked -- `dst` rides inside the client's own frame and is therefore already within the 256 KiB wire cap.
Its residency both as a queue-map key and as a counted frame field is already governed by `MAX_OUTSTANDING_QUEUES` and `MAX_QUEUE_BYTES` with the read-cold expiry, so a separate length bound would be redundant.
As net-new security behavior on an internet-facing surface, this control is subject to the explicit security review required by [CONTRIBUTING](../../CONTRIBUTING.md#dependency-policy) before release.
